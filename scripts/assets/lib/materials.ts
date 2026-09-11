// Unity material (.mat) + shader -> glTF material translation.
//
// Only properties the shader's `Properties {}` block declares are read: a `.mat` routinely carries
// values left over from earlier shader assignments. A property's role (base texture, base color,
// ...) is resolved by property name, then by inspector label, so Shader Graph shaders with
// GUID-suffixed property names resolve too.
//
// Unambiguous values go into standard glTF fields. The rest goes in `material.extras.unity`:
//
//   shader, material      shader and source .mat names
//   props                 declared property values (textures by file name)
//   labels                inspector label of each GUID-named property
//   runtime               RuntimeFlag[]: tints the viewer applies (see RuntimeFlag)
//   fallbackColor         linear RGBA of the base color when it is runtime-driven
//   blend                 "additive" for additive blending
//   zWrite                false when a blended material does not write depth
//   decal                 true for procedural decal shaders, which are exported fully transparent
//   colorWrite, queue     depth-only mask state (see translateMaterial)

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { Document, Material, Primitive, Texture, TextureInfo } from "@gltf-transform/core";
import { KHRMaterialsEmissiveStrength, KHRTextureTransform } from "@gltf-transform/extensions";
import { readUnityYaml, refToPath, Ref, isNullRef } from "./unity";
import { shaderDir } from "./env";
import { demoteVertexColors, setVariants } from "./gltf";

export interface UnityTexEnv {
  texture: Ref;
  scale: [number, number];
  offset: [number, number];
}

export interface UnityMaterial {
  name: string;
  shader: ShaderInfo;
  keywords: string[];
  textures: Record<string, UnityTexEnv>;
  floats: Record<string, number>;
  colors: Record<string, [number, number, number, number]>;
}

interface ShaderProp {
  name: string;
  label: string;
  /** "2D", "Color", "Vector", "Float", "Range", "Int", "2DArray", "Cube", ... */
  kind: string;
  attributes: string[];
  /** Raw default after `=`, e.g. `"white" {}`, `"black" {}`, `(1,1,1,1)`, `0.5`. */
  defaultValue: string;
}

export interface ShaderInfo {
  guid: string;
  name: string;
  props: Map<string, ShaderProp>;
  /**
   * From the primary export's parsed shader (Shader/<name>.json): false when every pass that draws
   * color has ColorMask 0, i.e. a depth-only mask (e.g. Stylized Water 2 (Hole), which keeps the
   * ocean out of boat hulls). Undefined when the parsed shader isn't available.
   */
  colorWrite?: boolean;
  /** Render queue tag of the first drawing pass, e.g. "Transparent-1". */
  queue?: string;
  /** Unity BlendMode ids of the first drawing pass, when written in the shader (not property-driven). */
  blend?: { src: number; dst: number };
  /** ZWrite of the first drawing pass, when written in the shader. */
  zWrite?: boolean;
}

/** Utility passes that never draw the visible surface. */
const NON_DRAWING_LIGHTMODES = /^(SHADOWCASTER|DEPTHONLY|DEPTHNORMALS(ONLY)?|META|MOTIONVECTORS|SCENESELECTIONPASS|PICKING|UNIVERSAL2D)$/i;

/** A parsed-shader state value: `m_Val` before AssetRipper 1.3.14, `m_Value` since. */
const stateValue = (v: any): number | undefined => v?.m_Val ?? v?.m_Value;

/** True when the value is written in the shader itself rather than driven by a material property. */
const isFixedState = (v: any): boolean => v?.m_Name === "<noninit>";

const warnedMissingShaderJson = new Set<string>();

/**
 * The saved shader JSON for a `.shader` file. The project export numbers same-named shaders
 * (`Name_0`, `Name_1`, ...); the saved JSON has one file per name because those variants share
 * their pass state, so the suffix is stripped. If a game update makes same-named shaders differ in
 * pass state, unity-asset-ripper.js warns and this lookup must pick the variant instead.
 */
