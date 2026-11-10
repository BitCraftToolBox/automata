# Model pipeline

Turns the game client and static game data into one `.glb` per displayable game object, published to
the `BitCraft_Models` repo for the model viewer. The viewer knows only table values (e.g.
`model_asset_name`), so every output path is computable from a game-data value; no metadata fetch is
needed first. Everything unambiguous is baked into standard glTF; what depends on runtime state or
the shader stays in `extras.unity` for the viewer.

## Quick reference

| Publisher | Game-data input | Resolved through | Output (`<models>/…`) |
| --- | --- | --- | --- |
| `publish_prefabs.ts` | `wanted_prefabs.json` fields | `prefabs.json` key `<prefix>/<value>` | `<value>.glb` |
| `publish_resources.ts` | `resource_desc.model_asset_name` | `ScriptableObjects/<value>` → `ResourceModels.available` | `<value>.glb` |
| `publish_customization.ts` | `collectible_desc.model_asset_name` (not pets; pets are prefabs) | `ScriptableObjects/Customization/<Category>/<Name>` | `Customization/<value>.glb`, `Customization/Default/<collectible_type>.glb`, `Customization/DefaultBodyColor.glb`, `Customization/MaskPatterns.glb` |
| `publish_equipment.ts` | `equipment_desc.hand_equipment_visual.prefab_names` (GUIDs) | catalog key = GUID | `<guid>.glb` |
| `publish_hextiles.ts` | `pillar_shaping_desc.prefab_address` | catalog key = value | `<value>.glb` |
| `publish_models_index.ts` | – | every `manifest_<kind>.json` | `index.json` |

Shared code is in `lib/`:

| File | Responsibility |
| --- | --- |
| `env.ts` | paths, CLI flags |
| `gamedata.ts` | `wanted_*.json` loading, game-data value iteration |
| `unity.ts` | GUID index, Unity YAML, prefabs, mesh bind poses |
| `materials.ts` | `.mat` + shader → glTF material |
| `meshes.ts` | Mesh `.asset` YAML (and Unity's built-in primitives) to glTF vertex/index arrays |
| `prefab.ts` | building prefab YAML into glTF models, `publishPrefabSet` |
| `rig.ts` | player skeleton, rigged parts |
| `gltf.ts` | glTF I/O, fingerprints and manifests, mesh import, skins, variants, compress + write |
| `math.ts` | matrix helpers |

## Stages

1. **AssetRipper Unity Project export** (`unity-asset-ripper.js`): YAML `.prefab`/`.asset`/`.mat`/`.meta`,
   plus sprites, icon fonts and translations. It is the source of ScriptableObject contents, prefab
   components, materials and geometry: `lib/meshes.ts` decodes each `Mesh/*.asset` YAML (plain and
   bit-packed compressed meshes; blend shapes are unsupported and skipped with a warning) into glTF
   space (X mirrored, winding reversed, V flipped). The workflow deletes it after the last publisher.
2. **Shader JSON**, same run: while the AssetRipper server is still up, the script walks every loaded
   collection and saves each Shader asset's `/Assets/Json` to `extracted-shaders/<name, / as _>.json`.
   That parsed form holds the pass state (blend factors, `ZWrite`, `ColorMask`, queue) which the
   project export's stub `.shader` files lack. Publishers refuse to run without it. Same-named
   shaders (the project export numbers them `Name_0`, `Name_1`, ...) share one file: all 58 such
   groups in the current client have identical pass state, and the extraction warns if a group stops
   matching.
3. **Catalog** (`read-asset-catalog.ts`): `prefabs.json` (GameObject entries: key → project path) and
   `scriptable_objects.json` (key → `{ id, type }` for the ScriptableObject types the publishers read).
4. **Publishers**, then `publish_models_index.ts`, in the order of the table above.

## Name → catalog → object

- A game-data value is turned into a catalog key (prefix per `wanted_*.json`, or none), and the
  catalog gives the asset's project path (`internalId`).
- Resolve through the catalog, never by file name: a ScriptableObject's key often differs from its
  file's basename (`Torso_Basic Dress A` → `Torso_BasicDressA.asset`, `T9Baitfish` →
  `SchoolOfT9Baitfish.asset`).
