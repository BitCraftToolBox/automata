#!/usr/bin/env bash
set -e

if [ -f .env.local ]; then
    source .env.local
fi

mkdir -p "${DATA_DIR:-workspace/bindings}"
working_dir=$(cd "${DATA_DIR:-workspace/bindings}" && pwd)
bindings_repo_url=${BINDINGS_REPO_URL:-https://github.com/BitCraftToolBox/BitCraft_Bindings.git}
repo_dir="${working_dir}/bindings-repo"
scratch_dir="${working_dir}/generate-scratch"
patches_root="scripts/generate-bindings/patches"

git_user_name=${GIT_USER_NAME:-github-actions[bot]}
git_user_email=${GIT_USER_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}

shopt -s nullglob

# Wrap schemas for SpacetimeDB's tagged ModuleDef deserialization.
for module in global region; do
  base="${working_dir}/${module}_schema.json"
  jq '{"V9": .}' "$base" > "${base}.v9"
  jq '{"V9": del(.misc_exports[])}' "$base" > "${base}.v9-viewless"

  base10="${working_dir}/${module}_schema_v10.json"
  jq '{"V10": .}' "$base10" > "${base10}.v10"
done

# spacetime 2.x's `generate` hides --module-def from --help and only reaches
# it once an unrelated "does a buildable module exist" check passes. A dummy
# spacetimedb/ directory in the generate cwd satisfies that check without
# spacetime ever looking inside it. This is undocumented CLI behavior, not a
# supported interface - if a future spacetime release removes --module-def
# for real, generation below will fail loudly rather than silently.
mkdir -p "${scratch_dir}/spacetimedb"

# In CI, the workflow already checked $repo_dir out via actions/checkout,
# which leaves it authenticated (credentials persisted in local git config)
# for both fetch and push without us handling tokens/URLs here. For local
# runs where that hasn't happened, fall back to a plain (unauthenticated)
# clone - fine for iterating on generation, though push will then fail
# without credentials of your own.
if [ ! -d "${repo_dir}/.git" ]; then
  git clone --quiet "$bindings_repo_url" "$repo_dir"
fi
git -C "$repo_dir" fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*'
git -C "$repo_dir" config user.name "$git_user_name"
git -C "$repo_dir" config user.email "$git_user_email"
git -C "$repo_dir" config commit.gpgsign false

declare -A cli_version=(
  [v1-ts]=1.3.0  [v1-rs]=1.12.0 [v1-cs]=1.12.0
  [v2-ts]=2.10.0 [v2-rs]=2.10.0 [v2-cs]=2.10.0
)
declare -A branch_suffix=( [v1]='' [v2]='-2' )

changed_branches=()

for version in v1 v2; do
  for lang in cs rs ts; do
    for module in global region; do
      branch="${lang}-${module}${branch_suffix[$version]}"

      if [ "$version" = "v1" ] && [ "$lang" = "ts" ]; then
        module_def="${working_dir}/${module}_schema.json.v9-viewless"
      elif [ "$version" = "v1" ]; then
        module_def="${working_dir}/${module}_schema.json.v9"
      else
        module_def="${working_dir}/${module}_schema_v10.json.v10"
      fi

      echo "=== Generating $lang/$module ($version) -> $branch ==="

      if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
        git -C "$repo_dir" checkout --quiet -B "$branch" "origin/${branch}"
      else
        git -C "$repo_dir" checkout --quiet --orphan "$branch"
      fi
      git -C "$repo_dir" rm -rf --quiet . >/dev/null 2>&1 || true
      find "$repo_dir" -mindepth 1 -not -path "${repo_dir}/.git*" -delete

      args=( generate -y --module-def "$module_def" --lang "$lang" --out-dir "${repo_dir}/src" )
      if [ "$lang" = "cs" ]; then
        args+=( --namespace "BitCraft$(echo "$module" | sed 's/./\u&/').Types" )
      fi
      if [ "$version" = "v2" ]; then
        # 2.x defaults to excluding private tables/reducers; v1 has never
        # filtered these out, so match that behavior for parity.
        args+=( --include-private )
      fi

      spacetime version use "${cli_version[${version}-${lang}]}"
      ( cd "$scratch_dir" && spacetime "${args[@]}" )

      # apply language-specific patches
      for p in "${patches_root}/${version}/${lang}"/*.patch; do
        echo "Applying $p to $repo_dir"
        git apply -v --allow-empty --unsafe-paths --directory "$repo_dir" "$p"
      done

      # apply language- and module-specific patches
      for p in "${patches_root}/${version}/${lang}/${module}"/*.patch; do
        echo "Applying $p to $repo_dir"
        git apply -v --allow-empty --unsafe-paths --directory "$repo_dir" "$p"
      done

      if [ "$lang" = "rs" ]; then
        # TODO for some reason this patch is bork. figure it out some other time, for now we do it manually
        mv "${repo_dir}/src/mod.rs" "${repo_dir}/src/lib.rs"
      fi

      git -C "$repo_dir" add -A
      if ! git -C "$repo_dir" diff --cached --quiet; then
        if git -C "$repo_dir" rev-parse --quiet --verify HEAD >/dev/null 2>&1; then
          git -C "$repo_dir" commit --quiet -m "Update bindings: $(date +%Y-%m-%d)"
        else
          git -C "$repo_dir" commit --quiet -m "Initial commit: $(date +%Y-%m-%d)"
        fi
        changed_branches+=( "$branch" )
      fi
    done
  done
done

if [ "${#changed_branches[@]}" -gt 0 ]; then
  echo "Pushing changed branches: ${changed_branches[*]}"
  git -C "$repo_dir" push --quiet origin "${changed_branches[@]}"
fi
