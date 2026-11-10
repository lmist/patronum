import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "../browser/stagehand.js";
import { DetailNavigationTimeout } from "./rejections.js";
import { harvestEmbeddedPostMedia } from "./read-post.js";
import { navigateDetailPage } from "./open-post.js";
import { AuthError } from "../sign-in/auth-check.js";

test("CDP navigation exposes exact post JSON before DOMContentLoaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-stream-nav-"));
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "local-fixture-only";
  const encoder = new TextEncoder();
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const post = {
    code: "STREAM", media_type: 1, taken_at: 1789400000,
    caption: { text: "Complete while the response is streaming" },
    image_versions2: { candidates: [{ width: 900, height: 900, url: "https://cdn.test/stream.jpg" }] },
  };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/p/LOGIN/") return Response.redirect(`${url.origin}/accounts/login/`, 302);
      if (url.pathname === "/accounts/login/") return new Response("<form id='loginForm'>Log in</form>", { headers: { "content-type": "text/html" } });
      const payload = url.pathname === "/p/WRONG/" ? { ...post, code: "OTHER" } : post;
      const shell = url.pathname === "/p/WRONG/" ? '<nav><a href="/direct/inbox/">Inbox</a></nav>' : '';
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          controllers.push(c);
          c.enqueue(encoder.encode(`<html><head><script type="application/json">${JSON.stringify({ post: payload })}</script></head><body>${shell}<main>Streaming post</main>`));
        },
      }), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache"), headless: true });
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    const url = `http://127.0.0.1:${server.port}/p/STREAM/`;
    await navigateDetailPage(page, url, 5_000);
    const state = await page.evaluate<{ href: string; ready: string }>("({ href: location.href, ready: document.readyState })");
    const embedded = await harvestEmbeddedPostMedia(page, "STREAM", 1);
    expect(state?.href).toBe(url);
    expect(state?.ready).toBe("loading");
    expect(embedded?.mediaUrls).toEqual(["https://cdn.test/stream.jpg"]);
    expect(embedded?.caption).toBe(post.caption.text);
    expect(page.url()).toBe(url);

    const wrong = await stagehand.context.newPage();
    await expect(navigateDetailPage(wrong, `http://127.0.0.1:${server.port}/p/WRONG/`, 1_500))
      .rejects.toBeInstanceOf(DetailNavigationTimeout);
    const login = await stagehand.context.newPage();
    await expect(navigateDetailPage(login, `http://127.0.0.1:${server.port}/p/LOGIN/`, 5_000))
      .rejects.toBeInstanceOf(AuthError);
  } finally {
    for (const controller of controllers) {
      try { controller.enqueue(encoder.encode("</body></html>")); controller.close(); } catch { /* already closed */ }
    }
    await stagehand.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
  }
}, 90_000);
