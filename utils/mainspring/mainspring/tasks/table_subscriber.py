"""
Table subscriber task for monitoring SpacetimeDB table changes.
"""

import asyncio
import json
from datetime import datetime
from typing import Any, Dict, Optional

from websockets.asyncio.client import connect
from websockets import Subprotocol
from websockets.exceptions import WebSocketException

from ..core import Task, EventBus
from .utils import fetch_schema, get_static_tables_from_schema


class TableSubscriberTask(Task):
    """
    Subscribes to SpacetimeDB tables and monitors for changes.
    Uses websocket connection to receive real-time updates.
    Filters to static tables (desc tables and extras) if no tables are specified.
    """

    def __init__(self, name: str, config: Dict[str, Any], event_bus: EventBus,
                 stdb_config: Dict[str, Any]):
        super().__init__(name, config, event_bus)
        self.host = stdb_config.get("host")
        self.bearer_token = config.get("bearer_token", stdb_config.get("bearer_token"))
        self.module = config.get("module")
        if self.module == "__region__" or not self.module:
            self.module = stdb_config.get("region_module")
        elif self.module == "__global__":
            self.module = stdb_config.get("global_module")
        self.reconnect_on_error = config.get("reconnect_on_error", True)
        self.tables_to_monitor = config.get("tables", [])  # Specific tables or empty for static tables
        self.queries_to_monitor = config.get("queries", [])  # Custom SQL queries to monitor
        self.trigger_interval = config.get("trigger_interval", 60)  # Seconds between triggers

    async def run(self):
        """Main subscription loop"""
        while self._running:
            try:
                await self._subscribe_and_monitor()
            except Exception as e:
                if isinstance(e, WebSocketException):
                    self._logger.error(f"WebSocket error: {e}")
                else:
                    self._logger.error(f"Unexpected error: {e}", exc_info=True)
                if not self.reconnect_on_error or not self._running:
                    break
                self._logger.info("Reconnecting in 30 seconds...")
                await asyncio.sleep(30)

    async def _fetch_static_tables(self) -> list[str]:
        """Fetch schema and filter to static tables (desc tables + extras)"""
        # Use shared function to fetch schema
        schema = await fetch_schema(self.host, self.module)

        if not schema:
            self._logger.error("Failed to fetch schema")
            return []

        # Use shared utility function for filtering
        static_tables = get_static_tables_from_schema(schema)

        self._logger.info(f"Found {len(static_tables)} static tables to monitor")
        return static_tables

    async def _subscribe_and_monitor(self):
        """Connect to SpacetimeDB and monitor for changes"""
        # Build a list of queries to subscribe to before connecting to WebSocket

        # Option 1: Custom SQL queries
        if self.queries_to_monitor:
            queries = self.queries_to_monitor
            self._logger.info(f"Using {len(queries)} custom SQL queries")

        # Option 2: Specific table names
        elif self.tables_to_monitor:
            queries = [f"SELECT * FROM {table};" for table in self.tables_to_monitor]
            self._logger.info(f"Using {len(self.tables_to_monitor)} configured tables")

        # Option 3: Auto-detect static tables
        else:
            # Fetch static tables from schema
            tables = await self._fetch_static_tables()

            if not tables:
                self._logger.error("No tables to subscribe to, waiting...")
                await asyncio.sleep(300)
                return

            # Convert table names to queries
            queries = [f"SELECT * FROM {table};" for table in tables]

        # Now connect to WebSocket with queries ready
        uri = f"wss://{self.host}/v1/database/{self.module}/subscribe"
        proto = Subprotocol('v1.json.spacetimedb')
        headers = {}

        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"

        self._logger.info(f"Connecting to {uri}")

        async with connect(
                uri,
                additional_headers=headers,
                subprotocols=[proto],
                max_size=None,
                max_queue=None
        ) as ws:
            # The first message is IdentityToken
            _ = await ws.recv()
            self._logger.debug(f"Received identity token")

            # Subscribe to all queries using SubscribeMulti pattern
            for idx, query in enumerate(queries):
                subscribe_msg = json.dumps({
                    "SubscribeMulti": {
                        "request_id": idx,
                        "query_id": {"id": idx},
                        "query_strings": [query]
                    }
                })
                await ws.send(subscribe_msg)

            self._logger.info(f"Subscribed to {len(queries)} queries")

            update_count = 0
            accumulated_changes = {}
            trigger_task: Optional[asyncio.Task] = None

            async def trigger_actions_delayed():
                """Delayed action trigger - waits for a quiet period before triggering"""
                await asyncio.sleep(self.trigger_interval)
                
                if accumulated_changes:
                    # Calculate summary
                    total_tables = len(accumulated_changes)
                    total_inserts = sum(c["inserts"] for c in accumulated_changes.values())
                    total_deletes = sum(c["deletes"] for c in accumulated_changes.values())
                    total_updates = sum(c["updates"] for c in accumulated_changes.values())

                    summary = {
                        "tables_updated": total_tables,
                        "total_inserts": total_inserts,
                        "total_deletes": total_deletes,
                        "total_updates": total_updates
                    }

                    self._logger.info(f"Triggering actions for {total_tables} tables: {summary}")
                    await self.trigger_actions({
                        "source": "table_subscriber",
                        "timestamp": datetime.now().isoformat(),
                        "changes": accumulated_changes,
                        "summary": summary,
                        "description": f"Detected {total_tables} tables updated in SpacetimeDB."
                    })

                    accumulated_changes.clear()

            # Monitor for updates
            while self._running:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    data = json.loads(msg)

                    if "InitialSubscription" in data:
                        continue

                    # Handle TransactionUpdate messages
                    if "TransactionUpdate" in data:
                        tx_update = data["TransactionUpdate"]

                        # Check for failures
                        if "Failed" in tx_update.get("status", {}):
                            failure = tx_update["status"]["Failed"]
                            self._logger.error(f"Transaction failed: {failure}")
                            continue

                        # Process committed updates
                        if "Committed" in tx_update.get("status", {}):
                            update_count += 1
                            tables_updated = tx_update["status"]["Committed"].get("tables", [])

                            # Process each table update
                            for table_update in tables_updated:
                                table_name = table_update.get("table_name")
                                updates = table_update.get("updates", [])

                                # Track changes per table
                                if table_name not in accumulated_changes:
                                    accumulated_changes[table_name] = {
                                        "inserts": 0,
                                        "deletes": 0,
                                        "updates": 0
                                    }

                                for update in updates:
                                    inserts = update.get("inserts", [])
                                    deletes = update.get("deletes", [])

                                    # Try to match inserted and deleted rows by ID to detect updates
                                    matched_updates = 0
                                    if inserts and deletes:
                                        try:
                                            # Parse insert and delete rows as JSON objects
                                            inserted_rows = [json.loads(row) for row in inserts]
                                            deleted_rows = [json.loads(row) for row in deletes]

                                            # Check if rows are dicts with "id" key
                                            if (inserted_rows and deleted_rows and
                                                    isinstance(inserted_rows[0], dict) and "id" in inserted_rows[0] and
                                                    isinstance(deleted_rows[0], dict) and "id" in deleted_rows[0]):
                                                # Extract IDs from row objects
                                                inserted_ids = {row["id"] for row in inserted_rows if isinstance(row, dict) and "id" in row}
                                                deleted_ids = {row["id"] for row in deleted_rows if isinstance(row, dict) and "id" in row}

                                                # Count matching IDs as updates
                                                matched_updates = len(inserted_ids & deleted_ids)
                                        except (json.JSONDecodeError, KeyError, TypeError) as e:
                                            # If we can't parse or match IDs, just count inserts/deletes separately
                                            self._logger.debug(f"Could not match IDs for {table_name}: {e}")

                                    # Count total inserts and deletes
                                    accumulated_changes[table_name]["inserts"] += len(inserts)
                                    accumulated_changes[table_name]["deletes"] += len(deletes)
                                    accumulated_changes[table_name]["updates"] += matched_updates

                            self._logger.debug(f"Transaction #{update_count}: {len(tables_updated)} tables updated")

                            # Debounce pattern: Cancel previous trigger and schedule new one
                            # This ensures we trigger after trigger_interval seconds of NO updates
                            if trigger_task and not trigger_task.done():
                                trigger_task.cancel()
                                try:
                                    await trigger_task
                                except asyncio.CancelledError:
                                    pass

                            # Schedule new trigger after quiet period
                            trigger_task = asyncio.create_task(trigger_actions_delayed())
                except asyncio.TimeoutError:
                    # No message received, just continue
                    continue
                except json.JSONDecodeError as e:
                    self._logger.warning(f"Failed to decode message: {e}")
                    continue
            
            # Clean up: if we're shutting down and there's a pending trigger, cancel it
            if trigger_task and not trigger_task.done():
                trigger_task.cancel()
                try:
                    await trigger_task
                except asyncio.CancelledError:
                    pass
