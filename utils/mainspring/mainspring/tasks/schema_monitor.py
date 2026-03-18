"""
Schema monitor task for detecting SpacetimeDB schema changes.
"""

import hashlib
import json
from typing import Any, Dict, Optional

from ..core import EventBus, ChangeDetector, PeriodicChangeMonitorTask
from .utils import fetch_schema, get_static_tables_from_schema


class SchemaChangeDetector(ChangeDetector):
    """Detects changes in SpacetimeDB schema and static table lists"""

    def __init__(self, host: str, global_module: str, region_module: str):
        self.host = host
        self.global_module = global_module
        self.region_module = region_module
        self._last_global_hash: Optional[str] = None
        self._last_region_hash: Optional[str] = None
        self._static_tables_cache: list[str] = []

    @staticmethod
    def _hash_schema(schema: Dict[str, Any]) -> str:
        """Create a hash of the schema for comparison"""
        # Sort the row_level_security section to avoid false positives from ordering differences
        # (server sometimes returns identical schema with rls section in different order)
        if "row_level_security" in schema:
            rls = schema["row_level_security"]
            if isinstance(rls, list):
                schema["row_level_security"] = sorted(rls, key=lambda x: x.get('sql', ''))

        # Serialize and hash the schema
        schema_str = json.dumps(schema, sort_keys=True)
        return hashlib.sha256(schema_str.encode()).hexdigest()

    async def has_changed(self) -> tuple[bool, Dict[str, Any]]:
        """Check if schema has changed and if static table list has changed"""
        global_schema = await fetch_schema(self.host, self.global_module)
        region_schema = await fetch_schema(self.host, self.region_module)

        if not global_schema or not region_schema:
            return False, {}

        global_hash = self._hash_schema(global_schema)
        region_hash = self._hash_schema(region_schema)

        changed = False
        changes = {}

        if self._last_global_hash is None:
            # First run, just store the hash and static tables
            self._last_global_hash = global_hash
            self._last_region_hash = region_hash
            # Use region module for static table detection (has all desc tables)
            self._static_tables_cache = get_static_tables_from_schema(region_schema)
            return False, {}

        if global_hash != self._last_global_hash:
            changed = True
            changes["global"] = {
                "old_hash": self._last_global_hash,
                "new_hash": global_hash,
                "tables": len(global_schema.get("tables", []))
            }
            self._last_global_hash = global_hash

        if region_hash != self._last_region_hash:
            changed = True
            changes["region"] = {
                "old_hash": self._last_region_hash,
                "new_hash": region_hash,
                "tables": len(region_schema.get("tables", []))
            }
            self._last_region_hash = region_hash

            # Check if static tables changed when region schema changes
            new_static_tables = get_static_tables_from_schema(region_schema)
            if self._static_tables_cache:
                old_set = set(self._static_tables_cache)
                new_set = set(new_static_tables)

                if old_set != new_set:
                    added_tables = sorted(list(new_set - old_set))
                    removed_tables = sorted(list(old_set - new_set))

                    changes["static_tables"] = {
                        "tables_added": added_tables,
                        "tables_removed": removed_tables,
                        "total_tables": len(new_static_tables)
                    }

            self._static_tables_cache = new_static_tables

        # Build description
        description_parts = []
        if "global" in changes:
            description_parts.append("global schema")
        if "region" in changes:
            description_parts.append("region schema")
        if "static_tables" in changes:
            st = changes["static_tables"]
            description_parts.append(f"{len(st['tables_added'])} tables added, {len(st['tables_removed'])} removed")

        return changed, {
            "source": "schema_monitor",
            "description": f"Schema changed: {', '.join(description_parts)}",
            "changes": changes
        }


class SchemaMonitorTask(PeriodicChangeMonitorTask):
    """
    Monitors SpacetimeDB schema for changes.
    Checks periodically and triggers actions when schema changes are detected.
    """

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus,
                 stdb_config: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.detector = SchemaChangeDetector(
            host=stdb_config.get("host"),
            global_module=stdb_config.get("global_module"),
            region_module=stdb_config.get("region_module")
        )
