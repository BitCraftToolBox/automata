// Resolves the "clean" prefab game-data fields listed in wanted_prefabs.json against the
// prefab map produced by read-asset-catalog.ts, compresses the matching AssetRipper-exported
// .glb files, and writes them into the BitCraft_Models checkout. Replaces the sprite pipeline's
// build_gamedata_paths.sh + map_and_convert_assets.sh pair with a single script, since prefab
// fields need per-field prefix handling (Prefabs/, Interiors/, bare GUID) that doesn't fit the
// sprite pipeline's one-field-per-table jq approach.
//
// Output paths mirror the raw game-data field value exactly (e.g. "Buildings/CampForge5" or a
// bare GUID), not the internal catalog key or ripped filename, so a consumer holding a
// model_asset_name-style value can fetch it directly at <BitCraft_Models>/<value>.glb.
//
// Compression is deliberately narrow: only texture recompression (WebP) and geometry/animation
// re-encoding (Meshopt, via the `webp`/`meshopt` commands, not the `optimize` meta-command).
// `optimize` also joins/flattens the scene graph, instances shared meshes, and palettes
// materials — all of which rename or merge nodes and materials. The model viewer keys its
// render-quirk toggles off the original Unity node and material names
// (LOD/collider/VFX subtree matches, water/foam/foliage material matches),
// so anything that touches those names or the scene hierarchy would break it. WebP + Meshopt
// change only how texel and vertex data are encoded on disk — same node names, same material
// names, same primitive/vertex counts, verified against a real ripped file before adopting this.

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as os from "os";
import * as crypto from "crypto";

const workspaceDir = path.resolve(__dirname, "../../workspace/assets");
const gameDataDir = path.join(workspaceDir, "game-data/static");
const extractedPrefabDir = path.join(workspaceDir, "extracted/Assets/PrefabHierarchyObject");
const prefabCatalogFile = path.join(workspaceDir, "prefabs.json");
const outputDir = path.join(workspaceDir, "models");

// Not require.resolve()'d: @gltf-transform/cli's package.json "exports" map only exposes its
// ESM entrypoint, not the bin script, so subpath resolution fails even though the file exists.
const gltfTransformBin = path.join(__dirname, "node_modules", "@gltf-transform", "cli", "bin", "cli.js");

interface WantedPrefabField {
  table: string;
  field: string;
  // Catalog key prefix to prepend to the game-data value, e.g. "Prefabs" for
  // model_asset_name-style fields or "Interiors" for interior_model. Empty string for
  // fields that already store the full catalog key (bare GUIDs).
  prefix: string;
}

const wanted: WantedPrefabField[] = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "wanted_prefabs.json"), "utf8")
);

const catalog: Record<string, string> = JSON.parse(fs.readFileSync(prefabCatalogFile, "utf8"));

const rippedFiles = new Map<string, string>();
for (const f of fs.readdirSync(extractedPrefabDir)) {
  rippedFiles.set(f.toLowerCase(), f);
}

// outputRelPath (the raw field value, "/"-separated) -> internalId, so we can catch two
// different game-data values that happen to collide on the same output path.
const resolved = new Map<string, string>();
const unresolvedKeys = new Set<string>();

for (const { table, field, prefix } of wanted) {
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
      if (typeof value !== "string" || value === "") continue;

      const key = prefix ? `${prefix}/${value}` : value;
      const internalId = catalog[key];
      if (!internalId) {
        unresolvedKeys.add(`${table}.${field}: ${key}`);
        continue;
      }

      const existing = resolved.get(value);
      if (existing !== undefined && existing !== internalId) {
        console.warn(`Output path collision: "${value}" resolves to both ${existing} and ${internalId}`);
        continue;
      }
      resolved.set(value, internalId);
    }
  }
}

function compress(sourcePath: string, destPath: string, tmpDir: string) {
  const afterWebp = path.join(tmpDir, "webp.glb");
  execFileSync(process.execPath, [gltfTransformBin, "webp", sourcePath, afterWebp, "--quality", "90"]);
  execFileSync(process.execPath, [gltfTransformBin, "meshopt", afterWebp, destPath]);
  fs.rmSync(afterWebp, { force: true });
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
}

// Manifest lives inside the BitCraft_Models checkout so it's committed alongside the outputs it
// describes and is available on the next run, to skip re-running compression (webp + meshopt) on
// files whose ripped source hasn't changed since the last run.
const manifestFile = path.join(outputDir, "manifest_prefabs.json");
const prevHashes: Record<string, string> = fs.existsSync(manifestFile)
  ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  : {};
const nextHashes: Record<string, string> = {};

let copied = 0;
let unchanged = 0;
let missingOnDisk = 0;
let compressFailed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-prefabs-"));
const totalResolved = resolved.size;

for (const [value, internalId] of resolved) {
  const base = path.basename(internalId, path.extname(internalId));
  const rippedName = rippedFiles.get(`${base.toLowerCase()}.glb`);
  if (!rippedName) {
    console.warn(`No ripped .glb for "${value}" -> ${internalId}`);
    missingOnDisk++;
    continue;
  }

  const outputPath = path.join(outputDir, `${value}.glb`);
  const sourcePath = path.join(extractedPrefabDir, rippedName);
  const hash = hashFile(sourcePath);

  if (prevHashes[value] === hash && fs.existsSync(outputPath)) {
    nextHashes[value] = hash;
    unchanged++;
    continue;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    compress(sourcePath, outputPath, tmpDir);
  } catch (err) {
    console.warn(`Compression failed for "${value}" -> ${internalId}, copying uncompressed: ${err}`);
    fs.copyFileSync(sourcePath, outputPath);
    compressFailed++;
  }
  nextHashes[value] = hash;
  copied++;
  if (copied % 100 === 0) {
    console.log(`Copied ${copied} / ${totalResolved}.`);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.writeFileSync(manifestFile, JSON.stringify(nextHashes, null, 2) + "\n");

console.log(`Resolved ${resolved.size} unique prefabs from game data.`);
console.log(`Copied ${copied} .glb files to ${outputDir} (${unchanged} unchanged, skipped).`);
if (compressFailed > 0) {
  console.warn(`${compressFailed} files were copied uncompressed after a compression failure.`);
}
if (unresolvedKeys.size > 0) {
  console.warn(`${unresolvedKeys.size} game-data values did not resolve to a catalog entry:`);
  for (const k of unresolvedKeys) console.warn(`  ${k}`);
}
if (missingOnDisk > 0) {
  console.warn(`${missingOnDisk} resolved catalog entries had no matching ripped .glb file.`);
}
