// Publishes hex tile templates. Input: pillar_shaping_desc.prefab_address (wanted_hextiles.json),
// the catalog key of a BitCraft.Tools.HexTileTemplate. Output: `<value>.glb` holding every column
// prefab as an alternative. See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import { only, projectDir, requireProjectExport, scriptableObjectCatalogFile } from "./lib/env";
import { readWanted, wantedValues, WantedField } from "./lib/gamedata";
import { guidClosure, readScriptableObject, refToPath } from "./lib/unity";
import { Fingerprint, Manifest, newDocument, writeModel } from "./lib/gltf";
import { reportUnresolvedShaders } from "./lib/materials";
import { describeStats, emptyStats, inlinePrefab } from "./lib/prefab";

const TEMPLATE_TYPE = "BitCraft.Tools.HexTileTemplate";
requireProjectExport();
const catalog: Record<string, { id: string; type: string }> = JSON.parse(fs.readFileSync(scriptableObjectCatalogFile, "utf8"));

const values = new Set<string>();
const unresolved = new Set<string>();
for (const { entry, value } of wantedValues(readWanted<WantedField>("wanted_hextiles.json"))) {
  if (only && !value.includes(only)) continue;
  if (catalog[value]?.type === TEMPLATE_TYPE) values.add(value);
  else unresolved.add(`${entry.table}.${entry.field}: ${value}`);
}

(async () => {
  const manifest = new Manifest("hextiles");
  const stats = emptyStats();
  let built = 0, unchanged = 0, failed = 0, missingColumns = 0;

  for (const value of values) {
    const assetFile = path.join(projectDir, catalog[value].id);
    const relFile = `${value}.glb`;
    if (!fs.existsSync(assetFile)) {
      console.warn(`${value}: catalog points at missing file ${catalog[value].id}`);
      failed++;
      continue;
    }
    const pre = new Fingerprint().addValue(value);
    for (const f of guidClosure(assetFile)) pre.addFile(f);
    const inputs = pre.digest();
    if (manifest.upToDate(value, relFile, inputs)) {
      unchanged++;
      continue;
    }

    try {
      const so = readScriptableObject(assetFile);
      const doc = newDocument();
      const root = doc.createNode(path.basename(value));
      doc.createScene(path.basename(value)).addChild(root);
      const columns = [
        ...(so._stackingColumns ?? []).map((c: any) => ({ kind: "stack", prefab: c._prefab, height: c._height, climbableSides: c._climbableSides })),
        ...(so._scalingColumns ?? []).map((c: any) => ({ kind: "scale", prefab: c._prefab, heightRange: [c._heightRange?.x, c._heightRange?.y], climbableSides: c._climbableSides })),
      ];
      let index = 0;
      for (const { prefab, ...info } of columns) {
        const prefabFile = refToPath(prefab);
        const wrapper = await inlinePrefab(doc, root, prefabFile, `Column_${index}`, 1, stats);
        if (!wrapper) {
          console.warn(`${value}: column prefab ${prefab?.guid} not found`);
          missingColumns++;
          continue;
        }
        wrapper.setExtras({
          unity: {
            columnVariant: { index, ...info, prefab: path.basename(prefabFile!, path.extname(prefabFile!)) },
            ...(index > 0 ? { active: false } : {}),
          },
        });
        index++;
      }
      if (!index) {
        console.warn(`${value}: no columns`);
        failed++;
        continue;
      }
      root.setExtras({ unity: { kind: "hexTileTemplate", columns: index } });
      await writeModel(doc, relFile);
      manifest.record(value, relFile, inputs);
      built++;
    } catch (err) {
      console.warn(`${value}: build failed: ${(err as Error).stack ?? err}`);
      failed++;
    }
  }

  manifest.finish();
  console.log(`Hex tile templates: ${built} built, ${unchanged} unchanged, ${failed} failed, of ${values.size}; ${missingColumns} column prefabs missing.`);
  console.log(`  ${describeStats(stats)}`);
  if (unresolved.size) console.warn(`${unresolved.size} values did not resolve to a hex tile template:\n  ${[...unresolved].join("\n  ")}`);
  reportUnresolvedShaders();
})();
