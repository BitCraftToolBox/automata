// Readers for AssetRipper's Unity Project export (YAML `.asset`/`.prefab`/`.mat` files plus `.meta`
// GUID sidecars). Covers only what the publishers need.

import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import { projectAssetsDir, requireProjectExport, workspaceDir } from "./env";

export interface Ref {
  fileID: string;
  guid?: string;
  type?: number;
}

export function isNullRef(ref: Ref | undefined | null): boolean {
  return !ref || (ref.fileID === "0" && !ref.guid);
}

let guidIndex: Map<string, string> | null = null;

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".meta")) out.push(p);
  }
}

/**
 * GUID -> absolute asset path, for every `.meta` under the Unity Project export. Built once per
 * export and cached in the workspace (scanning ~100k `.meta` files is the slowest part of a run).
 */
function guidToPath(guid: string): string | undefined {
  if (!guidIndex) guidIndex = loadGuidIndex();
  return guidIndex.get(guid);
}

function loadGuidIndex(): Map<string, string> {
  requireProjectExport();
  const cacheFile = path.join(workspaceDir, "guid_index.json");
  const stamp = `${projectAssetsDir}|${fs.statSync(projectAssetsDir).mtimeMs}`;
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached.stamp === stamp) {
      return new Map(Object.entries(cached.entries).map(([g, rel]) => [g, path.join(projectAssetsDir, rel as string)]));
    }
  }
  const metas: string[] = [];
  walk(projectAssetsDir, metas);
  const entries: Record<string, string> = {};
  for (const meta of metas) {
    const fd = fs.openSync(meta, "r");
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    const m = buf.toString("utf8", 0, n).match(/^guid: ([0-9a-f]{32})/m);
    if (m && !(m[1] in entries)) entries[m[1]] = path.relative(projectAssetsDir, meta.slice(0, -".meta".length));
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ stamp, entries }));
  return new Map(Object.entries(entries).map(([g, rel]) => [g, path.join(projectAssetsDir, rel)]));
}

/** Resolves a reference to its asset file, or undefined for null/builtin/missing references. */
export function refToPath(ref: Ref | undefined): string | undefined {
  if (!ref?.guid || isNullRef(ref)) return undefined;
  return guidToPath(ref.guid);
}

export interface UnityObject {
  classId: number;
  fileId: string;
  /** Top-level key of the document, e.g. "MonoBehaviour", "GameObject", "Material". */
  type: string;
  data: any;
}

const yamlCache = new Map<string, UnityObject[]>();

/**
 * Splits a Unity YAML file into its `--- !u!<classId> &<fileId>` documents and parses each.
 * fileIDs are 64-bit and some guids read as numbers (`0000000000000000e000000000000000` is 0 in
 * YAML), so both are quoted before parsing to keep them exact strings.
 */
export function readUnityYaml(file: string, { cache = true } = {}): UnityObject[] {
  const hit = yamlCache.get(file);
  if (hit) return hit;
  const text = fs.readFileSync(file, "utf8").replace(/fileID: (-?\d+)/g, 'fileID: "$1"').replace(/guid: ([0-9a-f]{32})/g, 'guid: "$1"');
  const parts = text.split(/^--- !u!(\d+) &(-?\d+)(?: stripped)?\r?\n/m);
  const objects: UnityObject[] = [];
  for (let i = 1; i < parts.length; i += 3) {
    const body = parts[i + 2] ?? "";
    const parsed = parse(body, { uniqueKeys: false, strict: false, logLevel: "silent" }) ?? {};
    const type = Object.keys(parsed)[0] ?? "";
    objects.push({ classId: Number(parts[i]), fileId: parts[i + 1], type, data: parsed[type] ?? {} });
  }
  if (cache) yamlCache.set(file, objects);
  return objects;
}

/** The single MonoBehaviour (ScriptableObject) payload of a `.asset` file. */
export function readScriptableObject(file: string): any {
  const obj = readUnityYaml(file).find((o) => o.type === "MonoBehaviour");
  if (!obj) throw new Error(`No MonoBehaviour in ${file}`);
  return obj.data;
}

export function readScriptableObjectByRef(ref: Ref | undefined): any | undefined {
  const p = refToPath(ref);
  return p ? readScriptableObject(p) : undefined;
}

/**
 * Every file transitively referenced by GUID from `file`, following YAML assets that can reference
 * further assets (.asset, .mat, .prefab) and stopping at leaves (meshes are followed only for
 * their own file, textures/shaders/scripts are leaves). Used to fingerprint an output's inputs
 * before building it.
 */
