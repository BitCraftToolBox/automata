#!/usr/bin/env bash

set -e

WANTED_SPRITES_FILE="wanted_sprites.json"
WANTED_PREFABS_FILE="wanted_prefabs.json"
WANTED_RESOURCES_FILE="wanted_resources.json"
GAME_DATA_DIR="game-data/static"
GAMEDATA_PATHS_SPRITES_FILE="gamedata_paths_sprites.json"
GAMEDATA_PATHS_PREFABS_FILE="gamedata_paths_prefabs.json"

# Extracts every value of $FIELD (dotted paths supported) across all rows of $FILE, unpacking
# array-valued fields (e.g. wanted_prefabs.json's wall_asset_names) into individual values.
extract_values() {
    local FILE="$1"
    local FIELD="$2"
    if [ -f "$FILE" ]; then
        jq -r --arg FIELD "$FIELD" \
            '[.[] | getpath($FIELD | split(".")) | select(. != null and . != "") | if type == "array" then .[] else . end] | .[]' \
            "$FILE"
    fi
}

# Kept as two separate files, not merged: map_and_convert_assets.sh matches every value in its
# input file against sprites.json, so a prefab-only value that happens to also be a valid sprite
# name would get fetched as an unwanted sprite if the two lists were combined. Callers that just
# want a single cache key covering both (e.g. the workflow's gamedata-paths-cache) can hash both
# files together with hashFiles().

# Sprites: wanted_sprites.json is {table: field}, one field per table.
jq -n --slurpfile wanted "$WANTED_SPRITES_FILE" \
    '$wanted[0] | to_entries | map({table: .key, field: .value})' \
    | jq -c '.[]' \
    | while read -r MAP; do
        TABLE=$(echo "$MAP" | jq -r '.table')
        FIELD=$(echo "$MAP" | jq -r '.field')
        extract_values "$GAME_DATA_DIR/$TABLE.json" "$FIELD"
    done \
    | sort -u | jq -R . | jq -s 'sort' > "$GAMEDATA_PATHS_SPRITES_FILE"

# Prefabs + resources: wanted_prefabs.json and wanted_resources.json are both
# [{table, field, prefix}]. Resources are folded into the same cache-key file as prefabs since
# it's only used to invalidate a cache key, not read back for its own resolution logic.
{
    jq -c '.[]' "$WANTED_PREFABS_FILE"
    if [ -f "$WANTED_RESOURCES_FILE" ]; then jq -c '.[]' "$WANTED_RESOURCES_FILE"; fi
} | while read -r MAP; do
        TABLE=$(echo "$MAP" | jq -r '.table')
        FIELD=$(echo "$MAP" | jq -r '.field')
        extract_values "$GAME_DATA_DIR/$TABLE.json" "$FIELD"
    done \
    | sort -u | jq -R . | jq -s 'sort' > "$GAMEDATA_PATHS_PREFABS_FILE"

echo "Game data paths saved to $GAMEDATA_PATHS_SPRITES_FILE and $GAMEDATA_PATHS_PREFABS_FILE"
