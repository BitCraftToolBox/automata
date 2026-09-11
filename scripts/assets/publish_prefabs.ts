// Publishes plain-prefab models. Input: the game-data fields in wanted_prefabs.json
// ({ table, field, prefix, where? }), resolved to prefab catalog key `<prefix>/<value>` (the bare
// value when prefix is ""). Output: `<value>.glb`. See MODELS.md.

import * as fs from "fs";
import * as path from "path";
import { only, prefabCatalogFile, projectDir } from "./lib/env";
import { readWanted, WantedField, wantedValues } from "./lib/gamedata";
import { publishPrefabSet } from "./lib/prefab";

interface WantedPrefabField extends WantedField {
  prefix: string;
  /** Restricts rows to those whose column holds one of the listed values. */
  where?: Record<string, unknown[]>;
}

const wanted = readWanted<WantedPrefabField>("wanted_prefabs.json");
const catalog: Record<string, string> = JSON.parse(fs.readFileSync(prefabCatalogFile, "utf8"));

// value -> catalog internalId. Two different prefabs under one value would share an output path.
const resolved = new Map<string, string>();
const unresolved = new Set<string>();

for (const { entry, row, value } of wantedValues(wanted)) {
  if (entry.where && !Object.entries(entry.where).every(([column, allowed]) => allowed.includes(row[column]))) continue;
  const key = entry.prefix ? `${entry.prefix}/${value}` : value;
  const internalId = catalog[key];
  if (!internalId) {
    unresolved.add(`${entry.table}.${entry.field}: ${key}`);
    continue;
  }
  const existing = resolved.get(value);
  if (existing !== undefined && existing !== internalId) {
    console.warn(`Output path collision: "${value}" resolves to both ${existing} and ${internalId}`);
    continue;
  }
  resolved.set(value, internalId);
}

(async () => {
  const items = new Map<string, string>();
  for (const [value, internalId] of resolved) if (!only || value.includes(only)) items.set(value, path.join(projectDir, internalId));
  await publishPrefabSet("prefabs", items);
  console.log(`Resolved ${resolved.size} unique prefabs from game data.`);
  if (unresolved.size > 0) {
    console.warn(`${unresolved.size} game-data values did not resolve to a catalog entry:`);
    for (const k of unresolved) console.warn(`  ${k}`);
  }
})();
