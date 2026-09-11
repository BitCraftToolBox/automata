// Cuts sprites that ship inside packed atlases (Texture2D/sactx-*.png) back out into individual PNGs,
// written next to each Sprite `.asset` in the Unity Project export so that the sprite conversion
// finds them at the paths sprites.json lists.
//
// Relies on how the game's atlases are packed: every atlas sprite uses rectangle packing without
// rotation (`settingsRaw` 67) and its `textureRect` is the whole sprite. Unity measures
// `textureRect.y` from the bottom of the atlas, and the rect can be fractional, so edges are rounded.

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { projectAssetsDir } from "./lib/env";
import { readUnityYaml, refToPath } from "./lib/unity";

const SPRITES_DIR = path.join(projectAssetsDir, "_Project", "StaticAssets", "_AddressedAssets", "Sprites");
/** Packed-rectangle sprite settings: packed, rectangle mode, no rotation, tight mesh. */
const EXPECTED_SETTINGS = 67;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".asset")) out.push(p);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(SPRITES_DIR)) throw new Error(`Sprite folder not found at ${SPRITES_DIR}`);
  const atlasHeights = new Map<string, { file: string; width: number; height: number }>();
  let sliced = 0;
  const failures: string[] = [];

  for (const file of walk(SPRITES_DIR)) {
    const sprite = readUnityYaml(file, { cache: false }).find((o) => o.type === "Sprite");
    const rd = sprite?.data.m_RD;
    if (!rd) continue;
    const atlasFile = refToPath(rd.texture);
    if (!atlasFile || !path.basename(atlasFile).startsWith("sactx-")) continue;

    try {
      if (rd.settingsRaw !== EXPECTED_SETTINGS) throw new Error(`unexpected sprite settings ${rd.settingsRaw} (rotated or tight-packed?)`);
      let atlas = atlasHeights.get(atlasFile);
      if (!atlas) {
        const meta = await sharp(atlasFile).metadata();
        atlasHeights.set(atlasFile, (atlas = { file: atlasFile, width: meta.width!, height: meta.height! }));
      }
      const r = rd.textureRect;
      const left = Math.round(r.x), right = Math.round(r.x + r.width), bottom = Math.round(r.y), top = Math.round(r.y + r.height);
      if (left < 0 || bottom < 0 || right > atlas.width || top > atlas.height || right <= left || top <= bottom) throw new Error(`rect ${left},${bottom},${right},${top} outside the ${atlas.width}x${atlas.height} atlas`);
      await sharp(atlas.file)
        .extract({ left, top: atlas.height - top, width: right - left, height: top - bottom })
        .png()
        .toFile(file.replace(/\.asset$/, ".png"));
      sliced++;
    } catch (err) {
      failures.push(`${path.basename(file)}: ${(err as Error).message}`);
    }
  }

  console.log(`Sliced ${sliced} atlas sprites from ${atlasHeights.size} atlases.`);
  if (failures.length) {
    console.error(`${failures.length} sprites failed:\n  ${failures.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  if (!sliced) throw new Error("No atlas sprites found");
})();
