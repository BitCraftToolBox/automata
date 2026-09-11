// Player skeleton and the "rigged part" builder shared by customization parts and hand equipment.
// Each part file carries its own copy of the skeleton (bones and ancestors, no meshes) plus a glTF
// skin built from the part mesh's own Unity bind poses, so a part renders correctly standalone and
// parts loaded together line up. Skeleton source: the `Prefabs/Player` prefab, whose
// SkinnedMeshRenderers share one `m_Bones` list that every part mesh's JOINTS_0 index (modulo
// shorter lists, see addSkinnedMesh).

import * as fs from "fs";
import * as path from "path";
import { Document, Node, Primitive, PropertyType } from "@gltf-transform/core";
import { cloneDocument, prune } from "@gltf-transform/functions";
import { prefabCatalogFile, projectDir } from "./env";
import { component, readPrefab, readMeshInfo, refToPath, Ref } from "./unity";
import { createSkin, importMesh, quiet } from "./gltf";
import { buildPrefabNodes } from "./prefab";

const PLAYER_KEY = "Prefabs/Player";

interface RigTemplate {
  doc: Document;
  boneNames: string[];
  /** m_BoneNameHashes of the rig's own body mesh, aligned with boneNames. */
  boneHashes: string[];
  /** Rigid (non-skinned) slot nodes, kept empty at their prefab transform. */
  attachmentNames: string[];
  files: string[];
}

/** Categories drawn by a plain MeshRenderer on the player prefab (no bind poses). Crown floats above the head under the root. */
const RIGID_SLOTS = ["Crown"];

let rigPromise: Promise<RigTemplate> | null = null;

export function playerRig(): Promise<RigTemplate> {
  if (!rigPromise) rigPromise = buildRig();
  return rigPromise;
}

async function buildRig(): Promise<RigTemplate> {
  const catalog: Record<string, string> = JSON.parse(fs.readFileSync(prefabCatalogFile, "utf8"));
  const internalId = catalog[PLAYER_KEY];
  if (!internalId) throw new Error(`No catalog entry for ${PLAYER_KEY}`);
  const prefabFile = path.join(projectDir, internalId);
  const prefab = readPrefab(prefabFile);
  const doc = quiet(new Document());
  const files = [prefabFile];

  const map = buildPrefabNodes(doc, prefab, undefined, false);

  const smrGo = [...prefab.gameObjects.values()].find((g) => component(g, "SkinnedMeshRenderer"));
  if (!smrGo) throw new Error(`${PLAYER_KEY} has no SkinnedMeshRenderer`);
  const boneRefs: Ref[] = component(smrGo, "SkinnedMeshRenderer")!.data.m_Bones;
  const bones = boneRefs.map((r) => {
    const go = prefab.byTransform.get(r.fileID);
    const node = go && map.get(go);
    if (!node) throw new Error(`Rig bone ${r.fileID} not found in ${prefabFile}`);
    return node;
  });

  const smrMeshFile = refToPath(component(smrGo, "SkinnedMeshRenderer")!.data.m_Mesh);
  const boneHashes = smrMeshFile ? readMeshInfo(smrMeshFile).boneNameHashes : [];
  if (boneHashes.length !== bones.length) throw new Error(`Rig mesh has ${boneHashes.length} bone hashes for ${bones.length} bones`);

  const attachments: Node[] = [];
  for (const go of prefab.gameObjects.values()) {
    if (RIGID_SLOTS.includes(go.name) && component(go, "MeshRenderer") && map.get(go)) attachments.push(map.get(go)!);
  }

  const keep = new Set<Node>();
  for (const b of [...bones, ...attachments]) for (let n: Node | null = b; n; n = n.getParentNode()) keep.add(n);
  for (const n of doc.getRoot().listNodes()) {
    if (!keep.has(n)) n.dispose();
    else n.setMesh(null).setSkin(null).setExtras({});
  }
  await doc.transform(prune({ propertyTypes: [PropertyType.MESH, PropertyType.MATERIAL, PropertyType.TEXTURE, PropertyType.ACCESSOR, PropertyType.SKIN, PropertyType.ANIMATION] }));

  const boneNames = bones.map((b) => b.getName());
  if (new Set(boneNames).size !== boneNames.length) throw new Error("Rig bone names are not unique");
  if (smrMeshFile) files.push(smrMeshFile);
  return { doc, boneNames, boneHashes, attachmentNames: attachments.map((a) => a.getName()), files };
}

export interface RiggedPart {
  doc: Document;
  /** Top-level node, named after the output; carries the file's `extras`. */
  root: Node;
  bones: Node[];
  boneHashes: string[];
  attachments: Map<string, Node>;
}

/** Starts a new document holding a copy of the player skeleton under a root node named `name`. */
export async function newRiggedPart(name: string): Promise<RiggedPart> {
  const rig = await playerRig();
  const doc = quiet(cloneDocument(rig.doc));
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const root = doc.createNode(name);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    root.addChild(child);
  }
  scene.addChild(root);
  const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const bones = rig.boneNames.map((n) => byName.get(n)!);
  const attachments = new Map(rig.attachmentNames.map((n) => [n, byName.get(n)!]));
  return { doc, root, bones, boneHashes: rig.boneHashes, attachments };
}

/**
 * Imports a Unity mesh asset as a skinned node under `part.root`. Returns its primitives in
 * submesh order, or null when the mesh can't be found in either export. A mesh without bind poses
 * is rigid: it goes under the `rigidSlot` attachment node when given.
 */
export async function addSkinnedMesh(part: RiggedPart, meshRef: Ref, { rigidSlot }: { rigidSlot?: string } = {}): Promise<{ node: Node; primitives: Primitive[] } | null> {
  const meshFile = refToPath(meshRef);
  if (!meshFile) return null;
  const info = readMeshInfo(meshFile);
  const imported = importMesh(part.doc, info);
  if (!imported) return null;
  const node = part.doc.createNode(info.name).setMesh(imported.mesh);

  if (!info.bindPoses.length) {
    // Rigid parts without a slot (e.g. Feet_SunkenBoots, an unskinned mesh in a skinned slot) are
    // authored in bind space, so they go under the armature (scale 100) with the skinned parts.
    const slot = (rigidSlot ? part.attachments.get(rigidSlot) : undefined) ?? part.bones[0].getParentNode() ?? part.root;
    slot.addChild(node);
    return { node, primitives: imported.primitives };
  }

  // A mesh's JOINTS_0 index its *own* bone list, which isn't always the rig's full list (e.g.
  // hairstyles 15-18 omit CTRL-BOWSTRING). Map by bone name hash.
  let joints = part.bones;
  if (info.boneNameHashes.length && info.boneNameHashes.join() !== part.boneHashes.join()) {
    joints = info.boneNameHashes.map((h) => {
      const i = part.boneHashes.indexOf(h);
      if (i < 0) console.warn(`Mesh ${info.name}: bone hash ${h} not in rig; bound to root`);
      return part.bones[Math.max(i, 0)];
    });
  } else if (info.bindPoses.length !== part.bones.length) {
    console.warn(`Mesh ${info.name} has ${info.bindPoses.length} bind poses, rig has ${part.bones.length} bones`);
  }
  node.setSkin(createSkin(part.doc, info.name, joints, info, part.bones[0]));
  part.root.addChild(node);
  return { node, primitives: imported.primitives };
}
