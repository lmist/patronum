import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "../browser/stagehand.js";
import { InstagramHttpRejectionError } from "./rejections.js";
import { navigateDetailPage } from "./open-post.js";
import { startInstagramTraffic } from "../api-map/traffic-recorder.js";

test("empty HTTP error preserves the actual status and Retry-After", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-http-evidence-"));
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "local-fixture-only";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () =>
    new Response("", { status: 429, headers: { "retry-after": "60", "content-type": "text/html" } }),
  });
  const stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache"), headless: true });
  let traffic: Awaited<ReturnType<typeof startInstagramTraffic>> | undefined;
  try {
    await stagehand.init();
    traffic = await startInstagramTraffic(stagehand, { root: dir, handle: "fixture", allowOrigins: [`http://127.0.0.1:${server.port}`] });
    const page = stagehand.context.pages()[0]!;
    let error: unknown;
    try { await navigateDetailPage(page, `http://127.0.0.1:${server.port}/p/FAILED/`, 5_000); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(InstagramHttpRejectionError);
    expect((error as InstagramHttpRejectionError).httpStatus).toBe(429);
    expect((error as InstagramHttpRejectionError).retryAfter).toBe("60");
  } finally {
    await traffic?.close();
    await stagehand.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
  }
}, 60_000);
