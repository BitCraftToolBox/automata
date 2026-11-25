#!/usr/bin/env bash
# Local reproduction of the GHA data pipeline against the staging server (.env.local),
# without pushing anything to the public repos.
#
#   scripts/local/run-local.sh [step ...]
#
# Steps (default: all, in order):
#   bindings    fetch region v10 schema, generate TS + C# bindings (spacetime 2.10.0) + apply patches
#   bsatn       run scripts/bsatn against the generated TS bindings
#   cereal-cs   run scripts/cereal-cs against the generated C# bindings
#   brico       copy bsatn data + TS bindings into ../brico
#   cereal      copy cereal-cs data into a new ../cereal-data/data/<date>[-N] and run update-versions.ts
#
# Everything intermediate lives in workspace/local (nothing there is ever committed). The bindings
# submodules under scripts/*/bindings are NOT touched: the extractors are built from a copy of their
# sources in workspace/local/build/.
#
# Env overrides: BRICO_DIR, CEREAL_DIR, CEREAL_DATA_DIR, SPACETIME_CLI_VERSION

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

BRICO_DIR=${BRICO_DIR:-"$ROOT/../brico"}
CEREAL_DIR=${CEREAL_DIR:-"$ROOT/../cereal"}
CEREAL_DATA_DIR=${CEREAL_DATA_DIR:-"$ROOT/../cereal-data"}
CLI_VERSION=${SPACETIME_CLI_VERSION:-2.10.0}

WORK="$ROOT/workspace/local"
BIND_DIR="$WORK/bindings"
BUILD_DIR="$WORK/build"
DATA_BSATN="$WORK/data/bsatn/static"
DATA_CS="$WORK/data/cereal-cs"
PATCHES="$ROOT/scripts/generate-bindings/patches/v2"

# --- env ----------------------------------------------------------------------------------
[ -f .env.local ] || { echo "missing .env.local" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source <(tr -d '\r' < .env.local)
set +a
: "${BITCRAFT_SPACETIME_HOST:?not set in .env.local}"
: "${BITCRAFT_REGION_MODULE:?not set in .env.local}"
: "${BITCRAFT_BEARER_TOKEN:?not set in .env.local}"
scheme=${BITCRAFT_HOST_SCHEME:-https}
# The extractors hardcode https/wss and read DATA_DIR themselves; make sure a stray value doesn't leak in.
unset DATA_DIR GITHUB_OUTPUT

# native path for tools that don't understand /c/... style paths
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

log() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }

# Copy a project's sources (not deps/outputs/bindings) into the build dir, keeping node_modules/bin/obj
# from earlier runs so repeat runs are fast.
sync_sources() { # <src dir> <dest dir>
  mkdir -p "$2"
  (cd "$1" && find . -maxdepth 1 -mindepth 1 \
      -not -name bindings -not -name node_modules -not -name bin -not -name obj \
      -not -name '*.user' -print0) | while IFS= read -r -d '' f; do
    cp -r "$1/$f" "$2/"
  done
}

