"""
Mainspring - Event-driven task orchestrator for BitCraft data extraction

This module provides the core abstractions for the mainspring system:
- Task: Abstract base for long-running tasks
- Action: Abstract base for triggered actions
- EventBus: Communication between tasks
- ChangeDetector: Base for detecting changes
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Coroutine
from collections import defaultdict


class EventType(Enum):
    """Types of events that can occur in the system"""
    CHANGE_DETECTED = "change_detected"
    TASK_STARTED = "task_started"
    TASK_STOPPED = "task_stopped"
    TASK_ERROR = "task_error"
    ACTION_TRIGGERED = "action_triggered"
    ACTION_COMPLETED = "action_completed"
    ACTION_FAILED = "action_failed"


@dataclass
class Event:
    """Represents an event in the system"""
    type: EventType
    source: str  # Task or action name that generated the event
    data: Dict[str, Any]
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now()


class EventBus:
    """
    Central event bus for task communication.
    Allows tasks to publish events and subscribe to events from other tasks.
    """

    def __init__(self):
        self._subscribers: Dict[EventType, List[Callable]] = defaultdict(list)
        self._logger = logging.getLogger("mainspring.eventbus")

    def subscribe(self, event_type: EventType, callback: Callable[[Event], None]):
        """Subscribe to an event type"""
        self._subscribers[event_type].append(callback)
        self._logger.debug(f"Subscribed to {event_type.value}")

    def unsubscribe(self, event_type: EventType, callback: Callable[[Event], None]):
        """Unsubscribe from an event type"""
        if callback in self._subscribers[event_type]:
            self._subscribers[event_type].remove(callback)
            self._logger.debug(f"Unsubscribed from {event_type.value}")

    async def publish(self, event: Event):
        """Publish an event to all subscribers"""
        self._logger.debug(f"Event: {event.type.value} from {event.source}")

        # Call all subscribers for this event type
        for callback in self._subscribers[event.type]:
            try:
                # Support both sync and async callbacks
                if asyncio.iscoroutinefunction(callback):
                    await callback(event)
                else:
                    callback(event)
            except Exception as e:
                self._logger.error(f"Error in event handler: {e}", exc_info=True)


class Action(ABC):
    """
    Abstract base class for actions that tasks can trigger.
    Actions are triggered when changes are detected.
    """

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        self.name = name
        self.config = config
        self.event_bus = event_bus
        self._logger = logging.getLogger(f"mainspring.actions.{name}")

    @abstractmethod
    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        """
        Execute the action with the given context.
        Returns (success: bool, data: Optional[Dict[str, Any]]).
        Data will be attached to the action_completed event.
        """
        pass

    async def trigger(self, context: Dict[str, Any]):
        """Trigger the action and publish events"""
        # Check if action has a conditional expression
        if_condition = self.config.get("if")
        
        if if_condition is not None:
            try:
                # Evaluate the condition with context in scope
                # Make context available as both a variable and for key access
                eval_globals = {"context": context}
                eval_locals = dict(context)  # Allow direct access to context keys
                
                result = eval(if_condition, eval_globals, eval_locals)
                
                if not result:
                    self._logger.debug(f"Skipping action '{self.name}': condition '{if_condition}' evaluated to {result}")
                    return True  # Return success but skip execution
            except Exception as e:
                self._logger.error(f"Error evaluating condition '{if_condition}': {e}", exc_info=True)
                # On evaluation error, skip the action to be safe
                return False
        
        self._logger.info(f"Triggering action: {self.name}")

        await self.event_bus.publish(Event(
            type=EventType.ACTION_TRIGGERED,
            source=self.name,
            data={"context": context}
        ))

        try:
            success, action_data = await self.execute(context)

            if success:
                # Attach action data (e.g., run_url) to the completed event
                event_data = {"context": context}
                if action_data:
                    event_data["action_data"] = action_data
                
                await self.event_bus.publish(Event(
                    type=EventType.ACTION_COMPLETED,
                    source=self.name,
                    data=event_data
                ))
            else:
                await self.event_bus.publish(Event(
                    type=EventType.ACTION_FAILED,
                    source=self.name,
                    data={"context": context, "reason": "Action returned False"}
                ))

            return success
        except Exception as e:
            self._logger.error(f"Action failed: {e}", exc_info=True)
            await self.event_bus.publish(Event(
                type=EventType.ACTION_FAILED,
                source=self.name,
                data={"context": context, "error": str(e)}
            ))
            return False


class Task(ABC):
    """
    Abstract base class for long-running tasks.
    Tasks can detect changes and trigger actions.
    """

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        self.name = name
        self.config = config
        self.event_bus = event_bus
        self._logger = logging.getLogger(f"mainspring.tasks.{name}")
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self.actions: List[Action] = []

    def add_action(self, action: Action):
        """Add an action to be triggered when changes are detected"""
        self.actions.append(action)

    @abstractmethod
    async def run(self):
        """
        Main task loop. Should run until stopped.
        Must periodically check self._running and exit gracefully when False.
        """
        pass

    async def start(self):
        """Start the task"""
        if self._running:
            self._logger.warning(f"Task {self.name} is already running")
            return

        self._running = True
        self._logger.info(f"Starting task: {self.name}")

        await self.event_bus.publish(Event(
            type=EventType.TASK_STARTED,
            source=self.name,
            data={}
        ))

        self._task = asyncio.create_task(self._run_wrapper())

    async def stop(self):
        """Stop the task gracefully"""
        if not self._running:
            return

        self._logger.info(f"Stopping task: {self.name}")
        self._running = False

        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=10.0)
            except asyncio.TimeoutError:
                self._logger.warning(f"Task {self.name} did not stop gracefully, cancelling")
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass

        await self.event_bus.publish(Event(
            type=EventType.TASK_STOPPED,
            source=self.name,
            data={}
        ))

    async def restart(self):
        """Restart the task"""
        self._logger.info(f"Restarting task: {self.name}")
        await self.stop()
        await asyncio.sleep(1)  # Brief pause before restarting
        await self.start()

    async def _run_wrapper(self):
        """Wrapper around run() to handle errors"""
        try:
            await self.run()
        except asyncio.CancelledError:
            self._logger.info(f"Task {self.name} was cancelled")
            raise
        except Exception as e:
            self._logger.error(f"Task {self.name} failed: {e}", exc_info=True)
            await self.event_bus.publish(Event(
                type=EventType.TASK_ERROR,
                source=self.name,
                data={"error": str(e)}
            ))
            self._running = False

    async def trigger_actions(self, context: Dict[str, Any]):
        """Trigger all configured actions"""
        self._logger.info(f"Change detected in {self.name}, triggering {len(self.actions)} action(s)")

        await self.event_bus.publish(Event(
            type=EventType.CHANGE_DETECTED,
            source=self.name,
            data=context
        ))

        # Trigger all actions
        for action in self.actions:
            await action.trigger(context)


class ChangeDetector(ABC):
    """
    Abstract base for detecting changes.
    Used by tasks to determine if something has changed.
    """

    @abstractmethod
    async def has_changed(self) -> Coroutine[Any, Any, tuple[bool, dict[str, Any]]]:
        """
        Check if a change has occurred.
        Returns (changed, context) where context contains information about the change.
        """
        pass


class PeriodicChangeMonitorTask(Task):
    """
    Base class for tasks that periodically check a ChangeDetector.
    Implements the common pattern of polling a detector at intervals.
    """

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        super().__init__(name, config, event_bus)
        self.interval = config.get("interval", 300)  # Default 5 minutes
        self.detector: Optional[ChangeDetector] = None  # Subclasses must set this

    async def run(self):
        """Main monitoring loop - periodically checks detector and triggers actions"""
        if self.detector is None:
            self._logger.error("Detector not initialized!")
            return

        self._logger.info(f"{self.name} started, checking every {self.interval}s")

        while self._running:
            try:
                changed, context = await self.detector.has_changed()

                if changed:
                    self._logger.info("Change detected!")
                    await self.trigger_actions(context)
                else:
                    self._logger.debug("No changes detected")

                # Wait for the interval, but check _running periodically
                for _ in range(self.interval):
                    if not self._running:
                        break
                    await asyncio.sleep(1)

            except Exception as e:
                self._logger.error(f"Error in monitor: {e}", exc_info=True)
                await asyncio.sleep(60)  # Wait a minute before retrying