- GUIDs in game data (equipment, walls, elevators) are the original project GUIDs, which only the
  catalog knows. The Unity Project export assigns its own GUIDs; `guidToPath` is valid only for
  references found inside exported YAML.
- Output paths mirror the raw game-data value. Two values resolving to different assets under one
  path are reported and skipped; two publishers claiming one path are reported by the index step.

## Prefabs

The project export's prefab YAML is flat (no nested `PrefabInstance`). `lib/prefab.ts` builds the glTF
from it:

- **Nodes**: one per GameObject in child order. Local transforms convert to glTF space (position.x
  negated; quaternion y and z negated). A root keeps only its scale: its position and rotation are
  where the prefab sits in the editor (wall parts are hundreds of units from the origin), while the
  game keeps the scale on instantiation, so models stay comparable at game size. Compositions in
  brico (`lib/models.ts`) place separate files at metre offsets from their roots.
- **Meshes**: one per MeshFilter, decoded by `lib/meshes.ts`. Unity's built-in primitives
  (`guid 0000000000000000e000000000000000`) are generated: Cube, Quad and Plane match Unity's geometry;
  Sphere and Cylinder are approximations.
- **Materials**: each renderer's `m_Materials` per submesh, translated by `lib/materials.ts`.
- **SkinnedMeshRenderers** (animals, enemies, NPC bodies, sails) get the decoded mesh, the renderer's
  `m_Bones` and the mesh's own bind poses. The mesh
  sits on a `<name>_SkinnedMesh` child whose world matrix is identity, because three.js binds with
  the node's world matrix while the glTF spec ignores it.
- **Extras** on nodes (`extras.unity`): `lod: n` (LODGroup level, 0 = most detailed),
  `rendererEnabled: false`, `active: false`.
- **PrefabRandomizer**: prefabs with no geometry that instantiate one weighted-random prefab at
  runtime get every variant inlined under `RandomVariant_<i>` with
  `randomVariant: { index, weight, prefab }`; variants after the first are `active: false`.
  Inlining stops at depth 3.
- A prefab without YAML in the Unity export is reported as missing and not published.

## Materials

- Only properties the shader's `Properties {}` block declares are used (materials carry stale values
  from earlier shaders). Roles are found by property name, then by inspector label.
- Baked into glTF: base color texture and factor, normal map, emissive, metallic/roughness (never
  metallic unless declared), `alphaMode`/`alphaCutoff` (`_AlphaClip` is honored only when the base
  texture has cut-out pixels), `doubleSided` (`_Cull`, `_RenderFace`), texture transform.
- Colors: the project is linear, so `.mat` colors are sRGB → linear. HDR colors (any channel > 1) are
  a gamma base times a power-of-two intensity: linearize `c/k` and re-apply `k = 2^ceil(log2(max))`.
  Emissive uses `KHR_materials_emissive_strength` for the peak. An unassigned emission mask whose
  shader default is `"black"` means no emission.
- COLOR_0 is moved to `_COLOR_0` unless the shader reads vertex colors.
- Depth-only shaders (all drawing passes have `ColorMask 0`, e.g. `Stylized Water 2 (Hole)`) become
  fully transparent with `extras.unity.colorWrite = false` and `queue`.
- Blending: `alphaMode` is `BLEND` when the material's `_Surface`/`_SrcBlend`/`_DstBlend` say so or,
  without those properties, when the shader's first drawing pass hardcodes a destination blend other
  than Zero (`FakePointLight` One/One, `bitcraft_fire` SrcAlpha/OneMinusSrcAlpha). One as destination
  also sets `extras.unity.blend = "additive"`, and a shader-fixed `ZWrite Off` sets `zWrite = false`.
  Parsed-shader values are read as `m_Val` or `m_Value` (AssetRipper 1.3.14 renamed it).
- `FakePointLight` materials (lamp and gate lights) export base color black with the `_LightTint`
  alpha, and emissive from `_LightTint`; the shader's `_EmissionColor` (white) is ignored.
