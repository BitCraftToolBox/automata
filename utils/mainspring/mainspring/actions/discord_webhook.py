"""
Discord webhook action.
"""

from typing import Any, Dict, Optional
import aiohttp

from ..core import Action, EventBus


class DiscordWebhookAction(Action):
    """
    Posts a message to a Discord webhook.
    Supports per-action config overrides for webhook_url and enabled status.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus,
                 discord_config: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.discord_config = discord_config
        self.message_template = config.get("message", "Change detected!")
        
        # Allow per-action overrides of Discord config
        self.enabled = config.get("enabled", discord_config.get("enabled", False))
        self.webhook_url = config.get("webhook_url", discord_config.get("webhook_url"))
    
    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        """Post to Discord webhook"""
        if not self.enabled:
            self._logger.debug("Discord webhooks disabled, skipping")
            return True, None

        webhook_url = self.webhook_url
        if not webhook_url:
            self._logger.warning("Discord webhook URL not configured")
            return False, None
        
        # Format message with context
        try:
            message = self.message_template.format(**context)
        except KeyError:
            message = self.message_template
        
        payload = {
            "embeds": [{
                "title": "Mainspring Update",
                "description": message,
                "color": 0x00ff00,
                "fields": [
                    {"name": "Source", "value": context.get("source", "Unknown"), "inline": True},
                ]
            }]
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(webhook_url, json=payload) as response:
                    if response.status in (200, 204):
                        self._logger.info("Discord notification sent")
                        return True, None
                    else:
                        error_text = await response.text()
                        self._logger.error(f"Discord webhook failed: {response.status} - {error_text}")
                        return False, None
        except Exception as e:
            self._logger.error(f"Error posting to Discord: {e}", exc_info=True)
            return False, None
