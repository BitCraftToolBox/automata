// Publishes hand equipment models. Input: equipment_desc.hand_equipment_visual.prefab_names, GUIDs
// of EquipmentMeshAndMaterials ScriptableObjects. Output: `<guid>.glb`, a rigged part
// (lib/rig.ts). See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import { gameDataDir, only, projectDir, requireProjectExport, scriptableObjectCatalogFile } from "./lib/env";
import { guidClosure, isNullRef, readScriptableObject, readScriptableObjectByRef, Ref } from "./lib/unity";
import { MaterialContext, reportUnresolvedShaders } from "./lib/materials";
import { Fingerprint, Manifest, writeModel } from "./lib/gltf";
import { addSkinnedMesh, newRiggedPart, playerRig } from "./lib/rig";

requireProjectExport();
const catalog: Record<string, { id: string; type: string }> = JSON.parse(fs.readFileSync(scriptableObjectCatalogFile, "utf8"));
const rows = JSON.parse(fs.readFileSync(path.join(gameDataDir, "equipment_desc.json"), "utf8"));
const guids = new Set<string>();
for (const row of rows) {
  for (const g of row.hand_equipment_visual?.prefab_names ?? []) if (typeof g === "string" && /^[0-9a-f]{32}$/.test(g)) guids.add(g);
}

(async () => {
  const manifest = new Manifest("equipment");
  const rigFiles = (await playerRig()).files;
  let built = 0, unchanged = 0, failed = 0;
  const unresolved: string[] = [];
  const todo = [...guids].filter((g) => !only || g.includes(only));

  for (const guid of todo) {
    // Game-data GUIDs are the original project GUIDs, which only the catalog knows; the Unity
    // Project export assigns its own.
    const entry = catalog[guid];
    const assetFile = entry?.type === "EquipmentMeshAndMaterials" ? path.join(projectDir, entry.id) : undefined;
    if (!assetFile || !fs.existsSync(assetFile)) {
      unresolved.push(guid);
      continue;
    }
    const relFile = `${guid}.glb`;
    const pre = new Fingerprint().addValue(guid);
    for (const f of [...guidClosure(assetFile), ...rigFiles]) pre.addFile(f);
    const inputs = pre.digest();
    if (manifest.upToDate(guid, relFile, inputs)) {
      unchanged++;
      continue;
    }

    try {
      const so = readScriptableObject(assetFile);
      const meshTypeAsset = readScriptableObjectByRef(so.meshType?.obj);
      const part = await newRiggedPart(guid);
      const ctx = new MaterialContext(part.doc);
      const res = so.mesh && !isNullRef(so.mesh) ? await addSkinnedMesh(part, so.mesh) : null;
      if (!res) {
        console.warn(`${guid} (${so.m_Name}): mesh not found`);
        failed++;
        continue;
      }
      // One material per submesh; a short list repeats its last entry.
      const materials: Ref[] = so.materials ?? [];
      for (const [i, prim] of res.primitives.entries()) {
        const ref = materials[Math.min(i, materials.length - 1)];
        if (ref?.guid) await ctx.assign(prim, ref.guid);
      }
      part.root.setExtras({ unity: { kind: "equipment", name: so.m_Name, meshType: meshTypeAsset?.meshTypeName ?? null } });
      await writeModel(part.doc, relFile);
      manifest.record(guid, relFile, inputs);
      built++;
      if (built % 50 === 0) console.log(`Built ${built} / ${todo.length}.`);
    } catch (err) {
      console.warn(`${guid}: build failed: ${(err as Error).stack ?? err}`);
      failed++;
    }
  }

  manifest.finish();
  console.log(`Equipment: ${built} built, ${unchanged} unchanged, ${failed} failed, of ${todo.length} unique GUIDs.`);
  if (unresolved.length) console.warn(`${unresolved.length} GUIDs did not resolve to an EquipmentMeshAndMaterials asset:\n  ${unresolved.join("\n  ")}`);
  reportUnresolvedShaders();
})();
