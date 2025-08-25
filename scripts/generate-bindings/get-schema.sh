#!/usr/bin/env bash

if [ -f .env.local ]; then
    source .env.local
fi

hostname=${BITCRAFT_SPACETIME_HOST:-bitcraft-early-access.spacetimedb.com}
output_dir=${DATA_DIR:-workspace/bindings}

# Create output directory if it doesn't exist
mkdir -p "$output_dir"

curl "https://${hostname}/v1/database/bitcraft-global/schema?version=9" -o "${output_dir}/global_schema.json"
curl "https://${hostname}/v1/database/bitcraft-2/schema?version=9" -o "${output_dir}/region_schema.json"
