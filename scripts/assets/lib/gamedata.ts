// Reads the `wanted_*.json` field lists and the game-data values they select.

import * as fs from "fs";
import * as path from "path";
import { gameDataDir } from "./env";

export interface WantedField {
  table: string;
  field: string;
}

/** Reads a `wanted_*.json` list from the scripts/assets folder. */
export function readWanted<T extends WantedField>(file: string): T[] {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", file), "utf8"));
}

/**
 * Every non-empty string value of each wanted field, with the row and wanted entry it came from.
 * Array-valued fields yield one value per element. Tables absent from the game data are skipped
 * with a warning.
 */
export function* wantedValues<T extends WantedField>(wanted: T[]): Generator<{ entry: T; row: any; value: string }> {
  for (const entry of wanted) {
    const tableFile = path.join(gameDataDir, `${entry.table}.json`);
    if (!fs.existsSync(tableFile)) {
      console.warn(`Skipping ${entry.table}.${entry.field}: table file not found at ${tableFile}`);
      continue;
    }
    for (const row of JSON.parse(fs.readFileSync(tableFile, "utf8"))) {
      const raw = row[entry.field];
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value === "string" && value !== "") yield { entry, row, value };
      }
    }
  }
}
