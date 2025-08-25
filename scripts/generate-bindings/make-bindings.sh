#!/usr/bin/env bash

if [ -f .env.local ]; then
    source .env.local
fi

working_dir=${DATA_DIR:-workspace/bindings}

# Add version 9 indicator for SpaceTime's ModuleDef deserialization
for module in global region; do
  json="${working_dir}"/${module}_schema.json
  jq '{"V9": .}' "$json" > "${json}".v9
done

for lang in cs rs ts; do
  for module in global region; do
    args=()
    args+=( 'generate' )
    args+=( '-y' )
    args+=( '--module-def' )
    args+=( "${working_dir}"/"${module}"_schema.json.v9 )
    args+=( '--lang' )
    args+=( "$lang" )
    args+=( '--out-dir' )
    args+=( "${working_dir}/${lang}/${module}/src" )
    if [ "$lang" = "cs" ]; then
        args+=( '--namespace' )
        args+=( "BitCraft$(echo "$module" | sed 's/./\u&/').Types" )
    fi
    spacetime "${args[@]}" \
      && find "${working_dir}/$lang/$module/src" -type f -print0 | \
           xargs -0 sed -i '/\/\/ This was generated using spacetimedb cli version/d' \
      &
  done
done

wait

shopt -s nullglob
for lang in cs rs ts; do
  for module in global region; do
    # apply language-specific patches
    [ -d scripts/generate-bindings/patches/$lang ] && \
      for p in scripts/generate-bindings/patches/"$lang"/*.patch; do
        echo "Applying $p to ${working_dir}/$lang/$module"
        git apply -v --allow-empty --unsafe-paths --directory "${working_dir}"/$lang/$module "$p"
      done

    # apply language- and module- specific patches
    [ -d scripts/generate-bindings/patches/$lang/$module ] && \
      for p in scripts/generate-bindings/patches/"$lang"/"$module"/*.patch; do
        echo "Applying $p to ${working_dir}/$lang/$module"
        git apply -v --allow-empty --unsafe-paths --directory "${working_dir}"/$lang/$module "$p"
      done
  done
done

# TODO for some reason this patch is bork. figure it out some other time, for now we do it manually
for module in global region; do
  mv "${working_dir}"/rs/${module}/src/mod.rs "${working_dir}"/rs/${module}/src/lib.rs
done