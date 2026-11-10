// Publishes character customization parts. Input: collectible_desc.model_asset_name minus pets
// (wanted_customization.json), bare asset names resolved to catalog key
// `ScriptableObjects/Customization/<Category>/<Name>`. Output, all rigged parts (lib/rig.ts)
// except the variant lists:
//
//   Customization/<value>.glb                  one per part asset
//   Customization/Default/<collectible_type>.glb   a slot's default part (game-data value "Default")
//   Customization/DefaultBodyColor.glb         variant list: materials only
//   Customization/MaskPatterns.glb             variant list: materials only
//
// See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import { Material, Primitive } from "@gltf-transform/core";
import { only, projectDir, requireProjectExport, scriptableObjectCatalogFile } from "./lib/env";
import { readWanted, wantedValues, WantedField } from "./lib/gamedata";
import { guidClosure, isNullRef, readScriptableObject, Ref } from "./lib/unity";
import { baseTextureStats, MaterialContext, readMaterial, reportUnresolvedShaders, RuntimeFlag, TINT_MASK_SATURATION } from "./lib/materials";
import { Fingerprint, Manifest, newDocument, setVariants, writeModel } from "./lib/gltf";
import { addSkinnedMesh, newRiggedPart, playerRig } from "./lib/rig";

interface CatalogEntry {
  id: string;
  type: string;
}

interface WantedCustomizationField extends WantedField {
  /** Skips rows whose `collectible_type` is listed (pets are plain prefabs, see publish_prefabs.ts). */
  excludeTypes?: string[];
}

interface Job {
  /** Output path without extension, relative to modelsDir. */
  outKey: string;
  category: string;
  entry: CatalogEntry;
}

const PREFIX = "ScriptableObjects/Customization/";
const OUT = "Customization";

const catalog: Record<string, CatalogEntry> = JSON.parse(fs.readFileSync(scriptableObjectCatalogFile, "utf8"));

// Asset names are unique within the namespace except the per-slot "Default" assets.
const byName = new Map<string, { category: string; entry: CatalogEntry }>();
const defaults: { category: string; entry: CatalogEntry }[] = [];
for (const [key, entry] of Object.entries(catalog)) {
  if (!key.startsWith(PREFIX)) continue;
  const parts = key.slice(PREFIX.length).split("/");
  const name = parts[parts.length - 1];
  const category = parts.length > 1 ? parts[0] : "";
  if (name === "Default") defaults.push({ category, entry });
  else {
    if (byName.has(name)) console.warn(`Duplicate customization asset name "${name}" (${key}); the later entry wins`);
    byName.set(name, { category, entry });
  }
}

const jobs = new Map<string, Job>();
const unresolved = new Set<string>();
for (const { entry: field, row, value } of wantedValues(readWanted<WantedCustomizationField>("wanted_customization.json"))) {
  if (value === "Default" || field.excludeTypes?.includes(row.collectible_type)) continue;
  const hit = byName.get(value);
  if (!hit) {
    unresolved.add(`${field.table}.${field.field}: ${value} (${row.collectible_type})`);
    continue;
  }
  jobs.set(`${OUT}/${value}`, { outKey: `${OUT}/${value}`, category: hit.category, entry: hit.entry });
}
// "Default" means "this slot's default part"; its catalog folder is the collectible_type without
// the "Clothes" prefix (Mask has none).
for (const d of defaults) {
  const collectibleType = d.category === "Mask" ? "Mask" : `Clothes${d.category}`;
  const outKey = `${OUT}/Default/${collectibleType}`;
  jobs.set(outKey, { outKey, category: d.category, entry: d.entry });
}
const maskPatterns = catalog[`${PREFIX}MaskPatterns`];
if (maskPatterns?.type === "VariantList") jobs.set(`${OUT}/MaskPatterns`, { outKey: `${OUT}/MaskPatterns`, category: "", entry: maskPatterns });

// Materials of the DefaultBodyColor variant list: what skin submeshes use, tinted by BodyColor rows.
requireProjectExport();
const bodyColorEntry = byName.get("DefaultBodyColor");
const bodyColorGuids = new Set<string>();
if (bodyColorEntry) {
  for (const v of readScriptableObject(path.join(projectDir, bodyColorEntry.entry.id)).variants ?? []) if (v?.guid) bodyColorGuids.add(v.guid);
}
const firstBodyColorGuid = [...bodyColorGuids][0];

const refGuid = (r: Ref | undefined) => (r && !isNullRef(r) ? r.guid : undefined);

async function runtimeFlags(guid: string, category: string): Promise<RuntimeFlag[]> {
  const flags: RuntimeFlag[] = [];
  if (bodyColorGuids.has(guid)) flags.push("bodyColor");
  if (category === "Mask") flags.push("maskPattern", "bodyColor");
  if (category === "Hair" || category === "FacialHair") {
    // Colored base textures (e.g. bandanas) aren't tinted; grayscale ones are masks for the hair color.
    const mat = readMaterial(guid);
    const stats = mat && (await baseTextureStats(mat));
    if (!stats || stats.saturation < TINT_MASK_SATURATION) flags.push("hairColor");
  }
  return flags;
}

async function assignMaterial(ctx: MaterialContext, prim: Primitive, guid: string | undefined, category: string, extra: RuntimeFlag[] = []) {
  if (!guid) return;
  const flags = [...new Set([...(await runtimeFlags(guid, category)), ...extra])];
  await ctx.assign(prim, guid, { runtime: flags });
}