- Texture arrays: AssetRipper exports a `Texture2DArray` as one PNG with the square layers stacked top
  to bottom. A material's `_Base_Maps` layer `_TextureIndex` becomes the base color texture (the
  `PavementShader` sprite, which replaces the shader's single-texture fallback `_Base_Map`). A
  multi-layer array is exported as `KHR_materials_variants`: variant `i` is layer `i` (the game picks
  one per tile), and variant 0 is the default. Layer order is assumed to be top to bottom.
- Cutout: a shader in the `AlphaTest` queue gets `alphaMode: MASK` when its base texture has cut-out pixels.
- Decals: blended shaders named `*Decal*` (`DirtDecal`, `SnowDecal`) compute their alpha in the shader
  graph (blobby shapes that merge into neighboring tiles), which can't be evaluated offline, so they
  are exported fully transparent with `extras.unity.decal = true` instead of an opaque slab. The
  models that are only a decal (`dirtpath_paving`, `SnowDecalPavement`, `IcePavement`) are empty.
- `extras.unity`: `shader`, `material`, `props` (declared values), `labels` (GUID-named properties),
  `runtime`, `fallbackColor` (linear RGBA when the base color is runtime-driven), `blend`.
- `extras.unity.runtime` flags, which the viewer must supply:

| Flag | Meaning |
| --- | --- |
| `hexTerrainColor` | shader samples the hex tile's terrain color (`_UseHexTerrainColor`); only `fallbackColor` exists offline |
| `bodyColor` | tinted by the `BodyColor` row's `color` (skin submeshes, mask patterns) |
| `hairColor` | tinted by the `HairColor` row's `color` and `emission`; set on Hair/FacialHair materials whose base texture is grayscale (mean saturation < 0.1), so colored bandanas are excluded |
| `maskPattern` | replace with `MaskPatterns.glb` material `[MaskPattern.variant]`, emission from the row's `emission`, then apply `bodyColor` |

- Unknown shaders are reported (`Shaders without a readable Properties block`), not guessed.

## Rigged parts (customization, equipment)

`lib/rig.ts` builds the player skeleton from the `Prefabs/Player` prefab: the 71 bones of its
SkinnedMeshRenderers, plus ancestors, with rest-pose transforms from the prefab. Every part file
holds its own copy of that skeleton and a real glTF skin:

- IBMs are the part mesh's own `m_BindPose`. Bind poses differ between part kinds (tools are bound in a
  different pose and weighted to `CTRL-TOOL.R`), so an unskinned tool would not land in the hand.
- Unity matrices convert as `S·M·S` with `S = diag(-1,1,1)` (AssetRipper mirrors X).
- JOINTS_0 index each mesh's own bone list; meshes with shorter lists (hairstyles 15-18 omit
  `CTRL-BOWSTRING`) are mapped through `m_BoneNameHashes`.
- Single-bone meshes (BlendIndices with no BlendWeight channel, i.e. all tools) have an implicit weight
  of 1; the decoder writes the real bone index with weight 1 (AssetRipper's glb has joints `[0, b]` /
  weights `[0.75, 0.25]` instead).
- Rigid meshes have no bind poses. `Crown` is drawn by a MeshRenderer under the player root and is
  placed under that slot node; other unskinned meshes in skinned slots (`Feet_SunkenBoots`) are placed
  under the armature (scale 100).
- Parts loaded side by side at the origin compose the character. Animation would rebind each part's
  SkinnedMesh to a shared skeleton by bone name, keeping the per-part IBMs.

## Customization

- One file per part asset (`BodyPart`/`AttachmentPart`/`HairPart`), not per collectible row.
- `materialVariants[i]` → `KHR_materials_variants` variant named `"i"`. Use `collectible_desc.variant`;
  for Hair use the `HairColor` row's `variant` (1 = `_Hexite`). FacialHair uses its own row's variant.
- Submesh count = clothing materials + 1 when `showsSkin`; the skin submesh is last and gets the
  `DefaultBodyColor` material with `bodyColor`.