# --- steps --------------------------------------------------------------------------------
step_bindings() {
  log "Fetching region v10 schema from $BITCRAFT_SPACETIME_HOST ($BITCRAFT_REGION_MODULE)"
  rm -rf "$BIND_DIR"; mkdir -p "$BIND_DIR"
  local raw="$BIND_DIR/region_schema_v10.json"
  curl --fail -sSL "${scheme}://${BITCRAFT_SPACETIME_HOST}/v1/database/${BITCRAFT_REGION_MODULE}/schema?version=10" -o "$raw"
  # same normalisation as get-schema.sh, then wrap as tagged ModuleDef like make-bindings.sh
  jq '.sections |= map(if has("RowLevelSecurity") then .RowLevelSecurity |= sort_by(.sql) else . end)' "$raw" \
    | jq '{"V10": .}' > "$BIND_DIR/region_schema_v10.json.v10"

  # dummy dir satisfies spacetime 2.x's "buildable module exists" check (see make-bindings.sh)
  mkdir -p "$BIND_DIR/scratch/spacetimedb"
  spacetime version use "$CLI_VERSION"

  shopt -s nullglob
  local lang out
  for lang in ts cs; do
    out="$BIND_DIR/$lang"
    mkdir -p "$out"
    log "Generating $lang bindings"
    local args=( generate -y --module-def "$(native "$BIND_DIR/region_schema_v10.json.v10")"
                 --lang "$lang" --out-dir "$(native "$out/src")" --include-private )
    [ "$lang" = cs ] && args+=( --namespace BitCraftRegion.Types )
    ( cd "$BIND_DIR/scratch" && spacetime "${args[@]}" )

    local p
    for p in "$PATCHES/$lang"/*.patch "$PATCHES/$lang/region"/*.patch; do
      echo "Applying $(basename "$p")"
      git apply -v --allow-empty --unsafe-paths --directory "$(native "$out")" "$p"
    done
    [ -n "$(ls -A "$out/src" 2>/dev/null)" ] || { echo "no $lang bindings generated" >&2; exit 1; }
  done
}

step_bsatn() {
  [ -d "$BIND_DIR/ts/src" ] || { echo "run the 'bindings' step first" >&2; exit 1; }
  log "Building bsatn extractor"
  local b="$BUILD_DIR/bsatn"
  sync_sources scripts/bsatn "$b"
  rm -rf "$b/bindings"; mkdir -p "$b/bindings"; cp -r "$BIND_DIR/ts/src" "$b/bindings/src"
  ( cd "$b" && npm ci --no-audit --no-fund )
  log "Running bsatn extractor"
  rm -rf "$DATA_BSATN"; mkdir -p "$DATA_BSATN"
  ( cd "$b" && DATA_DIR="$(native "$DATA_BSATN")" npm exec tsx gamedata-bsatn.ts )
  local n; n=$(ls "$DATA_BSATN" | wc -l)
  [ "$n" -gt 0 ] || { echo "bsatn extractor wrote no files" >&2; exit 1; }
  echo "bsatn: $n files"
}

step_cereal_cs() {
  [ -d "$BIND_DIR/cs/src" ] || { echo "run the 'bindings' step first" >&2; exit 1; }
  log "Running cereal-cs extractor"
  local b="$BUILD_DIR/cereal-cs"
  sync_sources scripts/cereal-cs "$b"
  rm -rf "$b/bindings"; mkdir -p "$b/bindings"; cp -r "$BIND_DIR/cs/src" "$b/bindings/src"
  rm -rf "$DATA_CS"; mkdir -p "$DATA_CS"
  ( cd "$b" && DATA_DIR="$(native "$DATA_CS")" dotnet run --project cereal-cs.csproj )
  # Program.cs swallows exceptions, so verify the output instead of trusting the exit code
  [ -f "$DATA_CS/region_schema.json" ] && [ -n "$(ls -A "$DATA_CS/static" 2>/dev/null)" ] \
    || { echo "cereal-cs produced no data (see output above)" >&2; exit 1; }
  echo "cereal-cs: $(ls "$DATA_CS/static" | wc -l) files"
}

step_brico() {
  [ -d "$DATA_BSATN" ] && [ -d "$BIND_DIR/ts/src" ] || { echo "run bindings + bsatn first" >&2; exit 1; }
  log "Updating $BRICO_DIR"
  # NOTE: both targets are git submodules in brico (BitCraft_BSATN_Data / BitCraft_Bindings);
  # this only modifies their working trees. Don't commit/push from them.
  local pub="$BRICO_DIR/frontend/public/bsatn/static"
  rm -rf "$pub"; mkdir -p "$pub"; cp -r "$DATA_BSATN"/. "$pub"/
  local up="$BRICO_DIR/common/bitcraft-bindings/upstream/src"
  rm -rf "$up"; mkdir -p "$up"; cp -r "$BIND_DIR/ts/src"/. "$up"/
  echo "bsatn data -> $pub"
  echo "ts bindings -> $up"
}

step_cereal() {
  [ -d "$DATA_CS/static" ] || { echo "run cereal-cs first" >&2; exit 1; }
  log "Updating $CEREAL_DATA_DIR"
  # same naming as cereal's update-data.yml: data/YYYY-MM-DD, then -2, -3, ... for repeats
  local today target n=1 d
  today=$(date -u +%Y-%m-%d)
  target="$today"
  if [ -d "$CEREAL_DATA_DIR/data/$today" ]; then
    for d in "$CEREAL_DATA_DIR/data/$today"-*; do
      [ -d "$d" ] || continue
      d=${d##*-}; [[ "$d" =~ ^[0-9]+$ ]] && [ "$d" -gt "$n" ] && n=$d
    done
    target="$today-$((n + 1))"
  fi
  mkdir -p "$CEREAL_DATA_DIR/data/$target"
  cp -r "$DATA_CS/static" "$CEREAL_DATA_DIR/data/$target/"
  cp "$DATA_CS/region_schema.json" "$CEREAL_DATA_DIR/data/$target/"
  echo "cereal data -> data/$target"
  ( cd "$CEREAL_DIR" && npx tsx scripts/update-versions.ts --root-dir "$(native "$CEREAL_DATA_DIR")" )
}

# --- main ---------------------------------------------------------------------------------
steps=("$@")
[ ${#steps[@]} -gt 0 ] || steps=(bindings bsatn cereal-cs brico cereal)
for s in "${steps[@]}"; do
  case "$s" in
    bindings)  step_bindings ;;
    bsatn)     step_bsatn ;;
    cereal-cs) step_cereal_cs ;;
    brico)     step_brico ;;
    cereal)    step_cereal ;;
    *) echo "unknown step: $s" >&2; exit 2 ;;
  esac
done
log "Done: ${steps[*]}"
