// Builds glTF models from Unity prefab YAML (Unity Project export) and publishes them: node tree,
// meshes, materials, skinned meshes, LOD/enabled flags, PrefabRandomizer variants.

import * as fs from "fs";
import * as path from "path";
import { mergeDocuments } from "@gltf-transform/functions";
import { Document, Node, Primitive } from "@gltf-transform/core";
import { requireProjectExport } from "./env";
import { component, guidClosure, Prefab, PrefabGameObject, readMeshInfo, readPrefab, refToPath, Ref, isNullRef } from "./unity";
import { MaterialContext, reportUnresolvedShaders } from "./materials";
import { invert } from "./math";
import { createSkin, Fingerprint, importBuiltinMesh, importMesh, Manifest, quiet, writeModel } from "./gltf";
import { BUILTIN_MESH_GUID } from "./meshes";

/** Nested prefab inlining (PrefabRandomizer variants, hex tile columns) stops past this depth. */
const MAX_INLINE_DEPTH = 3;

type PublishResult = "built" | "unchanged" | "missing" | "failed";

/** Publishes one prefab to `<modelsDir>/<key>.glb`. */
async function publishPrefab(manifest: Manifest, key: string, prefabFile: string, stats: PrefabStats): Promise<PublishResult> {
  if (!fs.existsSync(prefabFile)) {
    console.warn(`No prefab YAML for "${key}" -> ${prefabFile}`);
    return "missing";
  }
  const relFile = `${key}.glb`;
  const pre = new Fingerprint().addValue(key);
  for (const f of guidClosure(prefabFile)) pre.addFile(f);
  const inputs = pre.digest();
  if (manifest.upToDate(key, relFile, inputs)) return "unchanged";
  try {
    const doc = quiet(new Document());
    mergeStats(stats, await applyPrefab(doc, readPrefab(prefabFile)));
    await writeModel(doc, relFile);
    manifest.record(key, relFile, inputs);
    return "built";
  } catch (err) {
    console.warn(`${key}: build failed: ${(err as Error).stack ?? err}`);
    return "failed";
  }
}

/** Publishes `items` (output key -> Unity prefab file) under one manifest and logs a summary. */
export async function publishPrefabSet(kind: string, items: Map<string, string>) {
  requireProjectExport();
  const manifest = new Manifest(kind);
  const stats = emptyStats();
  const counts: Record<PublishResult, number> = { built: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const [key, prefabFile] of items) {
    const result = await publishPrefab(manifest, key, prefabFile, stats);
    counts[result]++;
    const done = counts.built + counts.unchanged;
    if (result !== "unchanged" && done % 100 === 0) console.log(`Published ${done} / ${items.size}.`);
  }
  manifest.finish();
  console.log(`${kind}: ${counts.built} built, ${counts.unchanged} unchanged, ${counts.missing} without prefab YAML, ${counts.failed} failed.`);
  console.log(`  ${describeStats(stats)}`);
  reportUnresolvedShaders();
}

export interface PrefabStats {
  meshesMissing: number;
  missingMaterials: number;
  skinnedAdded: number;
  skinnedMissingMesh: number;
  randomVariants: number;
  randomVariantsMissing: number;
}

export function emptyStats(): PrefabStats {
  return { meshesMissing: 0, missingMaterials: 0, skinnedAdded: 0, skinnedMissingMesh: 0, randomVariants: 0, randomVariantsMissing: 0 };
}

function mergeStats(into: PrefabStats, s: PrefabStats) {
  for (const k of Object.keys(into) as (keyof PrefabStats)[]) into[k] += s[k];
}

export function describeStats(s: PrefabStats): string {
  return `${s.skinnedAdded} skinned meshes built (${s.skinnedMissingMesh} missing); ${s.meshesMissing} static meshes missing; ${s.missingMaterials} materials missing; ${s.randomVariants} PrefabRandomizer variants inlined (${s.randomVariantsMissing} missing).`;
}

