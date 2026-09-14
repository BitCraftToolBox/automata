#!/usr/bin/env bash
set -e

if [ -f .env.local ]; then
    source .env.local
fi

scheme=${BITCRAFT_HOST_SCHEME:-https}
hostname=${BITCRAFT_SPACETIME_HOST:-bitcraft-early-access.spacetimedb.com}
global_mod=${BITCRAFT_GLOBAL_MODULE:-bitcraft-global}
region_mod=${BITCRAFT_REGION_MODULE:-bitcraft-2}
output_dir=${DATA_DIR:-workspace/bindings}

# Create output directory if it doesn't exist
mkdir -p "$output_dir"

curl --fail "${scheme}://${hostname}/v1/database/${global_mod}/schema?version=9" -o "${output_dir}/global_schema.json"
curl --fail "${scheme}://${hostname}/v1/database/${region_mod}/schema?version=9" -o "${output_dir}/region_schema.json"
curl --fail "${scheme}://${hostname}/v1/database/${global_mod}/schema?version=10" -o "${output_dir}/global_schema_v10.json"
curl --fail "${scheme}://${hostname}/v1/database/${region_mod}/schema?version=10" -o "${output_dir}/region_schema_v10.json"

for module in global region; do
  json="${output_dir}"/${module}_schema.json
  jq '.row_level_security |= sort_by(.sql)' "$json" > "${json}"_sorted
  mv "${json}"_sorted "${json}"

  # v10's ModuleDef is a flat list of tagged sections rather than top-level fields.
  json10="${output_dir}"/${module}_schema_v10.json
  jq '.sections |= map(if has("RowLevelSecurity") then .RowLevelSecurity |= sort_by(.sql) else . end)' "$json10" > "${json10}"_sorted
  mv "${json10}"_sorted "${json10}"
done
