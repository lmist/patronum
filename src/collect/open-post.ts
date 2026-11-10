/**
 * Step 5b: open one post.
 *
 * Go to a post's own page and wait until that exact post is showing.
 * Hands read-post.ts a page that is ready to read.
 */
import { classifyPageByUrl } from "../sign-in/login.js";
import { AuthError } from "../sign-in/auth-check.js";
import { shortcodeFromPermalink, isSameDetailPost } from "./links.js";
import { sleep } from "./pacing.js";
import type { DetailPage } from "./browser-page.js";
import { harvestDetailMedia, harvestEmbeddedPostMedia } from "./read-post.js";
import { DetailNavigationTimeout, httpRejection } from "./rejections.js";

/** Fallback for tests/adapters without Stagehand CDP + evaluate support. */
export async function navigateDetailWithGoto(page: DetailPage, url: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const navigation = page.goto(url, { waitUntil: "domcontentloaded", timeoutMs });
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void (async () => {
        try {
          if (page.sendCDP) await Promise.race([
            page.sendCDP("Page.stopLoading"),
            sleep(2_000),
          ]);
        } catch { /* browser may already have disconnected */ }
        reject(new DetailNavigationTimeout(url, timeoutMs));
      })();
    }, timeoutMs);
  });
  try {
    await Promise.race([navigation, watchdog]);
  } catch (err) {
    if (timedOut) {
      const settled = await Promise.race([
        navigation.then(() => true, () => true),
        sleep(3_000).then(() => false),
      ]);
      if (!settled && page.close) {
        await Promise.race([page.close().catch(() => {}), sleep(3_000)]);
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Page.goto waits for DOMContentLoaded even when the exact post JSON is ready
 * in a streaming response. Commit via Stagehand CDP, then wait for semantic
 * evidence on the exact current URL. Any timed-out CDP command closes the tab
 * before a replacement worker is allowed to navigate. */
export async function navigateDetailPage(page: DetailPage, url: string, timeoutMs = 30_000): Promise<void> {
  if (!page.sendCDP || !page.evaluate) {
    try { return await navigateDetailWithGoto(page, url, timeoutMs); }
    catch (err) { throw httpRejection(url, err) ?? err; }
  }
  const deadline = Date.now() + timeoutMs;
  const shortcode = shortcodeFromPermalink(url);
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DetailNavigationTimeout(url, timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DetailNavigationTimeout(url, timeoutMs)), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const abort = async () => {
    try { await Promise.race([page.sendCDP!("Page.stopLoading").catch(() => {}), sleep(2_000)]); } catch { /* disconnected */ }
    try { if (page.close) await Promise.race([page.close().catch(() => {}), sleep(3_000)]); } catch { /* disconnected */ }
  };
  try {
    const commit = await bounded(page.sendCDP("Page.navigate", { url })) as { errorText?: string } | undefined;
    if (commit?.errorText) throw httpRejection(url, commit.errorText, page) ?? new Error(`detail navigation failed: ${commit.errorText}`);
    while (Date.now() < deadline) {
      let current: { href: string } | null = null;
      try {
        current = await bounded(page.evaluate<{ href: string }>("({ href: location.href })"));
      } catch (err) {
        if (err instanceof DetailNavigationTimeout) throw err;
      }
      if (current?.href) {
        const kind = classifyPageByUrl(current.href);
        if (kind === "login" || kind === "totp" || kind === "checkpoint") {
          throw new AuthError(`auth failed: URL is ${kind} (${current.href})`, {
            state: kind, evidence: { ok: false, reason: `url classified as ${kind}`, state: kind },
          });
        }
        if (isSameDetailPost(current.href, url)) {
          if (shortcode) {
            const embedded = await bounded(harvestEmbeddedPostMedia(page, shortcode, 1));
            if (embedded) return;
            try {
              const dom = await bounded(harvestDetailMedia(page, { shortcode }));
              if (dom?.domBacked) return;
            } catch (err) {
              if (err instanceof DetailNavigationTimeout) throw err;
            }
          }
        }
      }
      await sleep(250);
    }
    throw new DetailNavigationTimeout(url, timeoutMs);
  } catch (err) {
    if (err instanceof DetailNavigationTimeout) await abort();
    throw httpRejection(url, err) ?? err;
  }
}
