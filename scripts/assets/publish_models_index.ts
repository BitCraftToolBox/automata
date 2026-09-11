// Final publish step: writes `index.json` at the models root, every published model keyed by output
// path without ".glb" with its kind, size and sha1. Nothing is ever deleted. See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { modelsDir } from "./lib/env";
import { ManifestEntry } from "./lib/gltf";

const KINDS = ["prefabs", "resources", "customization", "equipment", "hextiles"];

const models: Record<string, { kind: string; size: number; sha1: string }> = {};

for (const kind of KINDS) {
  const file = path.join(modelsDir, `manifest_${kind}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`No manifest for ${kind}; its models are not indexed.`);
    continue;
  }
  const manifest: Record<string, ManifestEntry> = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [key, entry] of Object.entries(manifest)) {
    const out = path.join(modelsDir, entry.file);
    if (!fs.existsSync(out)) continue;
    if (models[key]) console.warn(`Output key "${key}" is published by both ${models[key].kind} and ${kind}`);
    const buf = fs.readFileSync(out);
    models[key] = { kind, size: buf.length, sha1: crypto.createHash("sha1").update(buf).digest("hex") };
  }
}

const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(path.join(modelsDir, "index.json"), JSON.stringify({ version: 1, models: sorted }, null, 1) + "\n");
console.log(`index.json: ${Object.keys(models).length} models.`);
