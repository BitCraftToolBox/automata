"""
Mainspring - Event-driven task orchestrator for BitCraft data extraction

Main exports:
- Mainspring: Main application class
- EventBus: Event communication system
- Task, Action: Base classes for extensibility
"""

from .mainspring import Mainspring, main
from .core import EventBus, Task, Action, Event, EventType, ChangeDetector, PeriodicChangeMonitorTask
from .tasks import (
    SchemaMonitorTask,
    TableSubscriberTask, 
    AssetMonitorTask,
    WorkflowMonitorTask
)
from .actions import GitHubDispatchAction, DiscordWebhookAction, RestartTaskAction, LogAction

__version__ = "0.1.0"

__all__ = [
    "Mainspring",
    "main",
    "EventBus",
    "Task",
    "Action",
    "Event",
    "EventType",
    "ChangeDetector",
    "PeriodicChangeMonitorTask",
    "SchemaMonitorTask",
    "TableSubscriberTask",
    "AssetMonitorTask",
    "WorkflowMonitorTask",
    "GitHubDispatchAction",
    "DiscordWebhookAction",
    "RestartTaskAction",
    "LogAction",
]