function shaderJsonFile(shaderFile: string): string | undefined {
  const base = path.basename(shaderFile, path.extname(shaderFile));
  return [base, base.replace(/_\d+$/, "")].map((n) => path.join(shaderDir, `${n}.json`)).find((f) => fs.existsSync(f));
}

function readPassState(shaderFile: string): Pick<ShaderInfo, "colorWrite" | "queue" | "blend" | "zWrite"> {
  const json = shaderJsonFile(shaderFile);
  if (!json) {
    if (!warnedMissingShaderJson.has(shaderFile)) {
      warnedMissingShaderJson.add(shaderFile);
      console.warn(`No shader JSON for ${path.basename(shaderFile)}; its blend and depth state is unknown`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(json, "utf8")).m_ParsedForm;
    const passes = (parsed?.m_SubShaders?.[0]?.m_Passes ?? []).filter((p: any) => {
      const tags = p?.m_State?.m_Tags?.m_Tags ?? {};
      return !NON_DRAWING_LIGHTMODES.test(String(tags.LIGHTMODE ?? ""));
    });
    if (!passes.length) return {};
    const masks = passes.map((p: any) => stateValue(p?.m_State?.m_RtBlend0?.m_ColMask));
    const state = passes[0].m_State;
    const rt = state?.m_RtBlend0;
    const out: ReturnType<typeof readPassState> = {
      colorWrite: !masks.every((m: unknown) => m === 0),
      queue: state?.m_Tags?.m_Tags?.QUEUE,
    };
    if (isFixedState(rt?.m_SourceBlend) && isFixedState(rt?.m_DestinationBlend)) {
      out.blend = { src: stateValue(rt.m_SourceBlend)!, dst: stateValue(rt.m_DestinationBlend)! };
    }
    if (isFixedState(state?.m_ZWrite)) out.zWrite = stateValue(state.m_ZWrite) !== 0;
    return out;
  } catch {
    return {};
  }
}

const shaderCache = new Map<string, ShaderInfo>();
const materialCache = new Map<string, UnityMaterial | null>();

function listToRecord<T>(list: any): Record<string, T> {
  const out: Record<string, T> = {};
  if (Array.isArray(list)) for (const entry of list) for (const [k, v] of Object.entries(entry ?? {})) out[k] = v as T;
  else if (list && typeof list === "object") Object.assign(out, list);
  return out;
}

function readShader(ref: Ref): ShaderInfo {
  const key = ref.guid ?? `builtin:${ref.fileID}`;
  const hit = shaderCache.get(key);
  if (hit) return hit;
  const file = refToPath(ref);
  const info: ShaderInfo = { guid: key, name: key, props: new Map() };
  if (file && fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    info.name = text.match(/^\s*Shader\s+"([^"]+)"/m)?.[1] ?? path.basename(file);
    const start = text.search(/^\s*Properties\s*\{/m);
    if (start >= 0) {
      // Properties block ends at the first line that is only a closing brace.
      const rest = text.slice(start);
      const block = rest.slice(rest.indexOf("{") + 1, rest.search(/^\s*\}\s*$/m));
      const re = /^\s*((?:\[[^\]]*\]\s*)*)([A-Za-z_][\w]*)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*([A-Za-z0-9]+)[^=\n]*=\s*(.*)$/gm;
      for (const m of block.matchAll(re)) {
        const attributes = [...m[1].matchAll(/\[([^\]]*)\]/g)].map((a) => a[1]);
        info.props.set(m[2], { name: m[2], label: m[3], kind: m[4], attributes, defaultValue: m[5].trim() });
      }
    }
  }
  if (file) Object.assign(info, readPassState(file));
  shaderCache.set(key, info);
  return info;
}