export function guidClosure(file: string, out = new Set<string>()): Set<string> {
  if (out.has(file)) return out;
  out.add(file);
  if (!/\.(asset|mat|prefab)$/i.test(file)) return out;
  const fd = fs.openSync(file, "r");
  // Mesh .asset files are huge and reference nothing; only scan their header.
  const head = Buffer.alloc(512);
  const n = fs.readSync(fd, head, 0, 512, 0);
  fs.closeSync(fd);
  if (/^Mesh:/m.test(head.toString("utf8", 0, n))) return out;
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/guid: ([0-9a-f]{32}), type: (\d+)/g)) {
    if (m[2] === "3" && /m_Script/.test(text.slice(Math.max(0, m.index! - 40), m.index))) continue;
    const p = guidToPath(m[1]);
    if (p) guidClosure(p, out);
  }
  return out;
}

export interface MeshInfo {
  name: string;
  file: string;
  /** Row-major 4x4 Unity bind poses (one per bone), in Unity's left-handed space. */
  bindPoses: number[][];
  /** Index count per submesh (exact; AssetRipper drops unreferenced vertices but keeps indices). */
  indexCounts: number[];
  /** Per-bone name hashes (8 hex chars each), in this mesh's own bone order. */
  boneNameHashes: string[];
}

const meshCache = new Map<string, MeshInfo>();

export function readMeshInfo(file: string): MeshInfo {
  const hit = meshCache.get(file);
  if (hit) return hit;
  const text = fs.readFileSync(file, "utf8");
  const name = text.match(/^  m_Name: (.*)$/m)?.[1] ?? path.basename(file, path.extname(file));
  const bindPoses: number[][] = [];
  const bpStart = text.indexOf("\n  m_BindPose:");
  if (bpStart >= 0) {
    const bpEnd = text.indexOf("\n  m_", bpStart + 5);
    const block = text.slice(bpStart, bpEnd < 0 ? undefined : bpEnd);
    const values = [...block.matchAll(/e[0-3][0-3]: (\S+)/g)].map((m) => Number(m[1]));
    for (let i = 0; i + 16 <= values.length; i += 16) bindPoses.push(values.slice(i, i + 16));
  }
  const subMeshBlock = text.slice(text.indexOf("m_SubMeshes:"), text.indexOf("m_Shapes:"));
  const info: MeshInfo = {
    name,
    file,
    bindPoses,
    indexCounts: [...subMeshBlock.matchAll(/^    indexCount: (\d+)/gm)].map((m) => Number(m[1])),
    boneNameHashes: (text.match(/^  m_BoneNameHashes: (\S*)$/m)?.[1] ?? "").match(/.{8}/g) ?? [],
  };
  meshCache.set(file, info);
  return info;
}

export interface PrefabGameObject {
  fileId: string;
  name: string;
  active: boolean;
  transformId: string;
  parent: PrefabGameObject | null;
  children: PrefabGameObject[];
  components: UnityObject[];
}

export interface Prefab {
  roots: PrefabGameObject[];
  gameObjects: Map<string, PrefabGameObject>;
  /** Transform fileID -> owning GameObject. */
  byTransform: Map<string, PrefabGameObject>;
  objects: Map<string, UnityObject>;
}

export function readPrefab(file: string): Prefab {
  const objects = new Map<string, UnityObject>();
  for (const o of readUnityYaml(file, { cache: false })) objects.set(o.fileId, o);

  const gameObjects = new Map<string, PrefabGameObject>();
  const byTransform = new Map<string, PrefabGameObject>();
  for (const o of objects.values()) {
    if (o.type !== "GameObject") continue;
    const components: UnityObject[] = [];
    let transformId = "";
    for (const c of o.data.m_Component ?? []) {
      const comp = objects.get(c.component?.fileID);
      if (!comp) continue;
      components.push(comp);
      if (comp.type === "Transform" || comp.type === "RectTransform") transformId = comp.fileId;
    }
    const go: PrefabGameObject = {
      fileId: o.fileId,
      name: String(o.data.m_Name ?? ""),
      active: o.data.m_IsActive !== 0,
      transformId,
      parent: null,
      children: [],
      components,
    };
    gameObjects.set(o.fileId, go);
    if (transformId) byTransform.set(transformId, go);
  }

  const roots: PrefabGameObject[] = [];
  for (const go of gameObjects.values()) {
    const t = objects.get(go.transformId);
    if (!t) continue;
    go.children = (t.data.m_Children ?? [])
      .map((c: Ref) => byTransform.get(c.fileID))
      .filter((c: PrefabGameObject | undefined): c is PrefabGameObject => !!c);
    for (const c of go.children) c.parent = go;
  }
  for (const go of gameObjects.values()) if (!go.parent) roots.push(go);

  return { roots, gameObjects, byTransform, objects };
}

export function component(go: PrefabGameObject, type: string): UnityObject | undefined {
  return go.components.find((c) => c.type === type);
}