/**
 * Builds the glTF node tree of a prefab in a new scene of `doc`: one node per GameObject, in child
 * order, with the local transform converted to glTF space (X mirrored, so position.x and the
 * quaternion's y and z change sign; a root keeps only its scale) and a mesh per MeshFilter.
 * Materials and the other components are applied by `applyPrefab`.
 */
export function buildPrefabNodes(doc: Document, prefab: Prefab, stats?: PrefabStats, withMeshes = true): Map<PrefabGameObject, Node> {
  const map = new Map<PrefabGameObject, Node>();
  const scene = doc.createScene();
  const build = (go: PrefabGameObject): Node => {
    const node = doc.createNode(go.name);
    map.set(go, node);
    // A root's position and rotation are where the prefab happens to sit in the editor (wall parts
    // are hundreds of units from the origin), so they stay at identity. Its scale is kept: the game
    // keeps it on instantiation, and it makes models comparable at game size.
    const t = go.components.find((c) => c.type === "Transform" || c.type === "RectTransform");
    if (t) {
      const p = t.data.m_LocalPosition, q = t.data.m_LocalRotation, s = t.data.m_LocalScale;
      node.setScale([s.x + 0, s.y + 0, s.z + 0]);
      if (go.parent) node.setTranslation([-p.x + 0, p.y + 0, p.z + 0]).setRotation([q.x + 0, -q.y + 0, -q.z + 0, q.w + 0]);
    }
    const meshRef: Ref | undefined = withMeshes ? component(go, "MeshFilter")?.data.m_Mesh : undefined;
    if (meshRef && !isNullRef(meshRef)) {
      const meshFile = refToPath(meshRef);
      const imported = meshRef.guid === BUILTIN_MESH_GUID ? importBuiltinMesh(doc, Number(meshRef.fileID)) : meshFile ? importMesh(doc, readMeshInfo(meshFile)) : null;
      if (imported) node.setMesh(imported.mesh);
      else if (stats) stats.meshesMissing++;
    }
    for (const child of go.children) node.addChild(build(child));
    return node;
  };
  for (const root of prefab.roots) scene.addChild(build(root));
  return map;
}

function setUnityExtras(node: Node, patch: Record<string, unknown>) {
  const extras = { ...(node.getExtras() as Record<string, any>) };
  extras.unity = { ...(extras.unity ?? {}), ...patch };
  node.setExtras(extras);
}

