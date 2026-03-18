"""
Restart task action.
"""

from typing import Any, Dict, Optional

from ..core import Action, EventBus


class RestartTaskAction(Action):
    """
    Restarts another task in the system.
    Useful when schema changes require re-subscribing to tables.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus,
                 task_registry: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.task_registry = task_registry
        self.target_task = config.get("task")
        
        if not self.target_task:
            raise ValueError("RestartTaskAction requires 'task' in config")
    
    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        """Restart the target task"""
        task = self.task_registry.get(self.target_task)
        
        if not task:
            self._logger.error(f"Task '{self.target_task}' not found in registry")
            return False, None
        
        try:
            self._logger.info(f"Restarting task: {self.target_task}")
            await task.restart()
            return True, None
        except Exception as e:
            self._logger.error(f"Error restarting task: {e}", exc_info=True)
            return False, None
