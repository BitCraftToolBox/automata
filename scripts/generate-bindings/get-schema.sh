#!/usr/bin/env bash

if [ -f .env.local ]; then
    source .env.local
fi

hostname=${BITCRAFT_SPACETIME_HOST:-bitcraft-early-access.spacetimedb.com}
output_dir=${DATA_DIR:-workspace/bindings}

# Create output directory if it doesn't exist
mkdir -p "$output_dir"

curl --fail-with-body "https://${hostname}/v1/database/bitcraft-global/schema?version=9" -o "${output_dir}/global_schema.json"
curl --fail-with-body "https://${hostname}/v1/database/bitcraft-2/schema?version=9" -o "${output_dir}/region_schema.json"

for module in global region; do
  json="${output_dir}"/${module}_schema.json
  jq '.row_level_security |= sort_by(.sql)' "$json" > "${json}"_sorted
  mv "${json}"_sorted "${json}"
done
