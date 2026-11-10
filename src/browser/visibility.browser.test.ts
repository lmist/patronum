import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "./stagehand.js";

test("Stagehand CDP focus emulation keeps two local tabs visible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-visibility-"));
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "local-fixture-only";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<main>Fixture</main>", { headers: { "content-type": "text/html" } }) });
  const stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache"), headless: true });
  try {
    await stagehand.init();
    const first = stagehand.context.pages()[0]!;
    const second = await stagehand.context.newPage();
    const url = `http://127.0.0.1:${server.port}/`;
    await Promise.all([
      first.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 15_000 }),
      second.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 15_000 }),
    ]);
    const visibility = async () => Promise.all([first, second].map((page) => page.evaluate<{ visibility: string; focused: boolean }>("({ visibility: document.visibilityState, focused: document.hasFocus() })")));
    const before = await visibility();
    await Promise.all([first, second].map((page) => page.sendCDP("Emulation.setFocusEmulationEnabled", { enabled: true })));
    const after = await visibility();
    console.log(`[visibility-fixture] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect(after.map((tab) => tab.visibility)).toEqual(["visible", "visible"]);
  } finally {
    await stagehand.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
  }
}, 90_000);