async function buildPart(job: Job, so: any): Promise<"built" | "empty" | "failed"> {
  const part = await newRiggedPart(path.basename(job.outKey));
  const ctx = new MaterialContext(part.doc);
  const variants: Ref[][] = (so.materialVariants ?? []).map((v: any) => (v?.clothingMaterials ?? []) as Ref[]);
  // Submesh count = clothing materials + 1 skin submesh when showsSkin; the skin submesh is last.
  const clothingCount = variants[0]?.length ?? 0;
  const showsSkin = so.showsSkin === 1;
  const isHair = "fullMesh" in so;

  const meshes: { ref: Ref; hairMesh?: string }[] = [{ ref: so.mesh, hairMesh: isHair ? "default" : undefined }];
  if (isHair) {
    for (const [field, label] of [["fullMesh", "full"], ["bottomMesh", "bottom"], ["frontMesh", "front"]] as const) {
      if (so[field] && !isNullRef(so[field])) meshes.push({ ref: so[field], hairMesh: label });
    }
  }

  // Slots such as DefaultBelt and DefaultCape have no mesh: nothing is worn, so there is no file.
  if (!meshes.some((m) => m.ref && !isNullRef(m.ref))) return "empty";

  let skinSubmesh: number | undefined;
  let added = 0;
  for (const { ref, hairMesh } of meshes) {
    if (!ref || isNullRef(ref)) continue;
    const res = await addSkinnedMesh(part, ref, { rigidSlot: job.category });
    if (!res) {
      console.warn(`${job.outKey}: mesh ${ref.guid} not found`);
      continue;
    }
    added++;
    if (hairMesh) res.node.setExtras({ unity: { hairMesh } });
    for (const [i, prim] of res.primitives.entries()) {
      if (i < clothingCount) {
        await assignMaterial(ctx, prim, refGuid(variants[0][i]), job.category);
        // One after another so the output doesn't depend on which image read finishes first.
        const perVariant: (Material | null)[] = [];
        for (const v of variants) {
          const g = refGuid(v[i]);
          perVariant.push(g ? await ctx.material(g, { runtime: await runtimeFlags(g, job.category) }) : null);
        }
        setVariants(part.doc, prim, perVariant, variants.length);
      } else if (showsSkin && i === clothingCount && firstBodyColorGuid) {
        await assignMaterial(ctx, prim, firstBodyColorGuid, job.category, ["bodyColor"]);
        skinSubmesh = i;
      } else {
        console.warn(`${job.outKey}: submesh ${i} has no material (${clothingCount} clothing materials, showsSkin=${showsSkin})`);
      }
    }
  }
  if (!added) return "failed";

  part.root.setExtras({
    unity: {
      kind: "customization",
      category: job.category,
      partType: job.entry.type,
      variants: variants.length,
      ...(showsSkin ? { showsSkin: true, skinSubmesh } : {}),
    },
  });
  await writeModel(part.doc, `${job.outKey}.glb`);
  return "built";
}

async function buildVariantList(job: Job, so: any): Promise<"built"> {
  const doc = newDocument();
  const ctx = new MaterialContext(doc);
  const names: string[] = [];
  const isMask = /MaskPatterns$/.test(job.outKey);
  for (const ref of (so.variants ?? []) as Ref[]) {
    const g = refGuid(ref);
    const mat = g ? await ctx.material(g, { runtime: isMask ? ["maskPattern", "bodyColor"] : bodyColorGuids.has(g) ? ["bodyColor"] : [] }) : null;
    names.push(mat?.getName() ?? "");
  }
  doc.getRoot().setExtras({ unity: { kind: "variantList", materials: names } });
  await writeModel(doc, `${job.outKey}.glb`, { materialsOnly: true });
  return "built";
}

(async () => {
  const manifest = new Manifest("customization");
  let built = 0, unchanged = 0, failed = 0, empty = 0;
  const total = [...jobs.keys()].filter((k) => !only || k.includes(only)).length;
  const rigFiles = (await playerRig()).files;

  for (const job of jobs.values()) {
    if (only && !job.outKey.includes(only)) continue;
    const assetFile = path.join(projectDir, job.entry.id);
    if (!fs.existsSync(assetFile)) {
      console.warn(`${job.outKey}: catalog points at missing file ${job.entry.id}`);
      failed++;
      continue;
    }
    const relFile = `${job.outKey}.glb`;

    // Inputs: the asset's GUID closure, the rig, the body color materials (skin submeshes), and the job itself.
    const pre = new Fingerprint().addValue(job);
    for (const f of guidClosure(assetFile)) pre.addFile(f);
    if (job.entry.type !== "VariantList") for (const f of rigFiles) pre.addFile(f);
    if (bodyColorEntry) for (const f of guidClosure(path.join(projectDir, bodyColorEntry.entry.id))) pre.addFile(f);
    const inputs = pre.digest();
    if (manifest.upToDate(job.outKey, relFile, inputs)) {
      unchanged++;
      continue;
    }

    try {
      const so = readScriptableObject(assetFile);
      const result = job.entry.type === "VariantList" ? await buildVariantList(job, so) : await buildPart(job, so);
      if (result === "empty") empty++;
      else if (result === "failed") failed++;
      else {
        manifest.record(job.outKey, relFile, inputs);
        built++;
      }
    } catch (err) {
      console.warn(`${job.outKey}: build failed: ${(err as Error).stack ?? err}`);
      failed++;
    }
    if ((built + unchanged) % 50 === 0) console.log(`Built ${built + unchanged} / ${total}.`);
  }

  manifest.finish();
  console.log(`Customization: ${built} built, ${unchanged} unchanged, ${empty} empty (no mesh), ${failed} failed, of ${total}.`);
  if (unresolved.size) {
    console.warn(`${unresolved.size} game-data values did not resolve to a customization asset:`);
    for (const u of unresolved) console.warn(`  ${u}`);
  }
  reportUnresolvedShaders();
})();
