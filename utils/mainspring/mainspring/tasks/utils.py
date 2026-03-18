"""
Utility functions shared across tasks.
"""

import logging
from typing import Any, Dict, Optional
import aiohttp
import re


async def fetch_schema(host: str, module: str) -> Optional[Dict[str, Any]]:
    """
    Fetch schema from SpacetimeDB.
    Shared utility function used by SchemaChangeDetector and TableSubscriberTask.
    """
    url = f"https://{host}/v1/database/{module}/schema"
    params = {"version": "9"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as response:
                if response.status == 200:
                    return await response.json()
                return None
    except Exception as e:
        logging.getLogger("mainspring.utils").error(f"Error fetching schema: {e}")
        return None


def get_static_tables_from_schema(schema: Dict[str, Any]) -> list[str]:
    """
    Extract static tables from a schema (desc tables and extras).
    Shared utility function used by SchemaChangeDetector and TableSubscriberTask.
    """
    desc_re = re.compile(r".+_desc(_v\d+)?$")
    extra_tables = ['claim_tile_cost']

    tables = schema.get("tables", [])
    static_tables = []

    for tbl in tables:
        if 'Public' not in tbl.get('table_access', []):
            continue

        name = tbl['name']

        # Include desc tables
        if desc_re.match(name):
            static_tables.append(name)
            continue

        # Exclude state tables
        if name.endswith('_state'):
            continue

        # Include extra tables
        if name in extra_tables:
            static_tables.append(name)

    return static_tables
