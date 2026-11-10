/**
 * Step 5: open every post that is not finished.
 *
 * Run open-post + read-post across several browser tabs at once, skipping
 * posts an earlier run already completed and saving progress after each one.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { isAuthError } from "../sign-in/auth-check.js";
import { isLlmError } from "../llm/preflight.js";
import { DEFAULT_DETAIL_WORKERS, mapPool } from "./pool.js";
import type { MediaItem, HeaderExtract } from "./post-shape.js";
import { normalizePermalink, shortcodeFromPermalink } from "./links.js";
import type { DetailPage } from "./browser-page.js";
import { timedPhase, sleep } from "./pacing.js";
import { mergeMediaItem } from "./merge-posts.js";
import { needsDetailEnrichment } from "./resume.js";
import { InstagramHttpRejectionError } from "./rejections.js";
import { enrichOneItem } from "./read-post.js";
import { CdpDetailBrowser } from "./cdp-detail.js";
import { readPostsFromProfileApi, readReelsFromGridClicks } from "./read-posts-from-api.js";
import type { CollectRun, PostLists } from "./run.js";
import { saveDetailProgress } from "./write-profile.js";

export async function enrichItemsWithDetail(
  stagehand: Stagehand,
  page: DetailPage,
  items: MediaItem[],
  notes: string[],
  opts: {
    skipShortcodes?: Set<string>;
    onItem?: (item: MediaItem, index: number) => void;
    workers?: number;
    createPage?: () => Promise<DetailPage>;
    enrichOne?: typeof enrichOneItem;
  },
): Promise<MediaItem[]> {
  const total = items.length;
  let opened = 0;
  let skipped = 0;
  const pending = items.filter((item) => {
    const sc = item.shortcode ?? shortcodeFromPermalink(item.permalink);
    const permalink = normalizePermalink(item.permalink) ?? (sc ? `https://www.instagram.com/p/${sc}/` : null);
    return !!permalink && !(sc && opts.skipShortcodes?.has(sc) && !needsDetailEnrichment(item));
  }).length;
  const workerCount = Math.max(1, Math.min(opts.workers ?? DEFAULT_DETAIL_WORKERS, pending));

  const pages: DetailPage[] = [];
  const extra: DetailPage[] = [];
  if (opts.createPage && pending > 0) {
    const extraN = workerCount;
    const created = await timedPhase("detail:worker-tabs", () => mapPool(
      Array.from({ length: extraN }),
      Math.min(4, extraN),
      async () => {
      try {
        return await opts.createPage!();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`detail extra tab failed: ${msg}`);
        console.log(`[scrape] detail extra tab failed: ${msg}`);
        return null;
      }
      },
    ));
    extra.push(...created.filter((p): p is DetailPage => p !== null));
    pages.push(...extra);
    if (!pages.length) throw new Error("failed to create any dedicated detail worker tab");
  } else {
    // Callers without a tab factory (tests) read posts on the page they passed in.
    pages.push(page);
  }
  const liveWorkers = pages.length;
  let fatalHttpRejection: InstagramHttpRejectionError | null = null;
  await Promise.all(pages.map(async (tab, workerId) => {
    try {
      await tab.sendCDP?.("Emulation.setFocusEmulationEnabled", { enabled: true });
      if (tab.sendCDP) console.log(`[scrape] detail worker ${workerId}: focus emulation enabled`);
    } catch (err) {
      notes.push(`detail worker ${workerId}: focus emulation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
  console.log(
    `[scrape] detail pass workers=${liveWorkers} (requested ${opts.workers ?? DEFAULT_DETAIL_WORKERS}) pending=${pending} items=${total}`,
  );

  const replaceWorkerPage = async (workerId: number): Promise<boolean> => {
    if (fatalHttpRejection) throw fatalHttpRejection;
    if (!opts.createPage) return false;
    const old = pages[workerId];
    if (old && old !== page) {
      try { await old.close?.(); } catch { /* watchdog may have closed it */ }
    }
    // A failed context creation is infrastructure-wide; let it abort the run.
    const replacement = await opts.createPage();
    try {
      await replacement.sendCDP?.("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (err) {
      try { await replacement.close?.(); } catch { /* best effort */ }
      throw err;
    }
    pages[workerId] = replacement;
    extra.push(replacement);
    console.log(`[scrape] detail worker ${workerId}: replacement tab focused`);
    return true;
  };

  // A worker whose tab may be closed (navigation watchdog, lost session) gets a
  // fresh tab before its next attempt — including the next item's first one.
  const staleWorkers = new Set<number>();

  try {
    const results = await mapPool(items, liveWorkers, async (item, i, workerId) => {
      if (fatalHttpRejection) throw fatalHttpRejection;
      const sc =
        item.shortcode ?? shortcodeFromPermalink(item.permalink) ?? `idx${i}`;
      const permalink =
        normalizePermalink(item.permalink) ??
        (sc && !sc.startsWith("idx")
          ? item.type === "reel" || (item.permalink ?? "").includes("/reel/")
            ? `https://www.instagram.com/reel/${sc}/`
            : `https://www.instagram.com/p/${sc}/`
          : null);

      if (!permalink) {
        notes.push(`detail skip ${sc}: no permalink`);
        skipped++;
        const incomplete = { ...item, detailStatus: "incomplete" as const, detailError: "no permalink", detailAttempts: 0 };
        opts.onItem?.(incomplete, i);
        return incomplete;
      }

      // --detail opens every permalink except prior JSON that is already complete.
      if (opts.skipShortcodes?.has(sc) && !needsDetailEnrichment(item)) {
        console.log(
          `[scrape] detail ${i + 1}/${total} @${sc} skip (resume complete)`,
        );
        skipped++;
        const complete = { ...item, detailStatus: "complete" as const, detailError: null, detailAttempts: item.detailAttempts ?? 0 };
        // Already durable in the prior profile; checkpoint only changed items.
        return complete;
      }

      let best = item;
      let hadResult = false;
      let didOpenAny = false;
      let lastError = "detail did not complete";
      let attempts = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (fatalHttpRejection) throw fatalHttpRejection;
        if (staleWorkers.delete(workerId) && !(await replaceWorkerPage(workerId)) && attempt > 1) break;
        attempts = attempt;
        try {
          const result = await (opts.enrichOne ?? enrichOneItem)(
            stagehand, pages[workerId] ?? page, best, i, total, notes,
          );
          hadResult = true;
          didOpenAny ||= result.opened;
          best = mergeMediaItem(best, result.item);
          const candidate = { ...best, detailStatus: undefined, detailError: null, detailAttempts: attempt };
          if (!needsDetailEnrichment(candidate)) {
            const complete = { ...candidate, detailStatus: "complete" as const };
            if (didOpenAny) opened++;
            opts.onItem?.(complete, i);
            return complete;
          }
          lastError = `detail incomplete after attempt ${attempt}: media/caption or carousel traversal unverified`;
        } catch (err) {
          if (err instanceof InstagramHttpRejectionError) {
            fatalHttpRejection = err;
            const rejected = {
              ...best,
              detailStatus: "failed" as const,
              detailError: err.message.slice(0, 500),
              detailAttempts: attempt,
            };
            notes.push(`detail ${sc}: HTTP rejection: ${err.transportError}`);
            opts.onItem?.(rejected, i);
            throw err;
          }
          if (isAuthError(err) || isLlmError(err)) throw err;
          lastError = err instanceof Error ? err.message : String(err);
          console.log(`[scrape] detail ${i + 1}/${total} @${sc} attempt ${attempt} failed: ${lastError}`);
          staleWorkers.add(workerId);
        }
        if (attempt < 2) staleWorkers.add(workerId);
      }
      const outcome = {
        ...best,
        detailStatus: hadResult ? "incomplete" as const : "failed" as const,
        detailError: lastError.slice(0, 500),
        detailAttempts: attempts,
      };
      if (didOpenAny) opened++;
      notes.push(`detail ${sc}: ${outcome.detailStatus} after ${attempts} attempt(s): ${outcome.detailError}`);
      console.log(`[scrape] detail ${i + 1}/${total} @${sc} ${outcome.detailStatus} attempts=${attempts}`);
      opts.onItem?.(outcome, i);
      return outcome;
    });

    console.log(
      `[scrape] detail pass done opened=${opened} skipped=${skipped} total=${total} workers=${liveWorkers}`,
    );
    return results;
  } finally {
    for (const p of extra) {
      try {
        await p.close?.();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Complete every post and reel: first from Instagram's own responses, then by
 * opening what is left in browser tabs. Progress is saved after each post.
 */
export async function fillInEveryPost(run: CollectRun, header: HeaderExtract, lists: PostLists): Promise<void> {
  const { stagehand, page, url, notes } = run;
  const { skipReels, workers } = run.options;
  console.log(
    `\n[scrape] ── DETAIL PASS posts=${lists.posts.length} reels=${skipReels ? 0 : lists.reels.length} workers=${workers}${skipReels ? " skip-reels" : ""} ──`,
  );

  /** Checkpoint after each detail item so --resume can skip completed ones. */
  const checkpoint = (posts: MediaItem[], reels: MediaItem[]) => saveDetailProgress(run, header, posts, reels);

  await readPostsFromProfileApi(run, lists, checkpoint);

  const postsHolder: MediaItem[] = [...lists.posts];
  // Posts open in raw CDP tabs, separate from the Stagehand page that reads the profile.
  const cdpDetail = run.cdpDetail = new CdpDetailBrowser(() => stagehand.connectURL());
  const createPage = () => cdpDetail.newTab() as Promise<DetailPage>;

  lists.posts = await enrichItemsWithDetail(
    stagehand,
    page,
    postsHolder,
    notes,
    {
      skipShortcodes: lists.complete,
      workers,
      createPage,
      onItem: (item, idx) => {
        postsHolder[idx] = item;
        checkpoint([...postsHolder], [...lists.reels]);
      },
    },
  );

  if (skipReels) {
    lists.reels = [];
  } else {
    await readReelsFromGridClicks(run, lists, checkpoint);
    const reelsHolder: MediaItem[] = [...lists.reels];
    lists.reels = await enrichItemsWithDetail(
      stagehand,
      page,
      reelsHolder,
      notes,
      {
        skipShortcodes: lists.complete,
        workers,
        createPage,
        onItem: (item, idx) => {
          reelsHolder[idx] = item;
          checkpoint([...lists.posts], [...reelsHolder]);
        },
      },
    );
  }

  // Return to profile root after detail hops
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 45_000,
    });
    await sleep(1500);
  } catch {
    // ignore
  }
}
