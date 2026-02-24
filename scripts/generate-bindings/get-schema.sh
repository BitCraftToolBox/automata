#!/usr/bin/env bash
set -e

if [ -f .env.local ]; then
    source .env.local
fi

hostname=${BITCRAFT_SPACETIME_HOST:-bitcraft-early-access.spacetimedb.com}
global_mod=${BITCRAFT_GLOBAL_MODULE:-bitcraft-global}
region_mod=${BITCRAFT_REGION_MODULE:-bitcraft-2}
output_dir=${DATA_DIR:-workspace/bindings}

# Create output directory if it doesn't exist
mkdir -p "$output_dir"

curl --fail "https://${hostname}/v1/database/${global_mod}/schema?version=9" -o "${output_dir}/global_schema.json"
curl --fail "https://${hostname}/v1/database/${region_mod}/schema?version=9" -o "${output_dir}/region_schema.json"

for module in global region; do
  json="${output_dir}"/${module}_schema.json
  jq '.row_level_security |= sort_by(.sql)' "$json" > "${json}"_sorted
  mv "${json}"_sorted "${json}"
done
