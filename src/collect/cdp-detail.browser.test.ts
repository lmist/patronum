import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "../browser/stagehand.js";
import { DetailNavigationTimeout } from "./rejections.js";
import { harvestEmbeddedPostMedia } from "./read-post.js";
import { navigateDetailPage } from "./open-post.js";
import { CdpDetailBrowser, isTabLostError } from "./cdp-detail.js";

/** Real Chrome: a /reel/ link redirected to /reels/ while the document keeps
 * streaming must resolve from the exact embedded record on a raw CDP tab. */
test("CDP detail tab reads a redirected, still-streaming reel record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-cdp-detail-"));
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "local-fixture-only";
  const encoder = new TextEncoder();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const reel = (code: string) => ({
    code, media_type: 2, taken_at: 1789400000, caption: { text: `Reel ${code}` },
    like_count: 41, comment_count: 7, video_dash_manifest: '<MPD mediaPresentationDuration="PT15.5S">',
    image_versions2: { candidates: [{ width: 720, height: 1280, url: `https://cdn.test/${code}.jpg` }] },
    video_versions: [{ width: 720, height: 1280, url: `https://cdn.test/${code}.mp4` }],
  });
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      const match = /^\/reel\/([\w-]+)\/$/.exec(url.pathname);
      if (match) return Response.redirect(`${url.origin}/reels/${match[1]}/`, 302);
      const code = /^\/reels\/([\w-]+)\/$/.exec(url.pathname)?.[1] ?? "NONE";
      // The Clips viewer embeds neighbours too; WRONG embeds only a neighbour.
      const records = code === "WRONG" ? [reel("NEIGHBOUR")] : [reel("NEIGHBOUR"), reel(code)];
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          controllers.push(c);
          c.enqueue(encoder.encode(`<html><head><script type="application/json">${JSON.stringify({ feed: records })}</script></head><body><main>Clips</main>`));
        },
      }), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache"), headless: true });
  const cdp = new CdpDetailBrowser(() => stagehand.connectURL());
  try {
    await stagehand.init();
    const tab = await cdp.newTab();
    await tab.sendCDP("Emulation.setFocusEmulationEnabled", { enabled: true });
    const started = Date.now();
    await navigateDetailPage(tab, `http://127.0.0.1:${server.port}/reel/CLIP/`, 5_000);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(tab.url()).toBe(`http://127.0.0.1:${server.port}/reels/CLIP/`);
    const state = await tab.evaluate<{ ready: string }>("({ ready: document.readyState })");
    expect(state.ready).toBe("loading");
    const embedded = await harvestEmbeddedPostMedia(tab, "CLIP", 1);
    expect(embedded).toMatchObject({
      type: "video", mediaUrls: ["https://cdn.test/CLIP.mp4"], caption: "Reel CLIP",
      likeCount: 41, commentCount: 7, videoDurationSec: 15.5,
    });

    const wrong = await cdp.newTab();
    await expect(navigateDetailPage(wrong, `http://127.0.0.1:${server.port}/reel/WRONG/`, 1_500))
      .rejects.toBeInstanceOf(DetailNavigationTimeout);
    // The watchdog closed that tab; reusing it must fail fast as a lost tab.
    expect(isTabLostError(await wrong.sendCDP("Page.navigate", { url: "about:blank" }).catch((error) => error))).toBe(true);
  } finally {
    for (const controller of controllers) {
      try { controller.enqueue(encoder.encode("</body></html>")); controller.close(); } catch { /* already closed */ }
    }
    await cdp.close();
    await stagehand.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
  }
}, 90_000);
