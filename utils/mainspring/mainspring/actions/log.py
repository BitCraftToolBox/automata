"""
Simple logging action for testing and debugging.
"""

from typing import Any, Dict, Optional

from ..core import Action, EventBus


class LogAction(Action):
    """
    Simple logging action for testing and debugging.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        super().__init__(name, config, event_bus)
        self.log_level = config.get("level", "INFO")
        self.message_template = config.get("message", "Change detected: {source}")
    
    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        """Log the change"""
        try:
            message = self.message_template.format(**context)
        except KeyError:
            message = f"{self.message_template} - Context: {context}"
        
        log_method = getattr(self._logger, self.log_level.lower(), self._logger.info)
        log_method(message)
        return True, None