export function readMaterial(guid: string): UnityMaterial | null {
  if (materialCache.has(guid)) return materialCache.get(guid)!;
  const file = refToPath({ fileID: "2100000", guid });
  let result: UnityMaterial | null = null;
  if (file && file.endsWith(".mat") && fs.existsSync(file)) {
    const obj = readUnityYaml(file).find((o) => o.type === "Material");
    if (obj) {
      const d = obj.data;
      const saved = d.m_SavedProperties ?? {};
      const textures: Record<string, UnityTexEnv> = {};
      for (const [k, v] of Object.entries(listToRecord<any>(saved.m_TexEnvs))) {
        textures[k] = {
          texture: v?.m_Texture ?? { fileID: "0" },
          scale: [Number(v?.m_Scale?.x ?? 1), Number(v?.m_Scale?.y ?? 1)],
          offset: [Number(v?.m_Offset?.x ?? 0), Number(v?.m_Offset?.y ?? 0)],
        };
      }
      const floats: Record<string, number> = {};
      for (const [k, v] of Object.entries(listToRecord<any>(saved.m_Floats))) floats[k] = Number(v);
      for (const [k, v] of Object.entries(listToRecord<any>(saved.m_Ints))) floats[k] = Number(v);
      const colors: Record<string, [number, number, number, number]> = {};
      for (const [k, v] of Object.entries(listToRecord<any>(saved.m_Colors))) {
        colors[k] = [Number(v?.r ?? 0), Number(v?.g ?? 0), Number(v?.b ?? 0), Number(v?.a ?? 1)];
      }
      const keywords = [
        ...(Array.isArray(d.m_ValidKeywords) ? d.m_ValidKeywords : []),
        ...String(d.m_ShaderKeywords ?? "").split(/\s+/),
      ].filter(Boolean);
      result = {
        name: String(d.m_Name ?? path.basename(file, ".mat")),
        shader: readShader(d.m_Shader ?? { fileID: "0" }),
        keywords,
        textures,
        floats,
        colors,
      };
    }
  }
  materialCache.set(guid, result);
  return result;
}

interface Role {
  names: string[];
  label?: RegExp;
}

const ROLES = {
  baseMap: { names: ["_BaseMap", "_MainTex", "MainTex", "_Albedo", "_AlbedoMap", "_BaseTex", "_Diffuse"], label: /^(base (texture|map|color map)|albedo|main tex(ture)?|diffuse|texture)$/i },
  baseMapArray: { names: ["_Base_Maps", "_BaseMaps"] },
  baseColor: { names: ["_BaseColor", "_Color", "_MainColor", "_Tint", "_TintColor"], label: /^(base )?colou?r$|^tint$|^albedo colou?r$/i },
  normalMap: { names: ["_BumpMap", "_NormalMap"], label: /^normal( map)?$/i },
  normalScale: { names: ["_BumpScale", "_NormalStrength", "_NormalScale"] },
  emissionMap: { names: ["_EmissionMap", "Mask_R_Emission", "_EmissiveMap"], label: /^emission (map|mask.*)$/i },
  emissionColor: { names: ["_EmissionColor", "_EmissiveColor"], label: /^emission colou?r$/i },
  metallic: { names: ["_Metallic"] },
  smoothness: { names: ["_Smoothness", "_Glossiness"] },
  cutoff: { names: ["_Cutoff", "_AlphaClipThreshold", "_AlphaCutoff"] },
} satisfies Record<string, Role>;

function findProp(shader: ShaderInfo, role: Role, kinds?: string[]): string | undefined {
  const ok = (p: ShaderProp | undefined) => !!p && (!kinds || kinds.includes(p.kind));
  for (const n of role.names) if (ok(shader.props.get(n))) return n;
  if (role.label) for (const p of shader.props.values()) if (ok(p) && role.label.test(p.label)) return p.name;
  return undefined;
}

