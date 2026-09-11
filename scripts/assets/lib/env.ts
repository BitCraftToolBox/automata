// Filesystem locations and CLI flags shared by the model publishers. Defaults match the CI layout
// (cwd = workspace/assets); the environment variable beside each path overrides it.

import * as fs from "fs";
import * as path from "path";

/** ASSETS_WORKSPACE */
export const workspaceDir = path.resolve(process.env.ASSETS_WORKSPACE ?? path.resolve(__dirname, "../../../workspace/assets"));

/** Parsed shader JSON written by unity-asset-ripper.js, one `<name>.json` per shader (SHADER_DIR). */
export const shaderDir = path.resolve(process.env.SHADER_DIR ?? path.join(workspaceDir, "extracted-shaders"));

/** AssetRipper Unity Project export root, YAML `.asset`/`.meta` pairs (PROJECT_DIR). */
export const projectDir = path.resolve(process.env.PROJECT_DIR ?? path.join(workspaceDir, "extracted-project/ExportedProject"));
export const projectAssetsDir = path.join(projectDir, "Assets");

/** GAMEDATA_DIR */
export const gameDataDir = path.resolve(process.env.GAMEDATA_DIR ?? path.join(workspaceDir, "game-data/static"));
/** MODELS_DIR */
export const modelsDir = path.resolve(process.env.MODELS_DIR ?? path.join(workspaceDir, "models"));

/** Catalog lookups written by read-asset-catalog.ts. */
export const prefabCatalogFile = path.join(workspaceDir, "prefabs.json");
export const scriptableObjectCatalogFile = path.join(workspaceDir, "scriptable_objects.json");

/** `--skip-opt`: skip WebP/Meshopt compression. Local investigation only; never used in CI. */
export const skipOpt = process.argv.includes("--skip-opt");
/** `--force`: ignore input fingerprints and rebuild everything. */
export const force = process.argv.includes("--force");
/** `--only=<substr>`: restrict a run to output keys containing the substring. */
export const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

/**
 * Every publisher reads the Unity Project export and the saved shader JSON; without them prefabs
 * would silently lose their materials or their blend and depth state.
 */
export function requireProjectExport() {
  if (!fs.existsSync(projectAssetsDir)) throw new Error(`Unity Project export not found at ${projectAssetsDir}`);
  if (!fs.existsSync(shaderDir) || !fs.readdirSync(shaderDir).some((f) => f.endsWith(".json"))) throw new Error(`No shader JSON found in ${shaderDir}`);
}
