"""
GitHub workflow dispatch action.
"""

from typing import Any, Dict, Optional
import aiohttp

from ..core import Action, EventBus


class GitHubDispatchAction(Action):
    """
    Triggers a GitHub Actions workflow via repository_dispatch or workflow_dispatch.
    Supports per-action config overrides for owner, repo, and token.
    """
    
    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus,
                 github_config: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.github_config = github_config
        self.workflow = config.get("workflow")
        self.inputs = config.get("inputs", {})
        
        # Allow per-action overrides of GitHub config
        self.owner = config.get("owner", github_config.get("owner"))
        self.repo = config.get("repo", github_config.get("repo"))
        self.token = config.get("token", github_config.get("token"))
        
        if not all([self.workflow, self.owner, self.repo, self.token]):
            raise ValueError(f"GitHubDispatchAction {name} has incomplete configuration")
    
    async def execute(self, context: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
        """Execute the GitHub workflow dispatch"""
        owner = self.owner
        repo = self.repo
        token = self.token

        # Merge context into inputs
        inputs = {**self.inputs, **context.get("inputs", {})}
        
        url = f"https://api.github.com/repos/{owner}/{repo}/actions/workflows/{self.workflow}/dispatches"
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10"
        }
        params = {
            "return_run_details": "true"
        }
        data = {
            "ref": "main",
            "inputs": inputs
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=data, headers=headers, params=params) as response:
                    if response.status in (200, 204):
                        self._logger.info(f"Successfully triggered workflow: {self.workflow}")
                        
                        action_data = {
                            "workflow": self.workflow,
                            "owner": owner,
                            "repo": repo,
                        }
                        
                        # If GitHub returns run details, extract the API URL
                        if response.status == 200:
                            result = await response.json()
                            if "run_url" in result:
                                action_data["run_url"] = result["run_url"]
                        
                        return True, action_data
                    else:
                        error_text = await response.text()
                        self._logger.error(f"Failed to trigger workflow: {response.status} - {error_text}")
                        return False, None
        except Exception as e:
            self._logger.error(f"Error triggering GitHub workflow: {e}", exc_info=True)
            return False, None
