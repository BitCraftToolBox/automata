// Resolves resource game-data fields (resource_desc.model_asset_name) against ResourceModels
// ScriptableObject assets. These aren't reachable through the addressables-catalog-based prefab
// pipeline (publish_prefabs.ts) as-is, because that pipeline only indexes GameObject-typed catalog
// entries: AssetRipper's primary content export never converts MonoBehaviour-derived
// ScriptableObjects, so the `available` GameObject reference baked into each ResourceModels
// .asset (see ResourceModels.cs) only exists in AssetRipper's full Unity Project export (YAML
// .asset/.meta files) -- a separate, much larger export that unity-asset-ripper.js triggers after
// the primary content export.
//
// Only the default `available` model is published -- see PREFABS_TODO.md's Resources section for
// why `depleted` (almost always an invisible placeholder, and even where it isn't, a separate
// resource_desc row via on_destroy_yield_resource_id is the one actually shown in-game) and
// `biomeOverrides` (2 resources total right now) aren't worth the extra output paths yet.
//
// Pipeline:
//   1. Resolve each wanted resource's catalog key ("ScriptableObjects/" + the raw game-data value,
//      e.g. "ScriptableObjects/Resources/Sticks") against resources.json (emitted by
//      read-asset-catalog.ts, same idea as prefabs.json but for ResourceModels-typed entries) to
//      get the asset's actual project path. This step is load-bearing, not a formality: a
//      resource's addressable name frequently does *not* match its .asset file's own basename
//      (e.g. key ".../T9Baitfish" -> file "SchoolOfT9Baitfish.asset"; key
//      ".../ResourceSharedOreT1Small" -> file "ResourcesSharedOreT1Small.asset"), so resolving by
//      searching the GameResources folder for a same-named file (what an earlier version of this
//      script did) silently missed roughly a third of all resources.
//   2. Parse that asset's `available` GUID reference straight out of the YAML text -- no YAML
//      parser needed, the shape is fixed (it's a straight dump of ResourceModels.cs's fields). A
//      `{fileID: 0}` reference (no guid) means "no model" and is skipped.
//   3. Resolve the GUID to its asset's file name via a GUID -> file index built by scanning every
//      .meta file's `guid:` line under the Unity Project export (every Unity asset gets one).
//   4. Look up that file's basename in the ripped PrefabHierarchyObject/ .glb files (same as
//      publish_prefabs.ts) and compress/write it into the BitCraft_Models checkout.
//
// Output path is the raw model_asset_name value verbatim, e.g. "Resources/Sticks.glb" -- same
// convention as publish_prefabs.ts.
//
// The Unity Project export is deleted as soon as this script has resolved every GUID it needs --
// it's roughly 2x the size of the primary content export and has no other use downstream.

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as os from "os";
import * as crypto from "crypto";

const workspaceDir = path.resolve(__dirname, "../../workspace/assets");
const gameDataDir = path.join(workspaceDir, "game-data/static");
const extractedPrefabDir = path.join(workspaceDir, "extracted/Assets/PrefabHierarchyObject");
const unityProjectDir = path.join(workspaceDir, "extracted-project");
const unityProjectAssetsDir = path.join(unityProjectDir, "ExportedProject/Assets");
const resourceCatalogFile = path.join(workspaceDir, "resources.json");
const outputDir = path.join(workspaceDir, "models");

// Not require.resolve()'d: see the matching comment in publish_prefabs.ts.
const gltfTransformBin = path.join(__dirname, "node_modules", "@gltf-transform", "cli", "bin", "cli.js");

// For local investigation only (never pass this in CI): skips the webp/meshopt compression pass
// and just copies the ripped .glb as-is, so a full run enumerates resolved files in seconds
// instead of minutes of gltf-transform subprocess spawns.
const skipOpt = process.argv.includes("--skip-opt");

interface WantedResourceField {
  table: string;
  field: string;
}

const wanted: WantedResourceField[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "wanted_resources.json"), "utf8")
);

// Full catalog key -> internalId (asset's project path), ResourceModels-typed entries only.
const resourceCatalog: Record<string, string> = JSON.parse(fs.readFileSync(resourceCatalogFile, "utf8"));

function walkFiles(dir: string, extension: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, extension, out);
    else if (entry.name.endsWith(extension)) out.push(p);
  }
}

function parseAvailableGuid(text: string): string | null {
  // Anchored to exactly 2 leading spaces so this can't match a "depleted:" or biomeOverrides-
  // nested (4-space) line of the same asset.
  const match = text.match(/^  available: \{fileID: -?\d+, guid: ([0-9a-f]{32}), type: \d+\}$/m);
  return match ? match[1] : null;
}

if (!fs.existsSync(unityProjectAssetsDir)) {
  console.warn(`Unity Project export not found at ${unityProjectAssetsDir}; skipping resource publish.`);
  process.exit(0);
}

// value (raw game-data field value, e.g. "Resources/Sticks") -> available GUID.
const resourceEntries = new Map<string, string | null>();
const unresolvedNames = new Set<string>();

