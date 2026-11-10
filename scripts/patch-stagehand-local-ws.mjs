#!/usr/bin/env node
/** Keep Stagehand's local CDP readiness probe safe under Bun's ws adapter.
 * A probe can emit another error while terminate() is closing it; once(error)
 * leaves that second event unhandled and aborts the whole scrape process.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [
  "node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/launch/local.js",
  "node_modules/@browserbasehq/stagehand/dist/cjs/lib/v3/launch/local.js",
];
const before = 'ws.once("error", (error) => finish(error));';
const after = 'ws.on("error", (error) => finish(error));';

for (const path of paths) {
  const file = resolve(root, path);
  const source = readFileSync(file, "utf8");
  if (source.includes(after) && !source.includes(before)) {
    console.log(`ok (already): ${path}`);
    continue;
  }
  if (!source.includes(before)) throw new Error(`Stagehand local probe changed: ${path}`);
  writeFileSync(file, source.replace(before, after));
  console.log(`patched: ${path}`);
}
