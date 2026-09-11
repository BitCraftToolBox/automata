// originally by Kyle

import * as fs from "fs";
import * as path from "path";

const workspaceDir = path.resolve(__dirname, '../../workspace/assets');

// CATALOG_FILE points this at an arbitrary catalog.json (e.g. a local Steam install) for local
// runs; outputs are still written to the cwd, and the build id isn't recorded.
let catalog: string;
if (process.env.CATALOG_FILE) {
  catalog = process.env.CATALOG_FILE;
} else {
  const assetFolderPath = path.join(workspaceDir, 'depots/3454651');
  const build = String(fs.readdirSync(assetFolderPath, { recursive: false })[0]);
  catalog = path.join(assetFolderPath, build, 'BitCraft_Data', 'StreamingAssets', 'aa', 'catalog.json');
  fs.writeFileSync(path.join(workspaceDir, 'publish/build'), build);
}

class Reader {
  buf: Buffer;
  off = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  tell() {
    return this.off;
  }
  seek(o: number) {
    this.off = o;
  }
  u8() {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  bytes(n: number) {
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
  sizedBytes(): Buffer {
    const len = this.u32();
    return this.bytes(len);
  }
  sizedUtf8(): string {
    return this.sizedBytes().toString("utf8");
  }
  sizedUtf16le(): string {
    return this.sizedBytes().toString("utf16le");
  }
}

function parseKeyData(keyBuf: Buffer): { keys: any[]; keyByOffset: Map<number, any> } {
  const r = new Reader(keyBuf);
  const keyCount = r.u32();

  const keys: any[] = [];
  const keyByOffset = new Map<number, any>();

  for (let i = 0; i < keyCount; i++) {
    const offset = r.tell();      
    const keyType = r.u8();

    let value: string | number;
    if (keyType === 0) value = r.sizedUtf8();
    else if (keyType === 1) value = r.sizedUtf16le();
    else if (keyType === 4) value = r.u32();
    else {
      throw new Error(`Unknown keyType=${keyType} at keyIndex=${i} offset=${offset}`);
    }

    const k: any = { offset, type: keyType, value };
    keys.push(k);
    keyByOffset.set(offset, k);
  }

  return { keys, keyByOffset };
}

function parseBucketData(bucketBuf: Buffer): any[] {
  const r = new Reader(bucketBuf);
  const bucketCount = r.u32();
  const buckets: any[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const keyOffset = r.u32();
    const entryCount = r.u32();
    const entryIndices: number[] = new Array(entryCount);
    for (let j = 0; j < entryCount; j++) entryIndices[j] = r.u32();
    buckets.push({ keyOffset, entryIndices });
  }
  return buckets;
}

function parseEntryData(entryBuf: Buffer): any[] {
  const r = new Reader(entryBuf);
  const entryCount = r.u32();
  const entries: any[] = [];

  for (let i = 0; i < entryCount; i++) {
    entries.push({
      internalIdIndex: r.u32(),
      providerIndex: r.u32(),
      dependenciesBucketIndex: r.u32(),
      bundledAssetProviderCrc: r.u32(),
      extraDataOffset: r.u32(),
      siblingsBucketIndex: r.u32(),
      resourceTypeIndex: r.u32(),
    });
  }
  return entries;
}

function typeName(cat: any, typeIndex: number): string {
  const t = cat.m_resourceTypes[typeIndex];
  return t ? t.m_ClassName : `typeIndex:${typeIndex}`;
}


const json: any = JSON.parse(fs.readFileSync(catalog, "utf8"));

const keyBuf = Buffer.from(json.m_KeyDataString, "base64");
const bucketBuf = Buffer.from(json.m_BucketDataString, "base64");
const entryBuf = Buffer.from(json.m_EntryDataString, "base64");

const { keyByOffset } = parseKeyData(keyBuf);
const buckets = parseBucketData(bucketBuf);
const entries = parseEntryData(entryBuf);

// Every (catalog key, entry) pair with its resource type name.
function* catalogEntries(): Generator<{ key: string; internalId: string; type: string }> {
  for (const b of buckets) {
    const k = keyByOffset.get(b.keyOffset);
    if (!k) continue;
    for (const entryIndex of b.entryIndices) {
      const e = entries[entryIndex];
      if (!e) continue;
      yield { key: String(k.value), internalId: json.m_InternalIds[e.internalIdIndex], type: typeName(json, e.resourceTypeIndex) };
    }
  }
}

// Sprites: sprite name (the key after "sprites/") -> internalId.
const sprites: Record<string, string> = {};
for (const { key, internalId, type } of catalogEntries()) {
  if (!key.toLowerCase().startsWith("sprites/") || !type.toLowerCase().includes("sprite")) continue;
  sprites[key.substring("sprites/".length)] = internalId;
}

// Names must stay unique when mapped to paths.
const reversedMap = new Map<string, string>();
for (const [key, value] of Object.entries(sprites)) {
  if (reversedMap.has(value)) {
    throw new Error(`Duplicate value detected when reversing the map: ${value} is mapped to multiple keys (${reversedMap.get(value)} and ${key})`);
  }
  reversedMap.set(value, key);
}

fs.writeFileSync("sprites.json", JSON.stringify(sprites, null, 2));

// Prefabs: full catalog key -> internalId for every GameObject entry. Keys don't share one namespace
// (Prefabs/Category/Name, Interiors/Name, bare GUIDs, ...), so callers prepend their own prefix.
const prefabs: Record<string, string> = {};
// ScriptableObjects read through their own serialized fields: full catalog key -> { id, type }.
// Includes the bare-GUID duplicates of the same entries (equipment_desc stores GUIDs).
const SCRIPTABLE_OBJECT_TYPES = new Set([
  "ResourceModels",
  "BodyPart",
  "HairPart",
  "AttachmentPart",
  "VariantList",
  "EquipmentMeshAndMaterials",
  "BitCraft.Tools.HexTileTemplate",
]);
const scriptableObjects: Record<string, { id: string; type: string }> = {};
for (const { key, internalId, type } of catalogEntries()) {
  if (type === "UnityEngine.GameObject") prefabs[key] = internalId;
  else if (SCRIPTABLE_OBJECT_TYPES.has(type)) scriptableObjects[key] = { id: internalId, type };
}

fs.writeFileSync("prefabs.json", JSON.stringify(prefabs, null, 2));
fs.writeFileSync("scriptable_objects.json", JSON.stringify(scriptableObjects, null, 2));
