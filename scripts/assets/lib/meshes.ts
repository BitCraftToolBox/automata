// Decodes a Unity Mesh `.asset` (Unity Project export, YAML) into glTF-ready vertex and index arrays,
// in the same space AssetRipper's glTF export uses: X mirrored, triangle winding reversed, V flipped.
// Plain vertex buffers and Unity's bit-packed `m_CompressedMesh` are supported; blend shapes and
// compressed skinning are not.

import * as fs from "fs";

export type AttributeType = "SCALAR" | "VEC2" | "VEC3" | "VEC4";

export interface DecodedAttribute {
  type: AttributeType;
  array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>;
}

export interface DecodedMesh {
  vertexCount: number;
  /** glTF attribute name -> data. */
  attributes: Map<string, DecodedAttribute>;
  /** One triangle list per submesh, indices already offset by `baseVertex` and winding-converted. */
  submeshes: Uint32Array<ArrayBuffer>[];
}

/** Why a mesh can't be decoded; callers report it and skip the mesh. */
export class UnsupportedMeshError extends Error {}

const TYPES: AttributeType[] = ["SCALAR", "VEC2", "VEC3", "VEC4"];

/** Vertex data in Unity's own conventions, before conversion to glTF space. */
interface RawMesh {
  vertexCount: number;
  position: Float32Array<ArrayBuffer>;
  normal?: Float32Array<ArrayBuffer>;
  tangent?: Float32Array<ArrayBuffer>;
  color?: Float32Array<ArrayBuffer>;
  /** Texture coordinate channels by index, with their component count. */
  uv: { channel: number; dims: number; data: Float32Array<ArrayBuffer> }[];
  /** Bone indices (4 per vertex) and weights (4 per vertex, absent for single-bone meshes). */
  joints?: Uint16Array<ArrayBuffer>;
  weights?: Float32Array<ArrayBuffer>;
  /** All triangle indices of the mesh as stored. */
  indices: Uint32Array;
  submeshes: { firstIndex: number; indexCount: number; topology: number; baseVertex: number }[];
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f, m = h & 0x3ff, s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Unity VertexAttributeFormat -> byte size and reader (normalized formats return 0..1 / -1..1). */
const FORMATS: Record<number, [number, (v: DataView, o: number) => number]> = {
  0: [4, (v, o) => v.getFloat32(o, true)],
  1: [2, (v, o) => half(v.getUint16(o, true))],
  2: [1, (v, o) => v.getUint8(o) / 255],
  3: [1, (v, o) => Math.max(v.getInt8(o) / 127, -1)],
  4: [2, (v, o) => v.getUint16(o, true) / 65535],
  5: [2, (v, o) => Math.max(v.getInt16(o, true) / 32767, -1)],
  6: [1, (v, o) => v.getUint8(o)],
  7: [1, (v, o) => v.getInt8(o)],
  8: [2, (v, o) => v.getUint16(o, true)],
  9: [2, (v, o) => v.getInt16(o, true)],
  10: [4, (v, o) => v.getUint32(o, true)],
  11: [4, (v, o) => v.getInt32(o, true)],
};

interface Channel {
  stream: number;
  offset: number;
  format: number;
  dim: number;
}

/** Unity VertexAttribute channel numbers. */
const CH = { position: 0, normal: 1, tangent: 2, color: 3, uv0: 4, weights: 12, joints: 13 } as const;

function hexBytes(hex: string): DataView {
  const b = Buffer.from(hex, "hex");
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function readSubmeshes(text: string): RawMesh["submeshes"] {
  const subText = text.slice(text.indexOf("  m_SubMeshes:"), text.indexOf("  m_Shapes:"));
  return [...subText.matchAll(/firstByte: (\d+)\n\s+indexCount: (\d+)\n\s+topology: (\d+)\n\s+baseVertex: (-?\d+)/g)]
    .map((m) => ({ firstIndex: +m[1], indexCount: +m[2], topology: +m[3], baseVertex: +m[4] }));
}

function hasBindPose(text: string): boolean {
  return /\n  m_BindPose:\n  - e00/.test(text);
}

/** Plain mesh: interleaved streams in `m_VertexData`, indices in `m_IndexBuffer`. */
function readPlain(text: string): RawMesh {
  const vd = text.slice(text.indexOf("\n  m_VertexData:"));
  const vertexCount = Number(vd.match(/m_VertexCount: (\d+)/)?.[1] ?? 0);
  const channels: Channel[] = [...vd.matchAll(/- stream: (\d+)\n\s+offset: (\d+)\n\s+format: (\d+)\n\s+dimension: (\d+)/g)]
    .map((m) => ({ stream: +m[1], offset: +m[2], format: +m[3], dim: +m[4] & 0xf }));
  const data = vd.match(/_typelessdata: ([0-9a-f]*)/)?.[1];
  if (!vertexCount || data === undefined) throw new UnsupportedMeshError("no vertex data");
  const view = hexBytes(data);

  // Streams are laid out back to back, each 16-byte aligned; a stream's stride is its furthest channel end.
  const strides = new Map<number, number>();
  for (const c of channels) if (c.dim) strides.set(c.stream, Math.max(strides.get(c.stream) ?? 0, c.offset + FORMATS[c.format][0] * c.dim));
  const starts = new Map<number, number>();
  let off = 0;
  for (const s of [...strides.keys()].sort((a, b) => a - b)) {
    starts.set(s, off);
    off = Math.ceil((off + strides.get(s)! * vertexCount) / 16) * 16;
  }
  const read = (c: Channel, dims: number) => {
    const [size, get] = FORMATS[c.format];
    const out = new Float32Array(vertexCount * dims);
    const base = starts.get(c.stream)!, stride = strides.get(c.stream)!;
    for (let v = 0; v < vertexCount; v++) for (let k = 0; k < Math.min(dims, c.dim); k++) out[v * dims + k] = get(view, base + v * stride + c.offset + k * size);
    return out;
  };
  const channel = (i: number) => (channels[i]?.dim ? channels[i] : undefined);

  const pos = channel(CH.position);
  if (!pos) throw new UnsupportedMeshError("no positions");
  const raw: RawMesh = { vertexCount, position: read(pos, 3), uv: [], indices: new Uint32Array(0), submeshes: readSubmeshes(text) };
  const normal = channel(CH.normal), tangent = channel(CH.tangent), color = channel(CH.color);
  if (normal) raw.normal = read(normal, 3);
  if (tangent) raw.tangent = read(tangent, 4);
  if (color) raw.color = read(color, 4);
  for (let u = 0; u < 8; u++) {
    const c = channel(CH.uv0 + u);
    if (c) raw.uv.push({ channel: u, dims: 2, data: read(c, 2) });
  }

  // Skinning: bone indices are UInt32; a mesh without a weight channel is single-bone with weight 1.
  const joints = channel(CH.joints);
  if (hasBindPose(text) && joints) {
    const idx = read(joints, 4);
    raw.joints = Uint16Array.from(idx);
    const wc = channel(CH.weights);
    if (wc) raw.weights = read(wc, 4);
  }

  // Indices are byte offsets into `m_IndexBuffer`; make them element offsets.
  const wide = Number(text.match(/^  m_IndexFormat: (\d+)/m)?.[1] ?? 0) === 1;
  const iview = hexBytes(text.match(/^  m_IndexBuffer: ([0-9a-f]*)/m)?.[1] ?? "");
  const size = wide ? 4 : 2;
  raw.indices = new Uint32Array(iview.byteLength / size);
  for (let i = 0; i < raw.indices.length; i++) raw.indices[i] = wide ? iview.getUint32(i * size, true) : iview.getUint16(i * size, true);
  for (const s of raw.submeshes) s.firstIndex /= size;
  return raw;
}

interface Packed {
  numItems: number;
  bitSize: number;
  data: Buffer;
  range: number;
  start: number;
}

function readPacked(text: string, name: string): Packed {
  const block = text.match(new RegExp(`\\n    ${name}:\\n((?:      .*\\n)+)`))?.[1] ?? "";
  const num = (k: string) => Number(block.match(new RegExp(`${k}: (\\S+)`))?.[1] ?? 0);
  return {
    numItems: num("m_NumItems"),
    bitSize: num("m_BitSize"),
    data: Buffer.from(block.match(/m_Data: ([0-9a-f]*)/)?.[1] ?? "", "hex"),
    range: num("m_Range"),
    start: num("m_Start"),
  };
}

/** Bit-packed integers, least significant bit first. */
function unpackInts(p: Packed): Float64Array {
  const out = new Float64Array(p.numItems);
  for (let i = 0; i < p.numItems; i++) {
    const bitPos = i * p.bitSize;
    let value = 0, got = 0;
    while (got < p.bitSize) {
      const at = bitPos + got, shift = at & 7, take = Math.min(8 - shift, p.bitSize - got);
      value += ((p.data[at >> 3] >> shift) & ((1 << take) - 1)) * 2 ** got;
      got += take;
    }
    out[i] = value;
  }
  return out;
}

function unpackFloats(p: Packed): Float64Array {
  const ints = unpackInts(p);
  const scale = p.bitSize ? p.range / (2 ** p.bitSize - 1) : 0;
  for (let i = 0; i < ints.length; i++) ints[i] = p.start + ints[i] * scale;
  return ints;
}

/** Rebuilds unit vectors stored as (x, y) plus a sign for z. */
function unpackDirections(xy: Float64Array, count: number, zSign: (i: number) => number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = xy[i * 2], y = xy[i * 2 + 1];
    const zz = 1 - x * x - y * y;
    let z = zz > 0 ? Math.sqrt(zz) : 0;
    if (zz < 0) {
      const l = Math.hypot(x, y) || 1;
      out.set([x / l, y / l, 0], i * 3);
      continue;
    }
    if (zSign(i) === 0) z = -z;
    out.set([x, y, z], i * 3);
  }
  return out;
}

/** Compressed mesh: every stream is a bit-packed vector in `m_CompressedMesh`. */
function readCompressed(text: string): RawMesh {
  const section = text.slice(text.indexOf("\n  m_CompressedMesh:"));
  if (readPacked(section, "m_Weights").numItems || readPacked(section, "m_BoneIndices").numItems) throw new UnsupportedMeshError("compressed skinning");
  const verts = readPacked(section, "m_Vertices");
  const vertexCount = verts.numItems / 3;
  const raw: RawMesh = { vertexCount, position: Float32Array.from(unpackFloats(verts)), uv: [], indices: new Uint32Array(0), submeshes: readSubmeshes(text) };

  const normals = readPacked(section, "m_Normals");
  if (normals.numItems) {
    const signs = unpackInts(readPacked(section, "m_NormalSigns"));
    raw.normal = unpackDirections(unpackFloats(normals), vertexCount, (i) => signs[i]);
  }
  const tangents = readPacked(section, "m_Tangents");
  if (tangents.numItems) {
    const signs = unpackInts(readPacked(section, "m_TangentSigns"));
    raw.tangent = new Float32Array(vertexCount * 4);
    const dir = unpackDirections(unpackFloats(tangents), vertexCount, (i) => signs[i * 2]);
    for (let i = 0; i < vertexCount; i++) raw.tangent.set([dir[i * 3], dir[i * 3 + 1], dir[i * 3 + 2], signs[i * 2 + 1] === 0 ? -1 : 1], i * 4);
  }
  const colors = readPacked(section, "m_FloatColors");
  if (colors.numItems) raw.color = Float32Array.from(unpackFloats(colors));

  // `m_UVInfo`: 4 bits per channel, bit 2 = present, bits 0-1 = components - 1; channels are stored back to back.
  const uvs = unpackFloats(readPacked(section, "m_UV"));
  const info = Number(section.match(/m_UVInfo: (\d+)/)?.[1] ?? 0);
  let at = 0;
  for (let u = 0; u < 8; u++) {
    const bits = (info >> (u * 4)) & 0xf;
    if (!(bits & 4)) continue;
    const dims = (bits & 3) + 1;
    raw.uv.push({ channel: u, dims, data: Float32Array.from(uvs.subarray(at, at + vertexCount * dims)) });
    at += vertexCount * dims;
  }

  raw.indices = Uint32Array.from(unpackInts(readPacked(section, "m_Triangles")));
  // The decompressed index buffer is 16-bit, so submesh offsets are byte offsets / 2.
  for (const s of raw.submeshes) s.firstIndex /= 2;
  return raw;
}

/** Reads a mesh asset. Throws UnsupportedMeshError for blend shapes and compressed skinning. */
export function decodeMesh(file: string): DecodedMesh {
  const text = fs.readFileSync(file, "utf8");
  if (/^    vertices: *\n(    - |      - )/m.test(text)) throw new UnsupportedMeshError("blend shapes");
  return toGltfSpace(/^  m_MeshCompression: [1-9]/m.test(text) ? readCompressed(text) : readPlain(text));
}

/** Guid of Unity's built-in resources; meshes referenced with it have no asset in the export. */
export const BUILTIN_MESH_GUID = "0000000000000000e000000000000000";

const BUILTIN_MESH_NAMES: Record<number, string> = { 10202: "Cube", 10206: "Cylinder", 10207: "Sphere", 10209: "Plane", 10210: "Quad" };

export function builtinMeshName(fileId: number): string | undefined {
  return BUILTIN_MESH_NAMES[fileId];
}

/**
 * Procedural stand-ins for Unity's built-in primitives (Cube, Quad and Plane match Unity's
 * geometry; Sphere and Cylinder are approximations). Only the primitives the game's prefabs
 * reference are provided; throws UnsupportedMeshError for any other id.
 */
export function decodeBuiltinMesh(fileId: number): DecodedMesh {
  const pos: number[] = [], nor: number[] = [], tan: number[] = [], uv: number[] = [], idx: number[] = [];
  const vert = (p: number[], n: number[], t: number[], u: number[]) => {
    pos.push(...p); nor.push(...n); tan.push(...t, -1); uv.push(...u);
    return pos.length / 3 - 1;
  };
  /** Adds a triangle wound clockwise as seen from the side its normal points to (Unity's front face). */
  const tri = (a: number, b: number, c: number) => {
    const P = (i: number) => pos.slice(i * 3, i * 3 + 3), pa = P(a), pb = P(b), pc = P(c);
    const e1 = pb.map((x, i) => x - pa[i]), e2 = pc.map((x, i) => x - pa[i]);
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const n = nor.slice(a * 3, a * 3 + 3);
    if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  /** A flat grid in the plane spanned by `u` and `v` (unit axes) through `origin`, facing `n`. */
  const grid = (origin: number[], u: number[], v: number[], n: number[], su: number, sv: number, nu: number, nv: number) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const fu = i / nu, fv = j / nv;
      vert(origin.map((o, k) => o + u[k] * su * (fu - 0.5) + v[k] * sv * (fv - 0.5)), n, u, [fu, fv]);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      tri(a, c, d);
      tri(a, d, b);
    }
  };

