#!/usr/bin/env bash

set -e

WANTED_SPRITES_FILE="wanted_sprites.json"
GAME_DATA_DIR="game-data/static"
SPRITES_FILE="sprites.json"
CONVERTED_DIR="publish/sprites"
EXTRACTED_DIR="extracted"

WEBP_TOOLS_URL="https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-linux-x86-64.tar.gz"
WEBP_TOOLS_DIR="libwebp-1.6.0-linux-x86-64"
curl -O "$WEBP_TOOLS_URL"
tar -xzf "$(basename $WEBP_TOOLS_URL)"
CWEBP_PATH="$WEBP_TOOLS_DIR/bin/cwebp"


# Step 1: Extract file:field mappings from wanted_sprites.json
MAPPINGS=$(jq -n \
    --arg GAME_DATA_DIR "$GAME_DATA_DIR" \
    --slurpfile wanted "$WANTED_SPRITES_FILE" \
    '($wanted[0] | to_entries | map({
        table: .key,
        field: .value,
        file: ($GAME_DATA_DIR + "/" + .key + ".json")
    }))')

# Step 2: Iterate over each mapping and process the files
ASSET_MAP=$(echo "$MAPPINGS" | jq -c '.[]' | while read -r MAP; do
    FILE=$(echo "$MAP" | jq -r '.file')
    FIELD=$(echo "$MAP" | jq -r '.field')

    if [ -f "$FILE" ]; then
        jq -r --arg FIELD "$FIELD" --slurpfile sprites "$SPRITES_FILE" \
            '.[] | select(.[$FIELD] != null and .[$FIELD] != "") | .[$FIELD] as $name | select($sprites[0][$name] != null or ($name | test("\\[.*\\]"))) |
            if $name | test("\\[.*\\]") then
                ($name | capture("(?<base>[^\\[]+)\\[(?<numbers>.+)\\]") | .base as $base | .numbers | split(",") | map($base + .)) | .[] | {($sprites[0][.]): .}
            else
                {($sprites[0][$name]): $name}
            end' "$FILE"
    else
        echo "{}"
    fi
done | jq -s 'add')

# Step 3: Convert assets using cwebp
echo "$ASSET_MAP" | jq -r 'to_entries[] | "\(.key)\t\(.value)"' | while IFS=$'\t' read -r ASSET NAME; do
    FULL_PATH="$EXTRACTED_DIR/$ASSET"
    if [ -f "$FULL_PATH" ]; then
        OUTPUT_DIR="$CONVERTED_DIR/$(dirname "$NAME")"
        mkdir -p "$OUTPUT_DIR"
        "$CWEBP_PATH" -lossless "$FULL_PATH" -o "$CONVERTED_DIR/$NAME.webp"
    else
        echo "File not found: $FULL_PATH"
    fi
done

# Step 4: Copy other assets that don't need mapping and conversion
# (so far just I18N)
mkdir -p "publish/I18N"
for f in "$EXTRACTED_DIR"/Assets/_Project/StaticAssets/_AddressedAssets/I18N/*.bytes; do
    name="$(basename "$f")"
    cp -- "$f" "publish/I18N/${name%.bytes}.csv"
done