const COLOR_KINDS = ["Color", "Vector"];
const TEX_KINDS = ["2D"];
const ARRAY_KINDS = ["2DArray"];
const NUM_KINDS = ["Float", "Range", "Int"];

/** Unity serializes material colors in gamma space; glTF factors are linear. */
function srgbToLinear(c: number): number {
  const s = Math.sign(c);
  const a = Math.abs(c);
  return s * (a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4));
}

/**
 * Unity color -> linear. HDR colors (any channel > 1) are stored the way Unity's HDR picker writes
 * them: a gamma-space base color times a power-of-two intensity (e.g. game data's
 * `Color(0,2.007843,5.992157,0)` = (0, 64, 191)/255 x 8). Linearize the base, then re-apply the
 * intensity, rather than pushing the raw value through the sRGB curve (6.0 would become ~66 and
 * wash the hue out to white).
 */
function colorToLinear(c: number[]): [number, number, number, number] {
  const peak = Math.max(c[0], c[1], c[2]);
  const k = peak > 1 ? Math.pow(2, Math.ceil(Math.log2(peak))) : 1;
  return [srgbToLinear(c[0] / k) * k, srgbToLinear(c[1] / k) * k, srgbToLinear(c[2] / k) * k, c[3] ?? 1];
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

interface TextureStats {
  hasAlpha: boolean;
  /** Fraction of pixels with alpha < 0.5, when hasAlpha. */
  cutoutFraction: number;
  /** Mean HSV saturation of opaque pixels: ~0 for grayscale tint masks. */
  saturation: number;
}

const statsCache = new Map<string, Promise<TextureStats>>();

/** `key` identifies the image in the cache; `input` is the file itself or, for a slice, its encoded pixels. */
function textureStats(key: string, input: string | Buffer = key): Promise<TextureStats> {
  const file = key;
  let p = statsCache.get(file);
  if (!p) {
    p = (async () => {
      const img = sharp(input);
      const meta = await img.metadata();
      const { data } = await img.ensureAlpha().resize(128, 128, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
      let sat = 0, n = 0, cut = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) { cut++; continue; }
        const mx = Math.max(data[i], data[i + 1], data[i + 2]);
        const mn = Math.min(data[i], data[i + 1], data[i + 2]);
        sat += mx ? (mx - mn) / mx : 0;
        n++;
      }
      return { hasAlpha: !!meta.hasAlpha, cutoutFraction: cut / (data.length / 4), saturation: n ? sat / n : 0 };
    })();
    statsCache.set(file, p);
  }
  return p;
}

export class MaterialContext {
  private textures = new Map<string, Texture>();
  private slices = new Map<string, { texture: Texture; stats: TextureStats }>();
  private materials = new Map<string, Material>();
  constructor(readonly doc: Document) {}

  texture(ref: Ref): { texture: Texture; file: string } | undefined {
    const file = refToPath(ref);
    if (!file || !fs.existsSync(file)) return undefined;
    const ext = path.extname(file).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : undefined;
    if (!mime) return undefined; // e.g. .exr/.tga -- not web-loadable; recorded in extras only
    let tex = this.textures.get(file);
    if (!tex) {
      tex = this.doc.createTexture(path.basename(file, ext)).setImage(fs.readFileSync(file)).setMimeType(mime).setURI(path.basename(file));
      this.textures.set(file, tex);
    }
    return { texture: tex, file };
  }

