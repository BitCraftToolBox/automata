// glTF document helpers: I/O, input fingerprints and manifests, mesh import from Unity mesh YAML,
// skins from Unity bind poses, material variants, and the compress-and-write step.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Accessor, Document, Logger, Material, Mesh, Node, NodeIO, Primitive, PropertyType, Skin } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsVariants, Variant } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, textureCompress } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { force, modelsDir, skipOpt } from "./env";
import { builtinMeshName, DecodedMesh, decodeBuiltinMesh, decodeMesh, UnsupportedMeshError } from "./meshes";
import { canonicalUnityYaml, MeshInfo } from "./unity";
import { unityToGltfMatrix } from "./math";

/** Bump after any code change that alters output, so unchanged inputs are rebuilt. */
const PIPELINE_VERSION = "models-v3.1";

// libvips' operation cache and thread pool may exhaust native memory over a full run of WebP encodes.
sharp.cache(false);
sharp.concurrency(1);

let ioInstance: NodeIO | null = null;
async function io(): Promise<NodeIO> {
  if (!ioInstance) {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    ioInstance = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
  }
  return ioInstance;
}

const fileHashCache = new Map<string, string>();
/** Content hash; Unity YAML is hashed in canonical form (see `canonicalUnityYaml`) so a fresh export of the same data hashes the same. */
function hashFile(file: string): string {
  let h = fileHashCache.get(file);
  if (!h) {
    const bytes = fs.readFileSync(file);
    const isYaml = bytes.subarray(0, 5).toString("latin1") === "%YAML";
    h = crypto.createHash("sha1").update(isYaml ? canonicalUnityYaml(bytes.toString("utf8")) : bytes).digest("hex");
    fileHashCache.set(file, h);
  }
  return h;
}

export class Fingerprint {
  private parts = new Set<string>([PIPELINE_VERSION]);
  addFile(file: string) {
    this.parts.add(`${path.basename(file)}:${hashFile(file)}`);
    return this;
  }
  addValue(v: unknown) {
    this.parts.add(JSON.stringify(v));
    return this;
  }
  digest(): string {
    return crypto.createHash("sha1").update([...this.parts].sort().join("\n")).digest("hex");
  }
}

export interface ManifestEntry {
  /** Output path relative to modelsDir. */
  file: string;
  /** Fingerprint of the inputs the output was built from. */
  inputs: string;
}

/** Per-publisher record of output key -> built file + input fingerprint (`manifest_<kind>.json`). */
export class Manifest {
  private prev: Record<string, ManifestEntry> = {};
  private next: Record<string, ManifestEntry> = {};
  private file: string;
  constructor(kind: string) {
    this.file = path.join(modelsDir, `manifest_${kind}.json`);
    if (fs.existsSync(this.file)) {
      try {
        this.prev = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        this.prev = {};
      }
    }
  }
  /** True when `key` was built from the same inputs last time and its output still exists. */
  upToDate(key: string, relFile: string, inputs: string): boolean {
    const p = this.prev[key];
    if (!force && p && p.inputs === inputs && p.file === relFile && fs.existsSync(path.join(modelsDir, relFile))) {
      this.next[key] = p;
      return true;
    }
    return false;
  }
  private unsaved = 0;
  record(key: string, relFile: string, inputs: string) {
    this.next[key] = { file: relFile, inputs };
    // Checkpoint so a crashed run keeps credit for what it built, without dropping entries it hasn't visited yet.
    if (++this.unsaved >= 25) {
      this.unsaved = 0;
      this.save({ ...this.prev, ...this.next });
    }
  }
  /** Writes the manifest. Previous entries this run didn't produce are kept, so models that disappear from the data or fail to build stay published. */
  finish() {
    for (const [k, v] of Object.entries(this.prev)) if (!(k in this.next)) this.next[k] = v;
    this.save(this.next);
  }
  private save(entries: Record<string, ManifestEntry>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(this.file, JSON.stringify(sorted, null, 1) + "\n");
  }
}

/**
 * Builds a glTF Mesh from a Unity Mesh asset (decoded from its YAML, see meshes.ts): one primitive
 * per submesh, in submesh order, all sharing the vertex accessors. Returns null, with a warning,
 * for meshes the decoder doesn't support. Materials are assigned by the caller.
 */
export function importMesh(doc: Document, info: MeshInfo): { mesh: Mesh; primitives: Primitive[] } | null {
  let decoded;
  try {
    decoded = decodeMesh(info.file);
  } catch (e) {
    if (!(e instanceof UnsupportedMeshError)) throw e;
    console.warn(`Mesh ${info.name} (${path.basename(info.file)}) skipped: ${e.message}`);
    return null;
  }
  return buildMesh(doc, info.name, decoded);
}

/** Like `importMesh`, for one of Unity's built-in primitive meshes (see `decodeBuiltinMesh`). */
export function importBuiltinMesh(doc: Document, fileId: number): { mesh: Mesh; primitives: Primitive[] } | null {
  try {
    return buildMesh(doc, builtinMeshName(fileId) ?? String(fileId), decodeBuiltinMesh(fileId));
  } catch (e) {
    if (!(e instanceof UnsupportedMeshError)) throw e;
    console.warn(`${e.message} skipped`);
    return null;
  }
}