/** Builds the prefab into `doc`: node tree and meshes, materials, skinned meshes, extras and PrefabRandomizer variants. */
async function applyPrefab(doc: Document, prefab: Prefab, depth = 0): Promise<PrefabStats> {
  const stats = emptyStats();
  const ctx = new MaterialContext(doc);
  const map = buildPrefabNodes(doc, prefab, stats);

  /** Renderer materials apply per submesh; a short list repeats its last entry. */
  const assignMaterials = async (prims: Primitive[], refs: Ref[]) => {
    for (const [i, prim] of prims.entries()) {
      const ref = refs[Math.min(i, refs.length - 1)];
      if (!ref?.guid || isNullRef(ref)) continue;
      if (!(await ctx.assign(prim, ref.guid))) stats.missingMaterials++;
    }
  };

  for (const [go, node] of map) {
    if (!go.active) setUnityExtras(node, { active: false });

    const mr = component(go, "MeshRenderer");
    const mesh = node.getMesh();
    if (mr && mesh) {
      if (mr.data.m_Enabled === 0) setUnityExtras(node, { rendererEnabled: false });
      await assignMaterials(mesh.listPrimitives(), mr.data.m_Materials ?? []);
    }

    // SkinnedMeshRenderer: the mesh, the renderer's `m_Bones` (already nodes) and the mesh's own bind poses.
    const smr = component(go, "SkinnedMeshRenderer");
    if (smr && !node.getMesh()) {
      const meshFile = refToPath(smr.data.m_Mesh);
      if (!meshFile) {
        stats.skinnedMissingMesh++;
        continue;
      }
      const info = readMeshInfo(meshFile);
      const imported = importMesh(doc, info);
      if (!imported) {
        stats.skinnedMissingMesh++;
        continue;
      }
      await assignMaterials(imported.primitives, smr.data.m_Materials ?? []);
      const bones: Node[] = [];
      for (const b of smr.data.m_Bones ?? []) {
        const boneGo = prefab.byTransform.get(b.fileID);
        bones.push((boneGo && map.get(boneGo)) ?? node);
      }
      if (bones.length && info.bindPoses.length) {
        // glTF and Unity position skinned vertices by joints alone, ignoring the renderer's own
        // transform, but three.js's GLTFLoader binds with the node's world matrix, so a scaled
        // renderer (FBX imports are often scale 100) renders hugely oversized. The skinned mesh
        // goes on a child whose world matrix is identity, which every implementation agrees on.
        const holder = doc.createNode(`${go.name}_SkinnedMesh`).setMesh(imported.mesh);
        holder.setMatrix(invert([...node.getWorldMatrix()]) as any);
        node.addChild(holder);
        const rootBoneGo = prefab.byTransform.get(smr.data.m_RootBone?.fileID);
        holder.setSkin(createSkin(doc, go.name, bones, info, rootBoneGo ? map.get(rootBoneGo) : undefined));
      } else {
        node.setMesh(imported.mesh);
      }
      if (smr.data.m_Enabled === 0) setUnityExtras(node, { rendererEnabled: false });
      stats.skinnedAdded++;
    }
  }

  // PrefabRandomizer { objectPrefabs[], objectWeights[] }: the prefab has no geometry of its own
  // and instantiates one weighted-random prefab at runtime. Every variant is inlined under a
  // `RandomVariant_<i>` node; variants after the first are `active: false`.
  for (const [go, node] of map) {
    for (const c of go.components) {
      if (c.type !== "MonoBehaviour" || path.basename(refToPath(c.data.m_Script) ?? "") !== "PrefabRandomizer.cs") continue;
      const prefabs: Ref[] = c.data.objectPrefabs ?? [];
      const weights: number[] = c.data.objectWeights ?? [];
      for (const [i, ref] of prefabs.entries()) {
        const variantFile = refToPath(ref);
        const wrapper = depth > MAX_INLINE_DEPTH ? null : await inlinePrefab(doc, node, variantFile, `RandomVariant_${i}`, depth + 1, stats);
        if (!wrapper) {
          stats.randomVariantsMissing++;
          continue;
        }
        wrapper.setExtras({
          unity: {
            randomVariant: { index: i, weight: weights[i] ?? null, prefab: path.basename(variantFile!, path.extname(variantFile!)) },
            ...(i > 0 ? { active: false } : {}),
          },
        });
        stats.randomVariants++;
      }
    }
  }

  for (const go of prefab.gameObjects.values()) {
    const lodGroup = component(go, "LODGroup");
    if (!lodGroup) continue;
    (lodGroup.data.m_LODs ?? []).forEach((lod: any, level: number) => {
      for (const r of lod.renderers ?? []) {
        const rendererObj = prefab.objects.get(r.renderer?.fileID);
        const owner = rendererObj && prefab.gameObjects.get(rendererObj.data.m_GameObject?.fileID);
        const node = owner && map.get(owner);
        if (node) setUnityExtras(node, { lod: level });
      }
    });
  }

  return stats;
}

/**
 * Builds another prefab (recursively) and merges it into `doc` under a new `wrapperName` node
 * parented to `parent`. Returns the wrapper, or null when the prefab file is missing.
 */
export async function inlinePrefab(doc: Document, parent: Node, prefabFile: string | undefined, wrapperName: string, depth: number, stats: PrefabStats): Promise<Node | null> {
  if (!prefabFile || !fs.existsSync(prefabFile)) return null;
  const sub = quiet(new Document());
  mergeStats(stats, await applyPrefab(sub, readPrefab(prefabFile), depth));
  const before = new Set(doc.getRoot().listScenes());
  mergeDocuments(doc, sub);
  const scene = doc.getRoot().listScenes().find((sc) => !before.has(sc))!;
  const wrapper = doc.createNode(wrapperName);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrapper.addChild(child);
  }
  scene.dispose();
  parent.addChild(wrapper);
  return wrapper;
}