for (const { table, field } of wanted) {
  const tableFile = path.join(gameDataDir, `${table}.json`);
  if (!fs.existsSync(tableFile)) {
    console.warn(`Skipping ${table}.${field}: table file not found at ${tableFile}`);
    continue;
  }

  const rows = JSON.parse(fs.readFileSync(tableFile, "utf8"));
  for (const row of rows) {
    const raw = row[field];
    if (raw == null || raw === "") continue;

    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== "string" || value === "" || resourceEntries.has(value)) continue;

      const catalogKey = `ScriptableObjects/${value}`;
      const internalId = resourceCatalog[catalogKey];
      if (!internalId) {
        unresolvedNames.add(`${table}.${field}: ${value} (no catalog entry for "${catalogKey}")`);
        continue;
      }

      const assetFile = path.join(unityProjectAssetsDir, internalId.replace(/^Assets\//, ""));
      if (!fs.existsSync(assetFile)) {
        unresolvedNames.add(`${table}.${field}: ${value} -> catalog points at missing file ${internalId}`);
        continue;
      }

      resourceEntries.set(value, parseAvailableGuid(fs.readFileSync(assetFile, "utf8")));
    }
  }
}

const wantedGuids = new Set<string>();
for (const guid of resourceEntries.values()) {
  if (guid) wantedGuids.add(guid);
}

// GUID -> the Unity asset file that GUID belongs to (its .meta sibling, minus ".meta").
const guidToAssetFile = new Map<string, string>();
if (wantedGuids.size > 0) {
  const metaFiles: string[] = [];
  walkFiles(unityProjectAssetsDir, ".meta", metaFiles);
  for (const metaFile of metaFiles) {
    const text = fs.readFileSync(metaFile, "utf8");
    const m = text.match(/^guid: ([0-9a-f]{32})/m);
    if (m && wantedGuids.has(m[1]) && !guidToAssetFile.has(m[1])) {
      guidToAssetFile.set(m[1], metaFile.slice(0, -".meta".length));
    }
  }
}

// Done reading from the Unity Project export -- free the disk space before the compression pass.
fs.rmSync(unityProjectDir, { recursive: true, force: true });

const rippedFiles = new Map<string, string>();
for (const f of fs.readdirSync(extractedPrefabDir)) {
  rippedFiles.set(f.toLowerCase(), f);
}

function compress(sourcePath: string, destPath: string, tmpDir: string) {
  if (skipOpt) {
    fs.copyFileSync(sourcePath, destPath);
    return;
  }
  const afterWebp = path.join(tmpDir, "webp.glb");
  execFileSync(process.execPath, [gltfTransformBin, "webp", sourcePath, afterWebp, "--quality", "90"]);
  execFileSync(process.execPath, [gltfTransformBin, "meshopt", afterWebp, destPath]);
  fs.rmSync(afterWebp, { force: true });
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

const manifestFile = path.join(outputDir, "manifest_resources.json");
const prevHashes: Record<string, string> = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  : {};
const nextHashes: Record<string, string> = {};

let copied = 0;
let unchanged = 0;
let missingOnDisk = 0;
let compressFailed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-resources-"));
const missingGuids = new Set<string>();
const totalEntries = resourceEntries.size;

for (const [value, guid] of resourceEntries) {
  if (!guid) continue; // no "available" model for this resource -- nothing to publish

  const assetFile = guidToAssetFile.get(guid);
  if (!assetFile) {
    missingGuids.add(guid);
    missingOnDisk++;
    continue;
  }

  const base = path.basename(assetFile, path.extname(assetFile));
  const rippedName = rippedFiles.get(`${base.toLowerCase()}.glb`);
  if (!rippedName) {
    console.warn(`No ripped .glb for "${value}" -> ${assetFile}`);
    missingOnDisk++;
    continue;
  }

  const outputFile = path.join(outputDir, `${value}.glb`);
  const sourcePath = path.join(extractedPrefabDir, rippedName);
  const hash = hashFile(sourcePath);

  if (prevHashes[value] === hash && fs.existsSync(outputFile)) {
    nextHashes[value] = hash;
    unchanged++;
    continue;
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  try {
    compress(sourcePath, outputFile, tmpDir);
  } catch (err) {
    console.warn(`Compression failed for "${value}" -> ${assetFile}, copying uncompressed: ${err}`);
    fs.copyFileSync(sourcePath, outputFile);
    compressFailed++;
  }
  nextHashes[value] = hash;
  copied++;
  if (copied % 100 === 0) {
    console.log(`Copied ${copied} / ${totalEntries}.`);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.writeFileSync(manifestFile, JSON.stringify(nextHashes, null, 2) + "\n");

console.log(`Resolved ${resourceEntries.size} resources from game data.`);
console.log(`Copied ${copied} .glb files to ${outputDir} (${unchanged} unchanged, skipped).`);
if (compressFailed > 0) {
  console.warn(`${compressFailed} files were copied uncompressed after a compression failure.`);
}
if (unresolvedNames.size > 0) {
  console.warn(`${unresolvedNames.size} game-data values did not resolve to a ResourceModels asset:`);
  for (const n of unresolvedNames) console.warn(`  ${n}`);
}
if (missingGuids.size > 0) {
  console.warn(`${missingGuids.size} referenced GUIDs did not resolve to a Unity asset file:`);
  for (const g of missingGuids) console.warn(`  ${g}`);
}
if (missingOnDisk > 0) {
  console.warn(`${missingOnDisk} resolved assets had no matching ripped .glb file.`);
}
