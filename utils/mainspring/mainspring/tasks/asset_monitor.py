"""
Asset monitor task for detecting Steam depot manifest changes.
"""

import asyncio
import logging
from typing import Any, Dict, Optional

from ..core import EventBus, ChangeDetector, PeriodicChangeMonitorTask


class AssetChangeDetector(ChangeDetector):
    """Detects changes in Steam depot manifest across multiple branches"""

    def __init__(self, app_id: int, depot_id: int, branches: list[str],
                 steam_username: Optional[str] = None,
                 steam_password: Optional[str] = None):
        self.app_id = app_id
        self.depot_id = depot_id
        self.branches = branches
        self.steam_username = steam_username
        self.steam_password = steam_password
        self._last_manifest_ids: Dict[str, int] = {}
        self._logger = logging.getLogger("mainspring.detectors.asset")

    async def has_changed(self) -> tuple[bool, Dict[str, Any]]:
        """Check if the Steam depot manifest has changed for any monitored branches"""
        if not self.branches:
            self._logger.debug("No branches configured for asset monitor, skipping check")
            return False, {}

        self._logger.debug("Checking for asset changes...")
        try:
            loop = asyncio.get_event_loop()
            manifest_ids = await loop.run_in_executor(None, self._get_manifest_ids)

            if not manifest_ids:
                self._logger.warning("Failed to fetch manifest IDs from Steam")
                return False, {}

            if not self._last_manifest_ids:
                self._logger.info(f"Initial manifest IDs: {manifest_ids}")
                self._last_manifest_ids = manifest_ids.copy()
                return False, {}

            changes = {}
            for branch, manifest_id in manifest_ids.items():
                old_id = self._last_manifest_ids.get(branch)
                
                if old_id is None:
                    self._logger.info(f"Now tracking branch '{branch}': {manifest_id}")
                    self._last_manifest_ids[branch] = manifest_id
                elif manifest_id != old_id:
                    changes[branch] = {
                        "old_manifest_id": old_id,
                        "new_manifest_id": manifest_id
                    }
                    self._last_manifest_ids[branch] = manifest_id

            if changes:
                branch_list = ", ".join(changes.keys())
                context = {
                    "source": "asset_monitor",
                    "description": f"Steam depot manifest changed for branches: {branch_list}",
                    "branches_changed": list(changes.keys()),
                    "changes": changes,
                    "app_id": self.app_id,
                    "depot_id": self.depot_id
                }
                return True, context

            self._logger.debug(f"Manifests unchanged for all branches")
            return False, {}
        except Exception as e:
            self._logger.error(f"Error checking Steam manifest: {e}", exc_info=True)
            return False, {}

    def _get_manifest_ids(self) -> Dict[str, int]:
        """Get the current manifest IDs for all monitored branches from Steam."""
        steam_client = None
        try:
            from steam.client import SteamClient
            from steam.enums import EResult

            steam_client = SteamClient()

            if self.steam_username and self.steam_password:
                self._logger.debug("Logging into Steam with credentials...")
                result = steam_client.login(self.steam_username, self.steam_password)
            else:
                self._logger.debug("Logging into Steam anonymously...")
                result = steam_client.anonymous_login()

            if result != EResult.OK:
                self._logger.error(f"Steam login failed: {result}")
                return {}

            app_info = steam_client.get_product_info(apps=[self.app_id])

            if not app_info or 'apps' not in app_info or self.app_id not in app_info['apps']:
                self._logger.error(f"Failed to get app info for {self.app_id}")
                return {}

            app_data = app_info['apps'][self.app_id]
            depots = app_data.get('depots', {})
            depot_info = depots.get(str(self.depot_id), {})
            manifests = depot_info.get('manifests', {})

            manifest_ids = {}
            for branch in self.branches:
                manifest_data = manifests.get(branch, {})
                manifest_gid = manifest_data.get('gid')

                if manifest_gid:
                    manifest_ids[branch] = int(manifest_gid)
                else:
                    self._logger.warning(f"No manifest found for depot {self.depot_id}, branch {branch}")

            if manifest_ids:
                self._logger.debug(f"Retrieved {len(manifest_ids)} manifest IDs from Steam")
            
            return manifest_ids

        except Exception as e:
            self._logger.error(f"Error in _get_manifest_ids: {e}", exc_info=True)
            return {}
        finally:
            if steam_client:
                try:
                    steam_client.logout()
                except:
                    pass


class AssetMonitorTask(PeriodicChangeMonitorTask):
    """Monitors Steam depot manifest for asset updates across multiple branches."""

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus):
        super().__init__(name, config, event_bus)

        branches = config.get("branches")
        if branches is None:
            branch = config.get("branch", "preview")
            branches = [branch]

        self.detector = AssetChangeDetector(
            app_id=config.get("app_id", 3454650),
            depot_id=config.get("depot_id", 3454651),
            branches=branches,
            steam_username=config.get("steam_username"),
            steam_password=config.get("steam_password")
        )