  /**
   * One layer of a Texture2DArray. AssetRipper exports an array as a single PNG with the square
   * layers stacked top to bottom, so layer `index` is the `index`-th square from the top.
   */
  async textureSlice(ref: Ref, index: number): Promise<{ texture: Texture; stats: TextureStats } | undefined> {
    const file = refToPath(ref);
    if (!file || !fs.existsSync(file) || !/\.png$/i.test(file)) return undefined;
    const { width, height } = await sharp(file).metadata();
    if (!width || !height) return undefined;
    const layer = Math.min(Math.max(index, 0), Math.max(1, Math.floor(height / width)) - 1);
    const key = `${file}#${layer}`;
    let hit = this.slices.get(key);
    if (!hit) {
      const png = await sharp(file).extract({ left: 0, top: layer * width, width, height: Math.min(width, height - layer * width) }).png().toBuffer();
      const name = `${path.basename(file, path.extname(file))}_${layer}`;
      const texture = this.doc.createTexture(name).setImage(png).setMimeType("image/png").setURI(`${name}.png`);
      hit = { texture, stats: await textureStats(key, png) };
      this.slices.set(key, hit);
    }
    return hit;
  }

  /** Number of layers in the material's base texture array (0 when it has none). */
  async layerCount(mat: UnityMaterial): Promise<number> {
    const prop = findProp(mat.shader, ROLES.baseMapArray, ARRAY_KINDS);
    const env = prop ? mat.textures[prop] : undefined;
    const file = env && !isNullRef(env.texture) ? refToPath(env.texture) : undefined;
    if (!file || !fs.existsSync(file) || !/\.png$/i.test(file)) return 0;
    const { width, height } = await sharp(file).metadata();
    return width && height ? Math.max(1, Math.floor(height / width)) : 0;
  }

  /** One glTF material per (Unity material, runtime flags, array layer) within a document. */
  async material(guid: string, opts: TranslateOptions = {}): Promise<Material | null> {
    const key = `${guid}|${(opts.runtime ?? []).join(",")}|${opts.layer ?? ""}`;
    const hit = this.materials.get(key);
    if (hit) return hit;
    const mat = readMaterial(guid);
    if (!mat) return null;
    const out = await translateMaterial(this, mat, opts);
    this.materials.set(key, out);
    return out;
  }

  /** Sets the translated material on `prim`, moving COLOR_0 aside unless the shader reads vertex colors. */
  async assign(prim: Primitive, guid: string, opts: TranslateOptions = {}): Promise<Material | null> {
    const unity = readMaterial(guid);
    // A texture array's layers are interchangeable looks (the game picks one per tile): one variant each.
    const layers = unity ? await this.layerCount(unity) : 0;
    const mat = await this.material(guid, layers > 1 ? { ...opts, layer: 0 } : opts);
    if (!mat) return null;
    prim.setMaterial(mat);
    if (layers > 1) {
      const perLayer = await Promise.all(Array.from({ length: layers }, (_, i) => this.material(guid, { ...opts, layer: i })));
      setVariants(this.doc, prim, perLayer, layers);
    }
    if (unity && !usesVertexColors(unity)) demoteVertexColors(prim);
    return mat;
  }
}

/**
 * Tints decided at runtime that the viewer must supply: `hexTerrainColor` (terrain-sampled),
 * `hairColor` / `bodyColor` (BodyColor/HairColor rows' `color`), `maskPattern` (replace with a
 * MaskPatterns material).
 */
export type RuntimeFlag = "hexTerrainColor" | "hairColor" | "bodyColor" | "maskPattern";

export interface TranslateOptions {
  runtime?: RuntimeFlag[];
  /** Layer of the base texture array to use instead of the material's `_TextureIndex`. */
  layer?: number;
}

/** Shaders whose `_EmissionColor` only applies when the `_EMISSION` keyword is enabled. */
const KEYWORD_GATED_EMISSION = /^(Universal Render Pipeline\/(Lit|Simple Lit|Complex Lit|Baked Lit)|FlatKit\/)/;

