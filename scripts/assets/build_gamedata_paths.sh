#!/usr/bin/env bash

set -e

WANTED_SPRITES_FILE="wanted_sprites.json"
GAME_DATA_DIR="game-data/static"
GAMEDATA_PATHS_FILE="gamedata_paths.json"

# Extract all sprite names referenced in game data tables (no sprites.json lookup needed)
MAPPINGS=$(jq -n \
    --arg GAME_DATA_DIR "$GAME_DATA_DIR" \
    --slurpfile wanted "$WANTED_SPRITES_FILE" \
    '($wanted[0] | to_entries | map({
        table: .key,
        field: .value,
        file: ($GAME_DATA_DIR + "/" + .key + ".json")
    }))')

echo "$MAPPINGS" | jq -c '.[]' | while read -r MAP; do
    FILE=$(echo "$MAP" | jq -r '.file')
    FIELD=$(echo "$MAP" | jq -r '.field')
    if [ -f "$FILE" ]; then
        jq -r --arg FIELD "$FIELD" \
            '[.[] | select(.[$FIELD] != null and .[$FIELD] != "") | .[$FIELD]] | .[]' "$FILE"
    fi
done | sort -u | jq -R . | jq -s 'sort' > "$GAMEDATA_PATHS_FILE"

echo "Game data paths saved to $GAMEDATA_PATHS_FILE"