- HairPart has four mesh nodes with `extras.unity.hairMesh` = `default` / `full` / `bottom` / `front`,
  chosen by the head item's `clothing_desc.mask`.
- Root `extras.unity`: `{ kind: "customization", category, partType, variants, showsSkin?, skinSubmesh? }`.
- `"Default"` is a game-data value meaning the slot's default part, published as
  `Customization/Default/<collectible_type>.glb`. Slots whose default has no mesh (Belt, Cape) get no
  file: nothing is worn.
- `DefaultBodyColor.glb` and `MaskPatterns.glb` are variant lists: materials only, no geometry
  (`extras.unity = { kind: "variantList", materials }`).

## Equipment

`prefab_names` is the list `tool_mesh_index` indexes, so the viewer loads `prefab_names[tool_mesh_index]`.
Each GUID is one pre-baked tier/rarity asset (`mesh`, `materials[]` per submesh, `meshType`); nothing
is composed at runtime. Root `extras.unity = { kind: "equipment", name, meshType }`.

## Resources

Only `ResourceModels.available` is published. `depleted` is almost always an empty placeholder, and a
depleted resource normally shows through its own `resource_desc` row (`on_destroy_yield_resource_id`),
which is published like any other. `biomeOverrides` (2 resources) are not published. A null
`available` means no model.

## Hex tile templates

One file per template with every stacking and scaling column inlined under `Column_<i>`:
`extras.unity.columnVariant = { index, kind: "stack" | "scale", height | heightRange, climbableSides, prefab }`,
columns after the first `active: false`. Stacking to arbitrary heights and `_topDecorations`
(spawn odds depend on the player's grass setting) are not reproduced. Root
`extras.unity = { kind: "hexTileTemplate", columns }`.

## Output, fingerprints, index

- **Compression** (`writeModel`): prune, dedup accessors/textures, then WebP (q90; normal maps q85 capped
  at 1024 px) and Meshopt. Nothing that joins, flattens, instances or palettes nodes/materials: the
  viewer relies on their names and extras.
- **Fingerprints**: each output's inputs are the GUID closure of its YAML (assets, materials, shaders,
  textures, meshes), the rig files for rigged parts, and `PIPELINE_VERSION`. AssetRipper makes up
  new GUIDs and in-prefab object ids on every export, so YAML is hashed in canonical form
  (`canonicalUnityYaml`: GUIDs masked, object ids renumbered by document order) and an unchanged
  asset keeps its hash across runs. Builds are deterministic too: texture-array layers and material
  variants are built one after another, never concurrently.
  Shader JSON is not hashed: bump `PIPELINE_VERSION` in `lib/gltf.ts` after any code change that
  alters output or after re-ripping with a new AssetRipper.
- **Manifests** (`manifest_<kind>.json`, key → `{ file, inputs }`) skip unchanged outputs and are
  checkpointed every 25 outputs. Entries a run doesn't produce are kept, and nothing is ever deleted:
  a model that disappears from the client data, or fails to build, stays published as it was.
- **`index.json`**: `{ version: 1, models: { "<path without .glb>": { kind, size, sha1 } } }`, the
  viewer's discovery file, built from all manifests whose output file exists.
- Memory: `sharp.cache(false)` and `sharp.concurrency(1)` may be required; a full run of WebP encodes
  otherwise exhausts native memory.

## Viewer contract

- **Paths**, all `<models>/<path>.glb`: prefabs, resources, pets and hex tile templates use the raw
  field value; customization uses `Customization/<model_asset_name>` or
  `Customization/Default/<collectible_type>` for `"Default"` or an empty slot; tools use
  `prefab_names[tool_mesh_index]`. `index.json` says what exists.
- **Variants**: apply the `KHR_materials_variants` variant (see Customization). three.js has no built-in
  support: use `parser.associations` and `getDependency('material', i)`. `SkeletonUtils.clone()` copies
  do not carry `associations`, so map clones back to their sources by parallel traversal.