function buildMesh(doc: Document, name: string, decoded: DecodedMesh): { mesh: Mesh; primitives: Primitive[] } {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const accessors = new Map<string, Accessor>();
  for (const [attribute, { type, array }] of decoded.attributes) accessors.set(attribute, doc.createAccessor().setType(type).setArray(array).setBuffer(buffer));

  const mesh = doc.createMesh(name);
  const primitives = decoded.submeshes.map((indices) => {
    const prim = doc.createPrimitive();
    for (const [name, accessor] of accessors) prim.setAttribute(name, accessor);
    let max = 0;
    for (const i of indices) if (i > max) max = i;
    const array = max > 0xffff ? indices : Uint16Array.from(indices);
    prim.setIndices(doc.createAccessor().setType("SCALAR").setArray(array).setBuffer(buffer));
    mesh.addPrimitive(prim);
    return prim;
  });
  return { mesh, primitives };
}

/**
 * Builds a glTF skin binding `joints` (in Unity `m_Bones` order) with inverse bind matrices
 * converted from the mesh's own Unity bind poses. Joint indices in the imported geometry already
 * reference `m_Bones` order, so no remapping is needed.
 */
export function createSkin(doc: Document, name: string, joints: Node[], info: MeshInfo, skeleton?: Node): Skin {
  const ibm = new Float32Array(joints.length * 16);
  joints.forEach((_, i) => {
    const bp = info.bindPoses[i];
    if (bp) ibm.set(unityToGltfMatrix(bp), i * 16);
    else ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16);
  });
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const accessor = doc.createAccessor(`${name}_IBM`).setType(Accessor.Type.MAT4).setArray(ibm).setBuffer(buffer);
  const skin = doc.createSkin(name).setInverseBindMatrices(accessor);
  for (const j of joints) skin.addJoint(j);
  if (skeleton) skin.setSkeleton(skeleton);
  return skin;
}

/** Moves COLOR_0 to the app-specific `_COLOR_0` attribute (kept as data, not multiplied in). */
export function demoteVertexColors(prim: Primitive) {
  const c = prim.getAttribute("COLOR_0");
  if (!c) return;
  prim.setAttribute("_COLOR_0", c);
  prim.setAttribute("COLOR_0", null);
}

function variantsExtension(doc: Document): KHRMaterialsVariants {
  return (doc.getRoot().listExtensionsUsed().find((e) => e.extensionName === "KHR_materials_variants") as KHRMaterialsVariants) ?? doc.createExtension(KHRMaterialsVariants);
}

/** Sets `perVariant[i]` as the material for variant i on `prim` (variant 0 is also the default). */
export function setVariants(doc: Document, prim: Primitive, perVariant: (Material | null)[], variantCount: number) {
  if (variantCount <= 1) return;
  const ext = variantsExtension(doc);
  const variants = ensureVariants(doc, ext, variantCount);
  const list = ext.createMappingList();
  const byMaterial = new Map<Material, number[]>();
  perVariant.forEach((m, i) => {
    if (!m) return;
    byMaterial.set(m, [...(byMaterial.get(m) ?? []), i]);
  });
  for (const [mat, idx] of byMaterial) {
    const mapping = ext.createMapping().setMaterial(mat);
    for (const i of idx) mapping.addVariant(variants[i]);
    list.addMapping(mapping);
  }
  prim.setExtension("KHR_materials_variants", list);
}

const docVariants = new WeakMap<Document, Variant[]>();

/** Variants are named by index ("0", "1", ...) = the Unity `materialVariants` index. */
function ensureVariants(doc: Document, ext: KHRMaterialsVariants, count: number): Variant[] {
  const list = docVariants.get(doc) ?? [];
  for (let i = list.length; i < count; i++) list.push(ext.createVariant(String(i)));
  docVariants.set(doc, list);
  return list;
}

/**
 * Prunes and writes `doc` to `<modelsDir>/<relFile>`. Compression is limited to WebP textures and
 * Meshopt geometry: transforms that join, flatten, instance or palette nodes and materials would
 * lose the names and extras the viewer reads.
 */
export async function writeModel(doc: Document, relFile: string, { materialsOnly = false } = {}) {
  await doc.transform(
    prune({
      // A materials-only file (e.g. the MaskPatterns palette) has nothing referencing its materials.
      propertyTypes: materialsOnly
        ? [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.SKIN]
        : [PropertyType.MATERIAL, PropertyType.TEXTURE, PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.SKIN],
      keepLeaves: true,
      keepAttributes: true,
      keepExtras: true,
    }),
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
  );
  // Collapse to a single buffer (mergeDocuments brings one per source).
  const buffers = doc.getRoot().listBuffers();
  if (buffers.length > 1) {
    const keep = buffers[0];
    for (const acc of doc.getRoot().listAccessors()) acc.setBuffer(keep);
    for (const b of buffers.slice(1)) b.dispose();
  }
  if (!skipOpt) {
    await doc.transform(
      // Normal maps: noisy, so they compress poorly and dominated output size. Cap at 1024px.
      textureCompress({ encoder: sharp, targetFormat: "webp", quality: 85, slots: /^normalTexture$/, resize: [1024, 1024] }),
      textureCompress({ encoder: sharp, targetFormat: "webp", quality: 90, slots: /^(?!normalTexture$)/ }),
      meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    );
  }
  const out = path.join(modelsDir, relFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await (await io()).write(out, doc);
}

const quietLogger = new Logger(Logger.Verbosity.ERROR);
export function quiet(doc: Document): Document {
  return doc.setLogger(quietLogger);
}

export function newDocument(): Document {
  const doc = quiet(new Document());
  doc.createBuffer();
  return doc;
}