  if (fileId === 10210) grid([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1], 1, 1, 1, 1);
  else if (fileId === 10209) grid([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], 10, 10, 10, 10);
  else if (fileId === 10202) {
    const faces: [number[], number[], number[]][] = [
      [[0, 0, -0.5], [1, 0, 0], [0, 1, 0]], [[0, 0, 0.5], [-1, 0, 0], [0, 1, 0]],
      [[0.5, 0, 0], [0, 0, 1], [0, 1, 0]], [[-0.5, 0, 0], [0, 0, -1], [0, 1, 0]],
      [[0, 0.5, 0], [1, 0, 0], [0, 0, 1]], [[0, -0.5, 0], [1, 0, 0], [0, 0, -1]],
    ];
    for (const [o, u, v] of faces) grid(o, u, v, o.map((x) => Math.sign(x)), 1, 1, 1, 1);
  } else if (fileId === 10207) {
    const lon = 24, lat = 16, r = 0.5;
    for (let j = 0; j <= lat; j++) for (let i = 0; i <= lon; i++) {
      const th = (j / lat) * Math.PI, ph = (i / lon) * 2 * Math.PI;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      vert(n.map((x) => x * r), n, [-Math.sin(ph), 0, Math.cos(ph)], [i / lon, 1 - j / lat]);
    }
    for (let j = 0; j < lat; j++) for (let i = 0; i < lon; i++) {
      const a = j * (lon + 1) + i, b = a + 1, c = a + lon + 1, d = c + 1;
      if (j > 0) tri(a, b, c);
      if (j < lat - 1) tri(b, d, c);
    }
  } else if (fileId === 10206) {
    const seg = 20, r = 0.5, h = 1;
    for (const y of [-h, h]) for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * 2 * Math.PI;
      vert([r * Math.cos(ph), y, r * Math.sin(ph)], [Math.cos(ph), 0, Math.sin(ph)], [-Math.sin(ph), 0, Math.cos(ph)], [i / seg, y < 0 ? 0 : 1]);
    }
    for (let i = 0; i < seg; i++) {
      const a = i, b = i + 1, c = seg + 1 + i, d = c + 1;
      tri(a, c, d);
      tri(a, d, b);
    }
    for (const [y, ny] of [[-h, -1], [h, 1]] as const) {
      const centre = vert([0, y, 0], [0, ny, 0], [1, 0, 0], [0.5, 0.5]);
      const ring = pos.length / 3;
      for (let i = 0; i <= seg; i++) {
        const ph = (i / seg) * 2 * Math.PI;
        vert([r * Math.cos(ph), y, r * Math.sin(ph)], [0, ny, 0], [1, 0, 0], [0.5 + 0.5 * Math.cos(ph), 0.5 + 0.5 * Math.sin(ph)]);
      }
      for (let i = 0; i < seg; i++) tri(centre, ring + i, ring + i + 1);
    }
  } else throw new UnsupportedMeshError(`built-in mesh ${fileId}`);

  return toGltfSpace({
    vertexCount: pos.length / 3,
    position: Float32Array.from(pos),
    normal: Float32Array.from(nor),
    tangent: Float32Array.from(tan),
    uv: [{ channel: 0, dims: 2, data: Float32Array.from(uv) }],
    indices: Uint32Array.from(idx),
    submeshes: [{ firstIndex: 0, indexCount: idx.length, topology: 0, baseVertex: 0 }],
  });
}