- **Runtime tints**: `bodyColor` / `hairColor` apply `color.setStyle(row.color)` (sRGB hex). HDR
  `emission` is `Color(r,g,b,a)`: `k = 2^ceil(log2(max))`, emissive = sRGB(c/k), intensity `k`.
  Emissive glow in-game is HDR bloom; selective (emission-only) bloom reproduces it.
- **Hiding**: skip the whole subtree of nodes with `lod > 0` or `active === false`. `rendererEnabled
  === false` hides only that node's own mesh, never its children (the root of `WoodenWallGate` has it
  and carries the whole gate). Skip `colorWrite === false` materials. Nodes with `randomVariant` or `columnVariant` are alternatives:
  show one and hide the rest.
- **Blending**: `BLEND` materials are drawn transparent; `blend = "additive"` uses additive blending
  and `zWrite === false` disables depth writes.
- **Lighting**: `FlatKit/Stylized Surface` is not PBR (lit side = texture × `_BaseColor`, shadows step
  toward `_ColorDim*` by N·L); PBR lighting over-brightens it. `Shader Graphs/Character Cel Shader`
  looks right with standard lighting at exposure ~0.8-1.0.
- **Walls and gates**: tile centers are `2 × InnerRadius ≈ 5.7735` apart (`InnerRadius = 2.8867512`). A
  straight tile (two opposite neighbors) uses one `wall_asset_names` section chosen at random,
  centered and spanning ±InnerRadius along local x. Any other tile uses `large_post_asset_name` at the
  center plus one `small_post_asset_name` per neighbor, an arm along local +z rotated to face it. Gates
  have only `small_post_asset_name`; the gate itself is its `building_desc` model.

## Caveats

- Unity's SetVariantColor is stripped from the client, so the exact runtime tint semantics (hair
  color on facial hair, mask emission) were confirmed in-game rather than from code.
- ScriptableObjects (MonoBehaviour-derived) are only readable from the Unity Project export; the
  publishers fail if it is missing.
- Game-data assumptions: customization asset names are unique except per-slot `Default`; tool and
  customization meshes share the player's bone list apart from the hairstyle exceptions above. A game
  update breaking either shows up as `bone hash … not in rig` / duplicate-name warnings.
- `scaleGrass` hex tile columns use a terrain shader with no texture and render white.

## Local runs

Run the extraction itself against a local install (it needs `ASSETRIPPER_EXE`, the AssetRipper GUI binary,
and writes `extracted-project/` and `extracted-shaders/` under `ASSETS_WORKSPACE`):

```sh
ASSETS_WORKSPACE=/tmp/ws ASSETRIPPER_EXE="<path>/AssetRipper.GUI.Free" ASSET_FOLDER="<Steam>/BitCraft Online" node <repo>/scripts/assets/unity-asset-ripper.js
```

Point the publishers at an existing export with environment variables, from any directory:

```sh
export PROJECT_DIR="G:/…/ExportedProject" SHADER_DIR="G:/…/extracted-shaders"
export GAMEDATA_DIR="../BitCraft_GameData/static" MODELS_DIR=/tmp/models ASSETS_WORKSPACE=/tmp/ws
cd /tmp/ws   # read-asset-catalog.ts writes its JSON files to the cwd
CATALOG_FILE="<Steam>/BitCraft_Data/StreamingAssets/aa/catalog.json" npx tsx <repo>/scripts/assets/read-asset-catalog.ts
npx tsx <repo>/scripts/assets/publish_customization.ts --skip-opt --only=Torso_
```

Flags (all publishers): `--only=<substr>` (output keys containing it), `--force` (ignore
fingerprints), `--skip-opt` (skip WebP/Meshopt; never in CI).

## Verification

```sh
cd scripts/assets
npx tsc -p . --noEmit --noUnusedLocals --noUnusedParameters   # typecheck
# build a subset twice with --skip-opt into two MODELS_DIRs and compare the .glb JSON/BIN chunks
```

After a run, check the logs for: `failed` counts, `did not resolve` lists, `materials missing`,
`bone hash … not in rig`, `Mesh … skipped` (unsupported mesh), and
`Shaders without a readable Properties block`.
