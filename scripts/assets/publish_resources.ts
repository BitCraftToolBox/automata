// Publishes resource models. Input: resource_desc.model_asset_name (wanted_resources.json), the
// name of a ResourceModels ScriptableObject at catalog key `ScriptableObjects/<value>`. Output:
// the asset's `available` prefab at `<value>.glb`. See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import { only, projectDir, requireProjectExport, scriptableObjectCatalogFile } from "./lib/env";
import { readWanted, wantedValues, WantedField } from "./lib/gamedata";
import { isNullRef, readScriptableObject, refToPath } from "./lib/unity";
import { publishPrefabSet } from "./lib/prefab";

requireProjectExport();
const wanted = readWanted<WantedField>("wanted_resources.json");
const catalog: Record<string, { id: string; type: string }> = JSON.parse(fs.readFileSync(scriptableObjectCatalogFile, "utf8"));

const items = new Map<string, string>();
const seen = new Set<string>();
const unresolved = new Set<string>();
let noModel = 0;

for (const { entry, value } of wantedValues(wanted)) {
  if (seen.has(value) || (only && !value.includes(only))) continue;
  seen.add(value);
  const catalogKey = `ScriptableObjects/${value}`;
  const asset = catalog[catalogKey];
  if (asset?.type !== "ResourceModels") {
    unresolved.add(`${entry.table}.${entry.field}: ${value} (no ResourceModels catalog entry for "${catalogKey}")`);
    continue;
  }
  const assetFile = path.join(projectDir, asset.id);
  if (!fs.existsSync(assetFile)) {
    unresolved.add(`${entry.table}.${entry.field}: ${value} -> catalog points at missing file ${asset.id}`);
    continue;
  }
  const available = readScriptableObject(assetFile).available;
  if (!available || isNullRef(available)) {
    noModel++;
    continue;
  }
  const prefabFile = refToPath(available);
  if (prefabFile) items.set(value, prefabFile);
  else unresolved.add(`${entry.table}.${entry.field}: ${value} -> available GUID ${available.guid} not in the Unity export`);
}

(async () => {
  await publishPrefabSet("resources", items);
  console.log(`Resolved ${seen.size} resources from game data (${noModel} without a model).`);
  if (unresolved.size > 0) {
    console.warn(`${unresolved.size} game-data values did not resolve:`);
    for (const n of unresolved) console.warn(`  ${n}`);
  }
})();