/** Converts Unity-space vertex data to glTF space: X mirrored, winding reversed, V flipped. */
function toGltfSpace(raw: RawMesh): DecodedMesh {
  const { vertexCount } = raw;

  const attributes = new Map<string, DecodedAttribute>();
  const add = (name: string, dims: number, array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) => attributes.set(name, { type: TYPES[dims - 1], array });

  const mirror = (src: Float32Array, stride: number, flipW = false) => {
    const out = Float32Array.from(src);
    for (let i = 0; i < out.length; i += stride) {
      out[i] = -out[i];
      if (flipW) out[i + 3] = -out[i + 3];
    }
    return out;
  };
  add("POSITION", 3, mirror(raw.position, 3));
  if (raw.normal) add("NORMAL", 3, mirror(raw.normal, 3));
  if (raw.tangent) add("TANGENT", 4, mirror(raw.tangent, 4, true));
  if (raw.color) add("COLOR_0", 4, raw.color);
  for (const { channel, dims, data } of raw.uv) {
    const uv = Float32Array.from(data);
    if (dims >= 2) for (let i = 1; i < uv.length; i += dims) uv[i] = 1 - uv[i];
    add(`TEXCOORD_${channel}`, dims, uv);
  }
  if (raw.joints) {
    const weights = new Float32Array(vertexCount * 4);
    if (raw.weights) weights.set(raw.weights);
    else for (let v = 0; v < vertexCount; v++) weights[v * 4] = 1;
    add("JOINTS_0", 4, raw.joints);
    add("WEIGHTS_0", 4, weights);
  }

  const submeshes: Uint32Array<ArrayBuffer>[] = [];
  for (const s of raw.submeshes) {
    if (s.topology !== 0) throw new UnsupportedMeshError(`topology ${s.topology}`);
    const tri = new Uint32Array(s.indexCount);
    for (let i = 0; i < s.indexCount; i++) tri[i] = s.baseVertex + raw.indices[s.firstIndex + i];
    // Reverse winding to match the mirrored X axis.
    for (let i = 0; i + 2 < tri.length; i += 3) [tri[i + 1], tri[i + 2]] = [tri[i + 2], tri[i + 1]];
    submeshes.push(tri);
  }
  return { vertexCount, attributes, submeshes };
}
