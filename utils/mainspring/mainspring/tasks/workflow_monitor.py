"""
Workflow monitor task for tracking GitHub Actions workflow runs.
"""

import asyncio
from typing import Any, Dict, Optional
import aiohttp

from ..core import Task, EventBus, Event, EventType


class WorkflowMonitorTask(Task):
    """
    Monitors GitHub workflow runs triggered by actions and executes follow-up actions on completion.
    Subscribes to ACTION_COMPLETED events, polls workflow status, and triggers configured actions.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus, 
                 github_config: Dict[str, Any], discord_config: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.github_config = github_config
        self.discord_config = discord_config
        self.poll_interval = config.get("poll_interval", 30)  # Check every 30 seconds
        self.on_complete = config.get("on_complete", {})  # Map of action_name -> follow-up actions
        self._monitored_runs: Dict[str, Dict[str, Any]] = {}  # run_url -> metadata
        self._pending_actions: asyncio.Queue = asyncio.Queue()
    
    async def run(self):
        """Main monitoring loop"""
        self._logger.info(f"Workflow monitor started, polling every {self.poll_interval}s")
        
        # Subscribe to ACTION_COMPLETED events
        # noinspection PyTypeChecker
        self.event_bus.subscribe(EventType.ACTION_COMPLETED, self._handle_action_completed)
        
        # Start polling loop
        while self._running:
            try:
                # Process any new runs to monitor
                while not self._pending_actions.empty():
                    action_info = await self._pending_actions.get()
                    run_url = action_info.get("run_url")
                    if run_url:
                        self._monitored_runs[run_url] = action_info
                        self._logger.info(f"Now monitoring workflow: {run_url}")
                
                # Poll all monitored runs
                if self._monitored_runs:
                    await self._poll_runs()
                
                # Wait before next poll
                await asyncio.sleep(self.poll_interval)
                
            except Exception as e:
                self._logger.error(f"Error in workflow monitor: {e}", exc_info=True)
                await asyncio.sleep(60)
    
    async def _handle_action_completed(self, event: Event):
        """Handle ACTION_COMPLETED events from GitHub dispatch actions"""
        action_name = event.source
        action_data = event.data.get("action_data", {})
        
        # Only monitor GitHub dispatch actions that have run_url
        if "run_url" not in action_data:
            return
        
        # Check if we have follow-up actions configured for this action
        if action_name not in self.on_complete:
            self._logger.debug(f"No follow-up actions configured for {action_name}")
            return
        
        # Queue this run for monitoring
        run_info = {
            "action_name": action_name,
            "run_url": action_data["run_url"],
            "workflow": action_data.get("workflow"),
            "follow_up_actions": self.on_complete[action_name]
        }
        
        await self._pending_actions.put(run_info)
        self._logger.info(f"Queued workflow for monitoring: {action_name}")
    
    async def _poll_runs(self):
        """Poll all monitored workflow runs and trigger follow-ups on completion"""
        completed_runs = []
        
        for run_url, run_info in self._monitored_runs.items():
            try:
                # run_url is already the full API URL for the run
                headers = {
                    "Authorization": f"Bearer {self.github_config.get('token')}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2026-03-10"
                }
                
                async with aiohttp.ClientSession() as session:
                    async with session.get(run_url, headers=headers) as response:
                        if response.status != 200:
                            self._logger.warning(f"Failed to fetch run status: {response.status}")
                            continue
                        
                        run_data = await response.json()
                        status = run_data.get("status")
                        conclusion = run_data.get("conclusion")
                        run_id = run_data.get("id")
                        
                        self._logger.debug(f"Run {run_id}: status={status}, conclusion={conclusion}")
                        
                        # Check if workflow completed
                        if status == "completed":
                            if conclusion == "success":
                                self._logger.info(f"Workflow {run_info['action_name']} completed successfully!")
                                
                                # Trigger follow-up actions
                                follow_up_actions = run_info["follow_up_actions"]
                                context = {
                                    "source": f"workflow_monitor",
                                    "trigger_action": run_info["action_name"],
                                    "workflow": run_info["workflow"],
                                    "run_url": run_url,
                                    "run_id": run_id,
                                    "conclusion": conclusion
                                }
                                
                                for action_config in follow_up_actions:
                                    await self._execute_follow_up_action(action_config, context)
                            else:
                                self._logger.warning(f"Workflow {run_info['action_name']} completed with conclusion: {conclusion}")
                            
                            # Mark for removal
                            completed_runs.append(run_url)
                        elif status in ("cancelled", "failure", "timed_out", "action_required", "stale"):
                            self._logger.warning(f"Workflow {run_info['action_name']} ended with status: {status}")
                            completed_runs.append(run_url)
                        # Otherwise still in progress (queued, in_progress, waiting)
                        
            except Exception as e:
                self._logger.error(f"Error polling run {run_url}: {e}", exc_info=True)
        
        # Remove completed runs from monitoring
        for run_url in completed_runs:
            del self._monitored_runs[run_url]
            self._logger.debug(f"Stopped monitoring: {run_url}")
    
    async def _execute_follow_up_action(self, action_config: Dict[str, Any], context: Dict[str, Any]):
        """Execute a follow-up action when workflow completes"""
        action_type = action_config.get("type")
        action_name = action_config.get("name", "0")
        action_name = f"followup_{action_type}_{action_name}"
        
        self._logger.info(f"Executing follow-up action: {action_name}")
        
        # Import here to avoid circular dependency
        from ..actions import GitHubDispatchAction, DiscordWebhookAction
        
        try:
            if action_type == "github_dispatch":
                action = GitHubDispatchAction(
                    name=action_name,
                    config=action_config,
                    event_bus=self.event_bus,
                    github_config=self.github_config
                )
            elif action_type == "discord":
                action = DiscordWebhookAction(
                    name=action_name,
                    config=action_config,
                    event_bus=self.event_bus,
                    discord_config=self.discord_config
                )
            else:
                self._logger.warning(f"Unsupported follow-up action type: {action_type}")
                return
            
            # Trigger the follow-up action like a normal action (publishes events)
            success = await action.trigger(context)
            if success:
                self._logger.info(f"Follow-up action {action_name} completed successfully")
            else:
                self._logger.warning(f"Follow-up action {action_name} failed")
                
        except Exception as e:
            self._logger.error(f"Error executing follow-up action {action_name}: {e}", exc_info=True)
