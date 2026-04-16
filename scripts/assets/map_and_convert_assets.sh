#!/usr/bin/env bash

set -e

GAMEDATA_PATHS_FILE="gamedata_paths.json"
SPRITES_FILE="sprites.json"
CONVERTED_DIR="publish/sprites"
EXTRACTED_DIR="extracted"

WEBP_TOOLS_URL="https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-linux-x86-64.tar.gz"
WEBP_TOOLS_DIR="libwebp-1.6.0-linux-x86-64"
curl -O "$WEBP_TOOLS_URL"
tar -xzf "$(basename $WEBP_TOOLS_URL)"
CWEBP_PATH="$WEBP_TOOLS_DIR/bin/cwebp"

# Step 1: Build asset map from game data paths + sprites catalog
ASSET_MAP=$(jq -r '.[]' "$GAMEDATA_PATHS_FILE" | while read -r NAME; do
    echo "$NAME" | jq -R --slurpfile sprites "$SPRITES_FILE" '
        . as $name |
        if $name | test("\\[.*\\]") then
            ($name | capture("(?<base>[^\\[]+)\\[(?<numbers>.+)\\]")
                | .base as $base | .numbers | split(",") | map($base + .))
            | .[]
            | select($sprites[0][.] != null)
            | {($sprites[0][.]): .}
        else
            select($sprites[0][$name] != null) | {($sprites[0][$name]): $name}
        end'
done | jq -s 'add')

# Step 2: Convert assets using cwebp
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

# Step 3: Copy other assets that don't need mapping and conversion
# (so far just I18N)
mkdir -p "publish/I18N"
for f in "$EXTRACTED_DIR"/Assets/_Project/StaticAssets/_AddressedAssets/I18N/*.bytes; do
    name="$(basename "$f")"
    cp -- "$f" "publish/I18N/${name%.bytes}.csv"
done