"""
Action implementations for mainspring.

These actions can be triggered when tasks detect changes.
"""

from .github_dispatch import GitHubDispatchAction
from .discord_webhook import DiscordWebhookAction
from .restart_task import RestartTaskAction
from .log import LogAction

__all__ = [
    "GitHubDispatchAction",
    "DiscordWebhookAction",
    "RestartTaskAction",
    "LogAction",
]