/** Shaders known to multiply albedo by vertex color without a declared toggle. */
const VERTEX_COLOR_SHADERS: RegExp[] = [/Particles\//, /Sprites\//, /UI\//];

const unresolvedShaders = new Map<string, number>();

/** Warns about shaders whose `Properties` block couldn't be read, once per run. */
export function reportUnresolvedShaders() {
  if (unresolvedShaders.size) console.warn("Shaders without a readable Properties block:", Object.fromEntries(unresolvedShaders));
}

/** Stats of the material's base texture (undefined when it has none). */
export async function baseTextureStats(mat: UnityMaterial): Promise<TextureStats | undefined> {
  const prop = findProp(mat.shader, ROLES.baseMap, TEX_KINDS);
  const env = prop ? mat.textures[prop] : undefined;
  const file = env && !isNullRef(env.texture) ? refToPath(env.texture) : undefined;
  return file && fs.existsSync(file) && /\.(png|jpe?g)$/i.test(file) ? textureStats(file) : undefined;
}

/** Below this mean saturation a base texture is a grayscale mask meant to be tinted. */
export const TINT_MASK_SATURATION = 0.1;

function usesVertexColors(mat: UnityMaterial): boolean {
  const toggle = mat.shader.props.get("_VertexColorsEnabled") ?? mat.shader.props.get("_UseVertexColor");
  if (toggle) return (mat.floats[toggle.name] ?? 0) === 1;
  return VERTEX_COLOR_SHADERS.some((r) => r.test(mat.shader.name));
}

async function translateMaterial(ctx: MaterialContext, mat: UnityMaterial, opts: TranslateOptions): Promise<Material> {
  const { doc } = ctx;
  const sh = mat.shader;
  const out = doc.createMaterial(mat.name);
  const runtime = new Set<RuntimeFlag>(opts.runtime ?? []);
  const extras: Record<string, any> = { shader: sh.name, material: mat.name };

  // Declared props, minus lightmap internals and hidden pipeline bookkeeping.
  const props: Record<string, any> = {};
  const labels: Record<string, string> = {};
  for (const p of sh.props.values()) {
    if (p.name.startsWith("unity_")) continue;
    if (p.attributes.includes("HideInInspector") && !["_Cull", "_Surface", "_Blend", "_SrcBlend", "_DstBlend", "_AlphaClip"].includes(p.name)) continue;
    if (TEX_KINDS.includes(p.kind) || ARRAY_KINDS.includes(p.kind)) {
      const t = mat.textures[p.name];
      if (t && !isNullRef(t.texture)) {
        const file = refToPath(t.texture);
        props[p.name] = file ? path.basename(file, path.extname(file)) : `missing:${t.texture.guid}`;
      }
    } else if (COLOR_KINDS.includes(p.kind)) {
      if (mat.colors[p.name]) props[p.name] = mat.colors[p.name].map(round);
    } else if (p.name in mat.floats) {
      props[p.name] = round(mat.floats[p.name]);
    }
    if (/_[0-9a-f]{8,}/i.test(p.name) || /^(Color|Vector1|Vector2|Boolean|Texture2D)_[0-9A-F]{8}$/.test(p.name)) labels[p.name] = p.label;
  }
  extras.props = props;
  if (Object.keys(labels).length) extras.labels = labels;
  if (sh.props.size === 0) unresolvedShaders.set(sh.name, (unresolvedShaders.get(sh.name) ?? 0) + 1);

  // Base color + texture.
  const baseMapProp = findProp(sh, ROLES.baseMap, TEX_KINDS);
  const baseColorProp = findProp(sh, ROLES.baseColor, COLOR_KINDS);
  let baseTexStats: TextureStats | undefined;
  // A texture array's layer (picked by `_TextureIndex`) replaces the shader's single-texture fallback.
  const arrayProp = findProp(sh, ROLES.baseMapArray, ARRAY_KINDS);
  const arrayEnv = arrayProp ? mat.textures[arrayProp] : undefined;
  const slice = arrayEnv && !isNullRef(arrayEnv.texture) ? await ctx.textureSlice(arrayEnv.texture, opts.layer ?? Math.round(mat.floats["_TextureIndex"] ?? 0)) : undefined;
  if (slice) {
    out.setBaseColorTexture(slice.texture);
    baseTexStats = slice.stats;
  } else if (baseMapProp) {
    const env = mat.textures[baseMapProp];
    const t = env && !isNullRef(env.texture) ? ctx.texture(env.texture) : undefined;
    if (t) {
      out.setBaseColorTexture(t.texture);
      applyTransform(doc, out.getBaseColorTextureInfo()!, env);
      baseTexStats = await textureStats(t.file);
    }
  }
  if (sh.props.has("_UseHexTerrainColor") && (mat.floats["_UseHexTerrainColor"] ?? 1) === 1) runtime.add("hexTerrainColor");
  const baseColor = baseColorProp && mat.colors[baseColorProp] ? colorToLinear(mat.colors[baseColorProp]) : ([1, 1, 1, 1] as [number, number, number, number]);
  const runtimeColor = runtime.has("hexTerrainColor") || runtime.has("hairColor") || runtime.has("bodyColor");
  // FakePointLight draws a screen-space glow tinted by `_LightTint` (its `_EmissionColor` is an unused
  // white placeholder); export it as a black, tint-alpha surface that only emits the tint.
  const lightTint = /FakePointLight/.test(sh.name) ? mat.colors["_LightTint"] : undefined;
  if (lightTint) {
    out.setBaseColorFactor([0, 0, 0, colorToLinear(lightTint)[3]]);
  } else if (runtimeColor) {
    // Leave the base factor white; the viewer supplies the runtime color (fallback in extras).
    extras.fallbackColor = baseColor.map(round);
    out.setBaseColorFactor([1, 1, 1, baseColor[3]]);
  } else {
    out.setBaseColorFactor(baseColor);
  }

  // PBR: these are toon/unlit-ish shaders. Never metallic unless the shader says so.
  const metallicProp = findProp(sh, ROLES.metallic, NUM_KINDS);
  const smoothProp = findProp(sh, ROLES.smoothness, NUM_KINDS);
  out.setMetallicFactor(metallicProp ? mat.floats[metallicProp] ?? 0 : 0);
  out.setRoughnessFactor(smoothProp ? 1 - (mat.floats[smoothProp] ?? 0) : 1);

  // Normal map.
  const normalProp = findProp(sh, ROLES.normalMap, TEX_KINDS);
  if (normalProp) {
    const env = mat.textures[normalProp];
    const t = env && !isNullRef(env.texture) ? ctx.texture(env.texture) : undefined;
    if (t) {
      out.setNormalTexture(t.texture);
      const scaleProp = findProp(sh, ROLES.normalScale, NUM_KINDS);
      if (scaleProp) out.setNormalScale(mat.floats[scaleProp] ?? 1);
    }
  }

  // Emission.
  const emColorProp = lightTint ? "_LightTint" : findProp(sh, ROLES.emissionColor, COLOR_KINDS);
  const emEnabled = !KEYWORD_GATED_EMISSION.test(sh.name) || mat.keywords.includes("_EMISSION");
  if (emColorProp && emEnabled && mat.colors[emColorProp]) {
    const c = colorToLinear(mat.colors[emColorProp]);
    const peak = Math.max(c[0], c[1], c[2]);
    const emMapProp = findProp(sh, ROLES.emissionMap, TEX_KINDS);
    const env = emMapProp ? mat.textures[emMapProp] : undefined;
    const t = env && !isNullRef(env.texture) ? ctx.texture(env.texture) : undefined;
    // An unassigned texture slot samples its declared default: a "black" emission mask (e.g. the
    // cel shader's Mask_R_Emission) means no emission at all, whatever the color says.
    const maskedOff = !!emMapProp && !t && /^"black"/.test(sh.props.get(emMapProp)!.defaultValue);
    if (peak > 0 && !maskedOff) {
      if (t) out.setEmissiveTexture(t.texture);
      if (peak > 1) {
        out.setEmissiveFactor([c[0] / peak, c[1] / peak, c[2] / peak]);
        const ext = doc.createExtension(KHRMaterialsEmissiveStrength);
        out.setExtension("KHR_materials_emissive_strength", ext.createEmissiveStrength().setEmissiveStrength(peak));
      } else {
        out.setEmissiveFactor([c[0], c[1], c[2]]);
      }
    }
  }

  // Alpha / blending.
  const f = (n: string) => (sh.props.has(n) ? mat.floats[n] : undefined);
  const surface = f("_Surface");
  const src = f("_SrcBlend"), dst = f("_DstBlend");
  // Blend factors come from the material's properties, or from the shader pass when it hardcodes them.
  const dstBlend = src !== undefined && dst !== undefined ? dst : sh.blend?.dst;
  if (surface === 1 || (dstBlend !== undefined && dstBlend !== 0)) {
    out.setAlphaMode("BLEND");
    // One/One and SrcAlpha/One are additive.
    if (dstBlend === 1) extras.blend = "additive";
    if (sh.zWrite === false) extras.zWrite = false;
  } else if (f("_AlphaClip") === 1 || (findProp(sh, ROLES.cutoff, NUM_KINDS) && f("_AlphaClip") !== 0) || sh.queue === "AlphaTest") {
    // Shader Graph sets _AlphaClip=1 on every material by default; only honor it when the base
    // texture actually has cut-out pixels.
    if (baseTexStats?.hasAlpha && baseTexStats.cutoutFraction > 0.001) {
      out.setAlphaMode("MASK");
      const cutoffProp = findProp(sh, ROLES.cutoff, NUM_KINDS);
      out.setAlphaCutoff(cutoffProp ? mat.floats[cutoffProp] ?? 0.5 : 0.5);
    }
  }

  // Culling: 0 = Off (both faces). URP Shader Graph uses _RenderFace (0 = both).
  const cull = f("_Cull") ?? f("_CullMode") ?? f("_Cull_Mode");
  if (cull === 0 || f("_RenderFace") === 0 || /double ?sided/i.test(sh.name)) out.setDoubleSided(true);

  // Depth-only masks draw nothing visible. glTF can't express "depth only", so make them fully
  // transparent (invisible in any viewer) and keep the real intent in extras for a renderer that
  // reproduces the effect (e.g. hiding an ocean surface inside a hull).
  if (sh.colorWrite === false) {
    extras.colorWrite = false;
    out.setAlphaMode("BLEND").setBaseColorFactor([1, 1, 1, 0]).setBaseColorTexture(null).setEmissiveFactor([0, 0, 0]).setEmissiveTexture(null);
  }
  // Decal shaders (e.g. DirtDecal) compute their alpha procedurally in the shader graph, which
  // can't be evaluated offline: left alone they render as an opaque white slab over the surface.
  if (/decal/i.test(sh.name) && out.getAlphaMode() === "BLEND") {
    extras.decal = true;
    out.setBaseColorFactor([1, 1, 1, 0]).setBaseColorTexture(null).setEmissiveFactor([0, 0, 0]).setEmissiveTexture(null);
  }
  if (sh.queue) extras.queue = sh.queue;
  if (runtime.size) extras.runtime = [...runtime];
  out.setExtras({ unity: extras });
  return out;
}

function applyTransform(doc: Document, info: TextureInfo, env: UnityTexEnv) {
  const [sx, sy] = env.scale;
  const [ox, oy] = env.offset;
  if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return;
  // Unity UVs have their origin bottom-left, glTF top-left; AssetRipper already flips V in the
  // mesh, so a Unity offset/scale (u' = u*s + o) maps to glTF as v' = v*s + (1 - s - o).
  const ext = doc.createExtension(KHRTextureTransform);
  info.setExtension("KHR_texture_transform", ext.createTransform().setScale([sx, sy]).setOffset([ox, 1 - sy - oy]));
}
