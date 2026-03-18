"""
Mainspring - Main application

Event-driven task orchestrator for BitCraft data extraction.
Continuously monitors for changes and triggers GitHub Actions workflows.
"""

import asyncio
import logging
import signal
import sys
from pathlib import Path
from typing import Dict, Any
import yaml
import aiohttp

from .core import EventBus, Task, Action, Event, EventType
from .tasks import SchemaMonitorTask, TableSubscriberTask, AssetMonitorTask, WorkflowMonitorTask
from .actions import GitHubDispatchAction, DiscordWebhookAction, RestartTaskAction, LogAction


def _load_config(config_path: str) -> Dict[str, Any]:
    """Load configuration from YAML file"""
    path = Path(config_path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(path, 'r') as f:
        return yaml.safe_load(f)


class Mainspring:
    """
    Main application that orchestrates tasks and actions.
    """

    def __init__(self, config_path: str = "config.yml"):
        self.config = _load_config(config_path)
        self._setup_logging()

        self.event_bus = EventBus()
        self.tasks: Dict[str, Task] = {}
        self.actions: Dict[str, Action] = {}
        self._shutdown_event = asyncio.Event()

        self._logger = logging.getLogger("mainspring")

        # Setup signal handlers
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

    def _signal_handler(self, signum, _):
        """Handle shutdown signals"""
        self._logger.info(f"Received signal {signum}, initiating shutdown...")
        self._shutdown_event.set()

    def _setup_logging(self):
        """Setup logging configuration"""
        log_config = self.config.get("logging", {})
        log_level = log_config.get("level", "INFO")
        root_log_level = log_config.get("root_level", "INFO")
        log_file = log_config.get("file")

        # Configure root logger
        handlers = [logging.StreamHandler(sys.stdout)]

        if log_file:
            handlers.append(logging.FileHandler(log_file))

        logging.basicConfig(
            level=getattr(logging, root_log_level.upper()),
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=handlers
        )
        logging.getLogger("mainspring").setLevel(getattr(logging, log_level.upper()))

    def _create_action(self, action_config: Dict[str, Any], task_name: str) -> Action:
        """Create an action from configuration"""
        action_type = action_config.get("type")
        action_name = action_config.get("name", None)
        action_name = f"{task_name}_{action_type}_{action_name or len(self.actions)}"

        if action_type == "github_dispatch":
            return GitHubDispatchAction(
                name=action_name,
                config=action_config,
                event_bus=self.event_bus,
                github_config=self.config.get("github", {})
            )
        elif action_type == "discord":
            return DiscordWebhookAction(
                name=action_name,
                config=action_config,
                event_bus=self.event_bus,
                discord_config=self.config.get("discord", {})
            )
        elif action_type == "restart_task":
            return RestartTaskAction(
                name=action_name,
                config=action_config,
                event_bus=self.event_bus,
                task_registry=self.tasks
            )
        elif action_type == "log":
            return LogAction(
                name=action_name,
                config=action_config,
                event_bus=self.event_bus
            )
        else:
            raise ValueError(f"Unknown action type: {action_type}")

    def _create_task(self, task_name: str, task_config: Dict[str, Any]) -> Task:
        """Create a task from configuration"""
        stdb_config = self.config.get("spacetimedb", {})
        github_config = self.config.get("github", {})
        discord_config = self.config.get("discord", {})

        task_type = task_config.get("type", task_name)

        if task_type == "schema_monitor":
            task = SchemaMonitorTask(
                name=task_name,
                config=task_config,
                event_bus=self.event_bus,
                stdb_config=stdb_config
            )
        elif task_type == "table_subscriber":
            task = TableSubscriberTask(
                name=task_name,
                config=task_config,
                event_bus=self.event_bus,
                stdb_config=stdb_config
            )
        elif task_type == "asset_monitor":
            task = AssetMonitorTask(
                name=task_name,
                config=task_config,
                event_bus=self.event_bus
            )
        elif task_type == "workflow_monitor":
            task = WorkflowMonitorTask(
                name=task_name,
                config=task_config,
                event_bus=self.event_bus,
                github_config=github_config,
                discord_config=discord_config
            )
        else:
            raise ValueError(f"Unknown task type: {task_type}")

        # Add actions to the task
        for action_config in task_config.get("actions", []):
            action = self._create_action(action_config, task_name)
            task.add_action(action)
            self.actions[action.name] = action

        return task

    def _setup_tasks(self):
        """Setup all tasks from configuration"""
        task_configs = self.config.get("tasks", {})

        for task_name, task_config in task_configs.items():
            if not task_config.get("enabled", True):
                self._logger.info(f"Task {task_name} is disabled, skipping")
                continue

            try:
                task = self._create_task(task_name, task_config)
                self.tasks[task_name] = task
                self._logger.info(f"Created task: {task_name}")
            except Exception as e:
                self._logger.error(f"Failed to create task {task_name}: {e}", exc_info=True)

    def _setup_event_logging(self):
        """Setup event bus logging for debugging"""

        def log_event(event: Event):
            if event.type in (EventType.CHANGE_DETECTED, EventType.ACTION_TRIGGERED):
                self._logger.info(f"[EVENT] {event.type.value}: {event.source}")

        # Subscribe to all event types for logging
        for event_type in EventType:
            self.event_bus.subscribe(event_type, log_event)

    async def _send_discord_notification(self, message: str) -> bool:
        """Send a notification to the global Discord webhook if configured"""
        discord_config = self.config.get("discord", {})
        
        if not discord_config.get("enabled", False):
            return False
        
        webhook_url = discord_config.get("webhook_url")
        if not webhook_url:
            return False
        
        try:
            payload = {"content": message}
            async with aiohttp.ClientSession() as session:
                async with session.post(webhook_url, json=payload) as response:
                    if response.status in (200, 204):
                        self._logger.debug(f"Discord notification sent: {message}")
                        return True
                    else:
                        self._logger.warning(f"Discord notification failed: {response.status}")
                        return False
        except Exception as e:
            self._logger.error(f"Error sending Discord notification: {e}")
            return False

    async def start(self):
        """Start all tasks"""
        self._logger.info("=" * 60)
        self._logger.info("Starting Mainspring")
        self._logger.info("=" * 60)

        self._setup_tasks()
        self._setup_event_logging()

        # Start all tasks
        for task_name, task in self.tasks.items():
            self._logger.info(f"Starting task: {task_name}")
            await task.start()

        self._logger.info(f"All {len(self.tasks)} tasks started")
        self._logger.info("Mainspring is running. Press Ctrl+C to stop.")
        
        # Send startup notification
        await self._send_discord_notification(
            f"**Mainspring Started**\n\n"
            f"Tasks enabled: {', '.join(self.tasks.keys())}\n"
        )

    async def stop(self):
        """Stop all tasks"""
        self._logger.info("Stopping all tasks...")

        # Stop all tasks
        stop_tasks = [task.stop() for task in self.tasks.values()]
        await asyncio.gather(*stop_tasks, return_exceptions=True)

        self._logger.info("All tasks stopped")
        
        # Send shutdown notification
        await self._send_discord_notification(
            f"**Mainspring Stopped**\n\n"
            f"Tasks were: {', '.join(self.tasks.keys())}\n"
        )

    async def run(self):
        """Main run loop"""
        try:
            await self.start()

            # Wait for shutdown signal
            await self._shutdown_event.wait()

        except Exception as e:
            self._logger.error(f"Fatal error: {e}", exc_info=True)
        finally:
            await self.stop()


async def main():
    """Entry point"""
    import argparse

    parser = argparse.ArgumentParser(description="Mainspring - BitCraft data extraction orchestrator")
    parser.add_argument(
        "-c", "--config",
        default="config.yml",
        help="Path to configuration file (default: config.yml)"
    )

    args = parser.parse_args()

    app = Mainspring(config_path=args.config)
    await app.run()


if __name__ == "__main__":
    asyncio.run(main())
