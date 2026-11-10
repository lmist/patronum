import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const modules = [
  "node_modules/@browserbasehq/stagehand/dist/esm/lib/v3/launch/local.js",
  "node_modules/@browserbasehq/stagehand/dist/cjs/lib/v3/launch/local.js",
];

test("Stagehand local probe keeps handling an error emitted during termination", () => {
  for (const path of modules) {
    const source = readFileSync(resolve(root, path), "utf8");
    expect(source).toContain('ws.on("error", (error) => finish(error));');
    expect(source).not.toContain('ws.once("error", (error) => finish(error));');
  }

  const esm = readFileSync(resolve(root, modules[0]!), "utf8");
  const start = esm.indexOf("function probeWebSocket(");
  const end = esm.indexOf("\n//# sourceMappingURL", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const patched = esm.slice(start, end);
  const original = patched.replace('ws.on("error", (error) => finish(error));', 'ws.once("error", (error) => finish(error));');

  const run = (probe: string) => spawnSync(process.execPath, ["-e", `
    import { EventEmitter } from "node:events";
    class FakeWebSocket extends EventEmitter {
      constructor() { super(); queueMicrotask(() => this.emit("error", new Error("first"))); }
      terminate() { queueMicrotask(() => this.emit("error", new Error("second"))); }
    }
    const WebSocket = FakeWebSocket;
    ${probe}
    probeWebSocket("ws://fixture", 200).catch((error) => console.log("REJECT " + error.message));
    setTimeout(() => console.log("ALIVE"), 20);
  `], { encoding: "utf8", timeout: 3_000 });

  const crashing = run(original);
  expect(crashing.status).not.toBe(0);
  expect(crashing.stderr).toMatch(/Unhandled error|second/);

  const safe = run(patched);
  expect(safe.status).toBe(0);
  expect(safe.stdout).toContain("REJECT first");
  expect(safe.stdout).toContain("ALIVE");
});
