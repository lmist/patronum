/**
 * Step 3: scroll the grid and list the posts.
 *
 * Open the Posts or Reels tab, scroll until nothing new appears, and turn the
 * tiles into post records.
 * Hands the next step a list of posts that still need their full media.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { clickProfileTab, InstagramUiMap, type MappedPage } from "../api-map/ui-map.js";
import {
  ACT_CLICK_POSTS_TAB,
  ACT_CLICK_REELS_TAB,
  OBSERVE_POSTS_TAB,
  OBSERVE_REELS_TAB,
  extractGridInstruction,
} from "./prompts.js";
import { GridSchema, type MediaItem, type HeaderExtract } from "./post-shape.js";
import {
  unique,
  normalizePermalink,
  shortcodeFromPermalink,
  isHttp,
  permalinkBelongsTo,
} from "./links.js";
import { sleep, noteLlmError, timedPhase, optionalModel } from "./pacing.js";
import { observeActFirst } from "./open-profile.js";
import { upsertItems } from "./merge-posts.js";
import type { ScrapePage } from "./browser-page.js";

/** A validated DOM grid makes optional model grid extraction unnecessary. */
import { validateReusableGrid } from "./resume.js";
import type { CollectRun } from "./run.js";
import { saveGridProgress } from "./write-profile.js";

export function shouldSkipGridExtract(harvestCount: number, max: number): boolean {
  // --max is a cap, not the expected account size. A validated DOM grid can be
  // complete well below a deliberately huge cap such as 100000.
  return max > 0 && harvestCount > 0;
}

export type DomHarvest = {
  profilePicUrl: string | null;
  gridItems: Array<{
    permalink: string | null;
    shortcode: string | null;
    thumbnailUrl: string | null;
    mediaUrls: string[];
    isVideo: boolean;
    type: "image" | "video" | "carousel" | "reel" | null;
    fromProfileGrid?: boolean;
  }>;
  allImgSrcs: string[];
  allVideoSrcs: string[];
  allPostHrefs: string[];
};

export async function harvestDom(page: {
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
}): Promise<DomHarvest | null> {
  if (!page.evaluate) return null;
  try {
    return (await page.evaluate(`(() => {
      const isHttp = (s) => typeof s === "string" && /^https?:\\/\\//i.test(s);
      const abs = (s) => {
        if (!s) return null;
        try { return new URL(s, location.origin).href; } catch { return s; }
      };
      const shortcodeFrom = (href) => {
        if (!href) return null;
        const m = href.match(/\\/(?:p|reel|tv)\\/([A-Za-z0-9_-]+)/);
        return m ? m[1] : null;
      };
      const isPostOrReel = (href) =>
        /\\/(?:p|reel|tv)\\/[A-Za-z0-9_-]+/i.test(href || "");

      let profilePicUrl = null;
      const headerImgs = document.querySelectorAll(
        'header img, img[alt*="profile picture" i], img[alt*="profile photo" i]'
      );
      for (const img of headerImgs) {
        const src = img.currentSrc || img.src || img.getAttribute("src");
        if (isHttp(src) && !/sprite|static.*rsrc/i.test(src)) {
          profilePicUrl = src;
          break;
        }
      }

      const gridItems = [];
      const seen = new Set();
      const onProfile = /^\\/[A-Za-z0-9._]+\\/(?:reels\\/)?$/.test(location.pathname);
      const anchors = document.querySelectorAll(
        'main a[href*="/p/"], main a[href*="/reel/"], article a[href*="/p/"], article a[href*="/reel/"], a[href*="/p/"], a[href*="/reel/"]'
      );
      for (const a of anchors) {
        const href = abs(a.getAttribute("href") || a.href);
        if (!href || !isPostOrReel(href)) continue;
        const sc = shortcodeFrom(href);
        const key = sc || href.split("?")[0];
        if (seen.has(key)) continue;
        seen.add(key);

        const img = a.querySelector("img");
        const video = a.querySelector("video");
        const thumb = img
          ? (img.currentSrc || img.src || img.getAttribute("src") || null)
          : null;
        const mediaUrls = [];
        if (thumb && isHttp(thumb)) mediaUrls.push(thumb);
        if (video) {
          const vs = video.currentSrc || video.src || video.getAttribute("src");
          if (vs && isHttp(vs)) mediaUrls.push(vs);
        }
        a.querySelectorAll("img, video, source").forEach((el) => {
          const s = el.currentSrc || el.src || el.getAttribute("src");
          if (s && isHttp(s) && !mediaUrls.includes(s)) mediaUrls.push(s);
        });

        const isReel = /\\/reel\\//i.test(href);
        const isVideo =
          isReel ||
          !!video ||
          !!a.querySelector('[aria-label*="Clip" i], [aria-label*="Video" i], [aria-label*="Reel" i], svg[aria-label*="Clip" i], svg[aria-label*="Video" i], svg[aria-label*="Reel" i]');
        const isCarousel = !!a.querySelector(
          '[aria-label*="Carousel" i], svg[aria-label*="Carousel" i], [aria-label*="Album" i]'
        );

        let type = null;
        if (isReel) type = "reel";
        else if (isCarousel) type = "carousel";
        else if (isVideo) type = "video";
        else type = "image";

        gridItems.push({
          permalink: href,
          shortcode: sc,
          thumbnailUrl: thumb && isHttp(thumb) ? thumb : null,
          mediaUrls,
          isVideo: !!isVideo,
          type,
          fromProfileGrid: onProfile && !!a.closest('main') && !a.closest('aside, [role="dialog"], [aria-label*="suggested" i]') && !!a.querySelector('img, video'),
        });
      }

      const allImgSrcs = [];
      document.querySelectorAll("main img, article img, header img").forEach((img) => {
        const s = img.currentSrc || img.src || img.getAttribute("src");
        if (s && isHttp(s)) allImgSrcs.push(s);
      });
      const allVideoSrcs = [];
      document.querySelectorAll("main video, article video, main source, article source").forEach((el) => {
        const s = el.currentSrc || el.src || el.getAttribute("src");
        if (s && isHttp(s)) allVideoSrcs.push(s);
      });
      const allPostHrefs = [];
      document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((a) => {
        const h = abs(a.getAttribute("href") || a.href);
        if (h && isPostOrReel(h)) allPostHrefs.push(h);
      });

      for (const h of allPostHrefs) {
        const sc = shortcodeFrom(h);
        const key = sc || h.split("?")[0];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const isReel = /\\/reel\\//i.test(h) && !/\\/reels\\/?$/i.test(h);
        gridItems.push({
          permalink: h,
          shortcode: sc,
          thumbnailUrl: null,
          mediaUrls: [],
          isVideo: !!isReel,
          type: isReel ? "reel" : "image",
          fromProfileGrid: false,
        });
      }

      return {
        profilePicUrl,
        gridItems,
        allImgSrcs: [...new Set(allImgSrcs)],
        allVideoSrcs: [...new Set(allVideoSrcs)],
        allPostHrefs: [...new Set(allPostHrefs)],
      };
    })()`)) as DomHarvest;
  } catch (err) {
    console.log(
      `[scrape] DOM harvest failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export async function scrollOnce(
  page: {
    evaluate?: (fn: string | (() => void)) => Promise<unknown>;
    mouse?: { wheel?: (x: number, y: number) => Promise<void> };
  },
  i: number,
): Promise<void> {
  try {
    await page.evaluate?.(
      `(() => {
        const as = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')];
        const last = as[as.length - 1];
        if (last) last.scrollIntoView({ block: "end", inline: "nearest" });
        const se = document.scrollingElement || document.documentElement;
        se.scrollBy(0, ${900 + (i % 5) * 80});
      })()`,
    );
  } catch {
    // fall through to wheel
  }
  try {
    if (page.mouse?.wheel) {
      await page.mouse.wheel(0, 1200 + (i % 5) * 100);
    } else if (page.evaluate) {
      await page.evaluate(
        `window.scrollBy({ top: ${1100 + (i % 5) * 120}, left: 0, behavior: 'smooth' })`,
      );
    }
  } catch {
    try {
      await page.evaluate?.(`window.scrollBy(0, 1100)`);
    } catch {
      // ignore
    }
  }
}

export function harvestItemKey(
  g: DomHarvest["gridItems"][number],
): string | null {
  return g.shortcode || shortcodeFromPermalink(g.permalink) || g.permalink;
}

/** Union snapshots — IG virtualizes the grid so the last DOM view is incomplete. */
export function mergeDomHarvest(
  a: DomHarvest | null,
  b: DomHarvest | null,
): DomHarvest | null {
  if (!a) return b;
  if (!b) return a;
  const map = new Map<string, DomHarvest["gridItems"][number]>();
  for (const g of [...a.gridItems, ...b.gridItems]) {
    const k = harvestItemKey(g);
    if (!k) continue;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { ...g });
      continue;
    }
    map.set(k, {
      permalink: prev.permalink ?? g.permalink,
      shortcode: prev.shortcode ?? g.shortcode,
      thumbnailUrl: prev.thumbnailUrl ?? g.thumbnailUrl,
      mediaUrls: unique([...prev.mediaUrls, ...g.mediaUrls]),
      isVideo: prev.isVideo || g.isVideo,
      type: prev.type ?? g.type,
      fromProfileGrid: prev.fromProfileGrid === true || g.fromProfileGrid === true,
    });
  }
  for (const href of [...a.allPostHrefs, ...b.allPostHrefs]) {
    const sc = shortcodeFromPermalink(href);
    const k = sc || href;
    if (map.has(k)) continue;
    const isReel = /\/reel\//i.test(href) && !/\/reels\/?$/i.test(href);
    map.set(k, {
      permalink: href,
      shortcode: sc,
      thumbnailUrl: null,
      mediaUrls: [],
      isVideo: isReel,
      type: isReel ? "reel" : "image",
      fromProfileGrid: false,
    });
  }
  return {
    profilePicUrl: a.profilePicUrl ?? b.profilePicUrl,
    gridItems: [...map.values()],
    allImgSrcs: unique([...a.allImgSrcs, ...b.allImgSrcs]),
    allVideoSrcs: unique([...a.allVideoSrcs, ...b.allVideoSrcs]),
    allPostHrefs: unique([...a.allPostHrefs, ...b.allPostHrefs]),
  };
}

/**
 * Scroll until accumulated unique grid size stalls for `stallLimit` rounds
 * or maxRounds hit. Instagram unloads off-screen tiles, so snapshots are merged.
 */
export async function deepScrollGrid(
  page: {
    evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
    mouse?: { wheel?: (x: number, y: number) => Promise<void> };
  },
  opts: { maxRounds: number; stallLimit: number; targetCount: number },
): Promise<DomHarvest | null> {
  let harvest = await harvestDom(page);
  let lastCount = harvest?.gridItems.length ?? 0;
  let stall = 0;

  for (let i = 0; i < opts.maxRounds; i++) {
    if (lastCount >= opts.targetCount) {
      console.log(
        `[scrape] scroll stop: reached target count ${lastCount}≥${opts.targetCount}`,
      );
      break;
    }
    await scrollOnce(page, i);
    await sleep(1400 + Math.floor(Math.random() * 500));
    // small back-nudge helps lazy loaders
    if (i > 0 && i % 4 === 0) {
      try {
        await page.evaluate?.(`window.scrollBy(0, -200)`);
        await sleep(400);
        await page.evaluate?.(`window.scrollBy(0, 600)`);
        await sleep(800);
      } catch {
        // ignore
      }
    }
    const snap = await harvestDom(page);
    harvest = mergeDomHarvest(harvest, snap);
    const n = harvest?.gridItems.length ?? 0;
    const vis = snap?.gridItems.length ?? 0;
    console.log(
      `[scrape] scroll ${i + 1}/${opts.maxRounds} visible=${vis} unique=${n}`,
    );
    if (n <= lastCount) {
      stall++;
      if (stall >= opts.stallLimit) {
        console.log(`[scrape] scroll stall (${stall} rounds) at ${n} unique items`);
        break;
      }
    } else {
      stall = 0;
      lastCount = n;
    }
  }
  return harvest;
}

export function itemsFromHarvest(
  harvest: DomHarvest | null,
  filter: "posts" | "reels" | "all",
  username?: string,
): MediaItem[] {
  if (!harvest) return [];
  return harvest.gridItems
    .filter((g) => {
      if (username && !permalinkBelongsTo(g.permalink, username, g.fromProfileGrid)) return false;
      const isReel =
        g.type === "reel" ||
        (g.permalink ? /\/reel\//i.test(g.permalink) && !/\/reels\/?$/i.test(g.permalink) : false);
      if (filter === "reels") return isReel;
      if (filter === "posts") return !isReel;
      return true;
    })
    .map((g) => ({
      fromProfileGrid: g.fromProfileGrid === true,
      shortcode: g.shortcode,
      id: g.shortcode,
      type: g.type,
      caption: null,
      timestamp: null,
      permalink: normalizePermalink(g.permalink),
      mediaUrls: g.mediaUrls.filter(isHttp),
      thumbnailUrl: isHttp(g.thumbnailUrl) ? g.thumbnailUrl : null,
      isVideo: g.isVideo,
      carouselMedia: null,
    }));
}

export function urlLooksLikeSurface(url: string, username: string, surface: "posts" | "reels"): boolean {
  const lower = url.toLowerCase();
  const user = username.toLowerCase();
  if (surface === "reels") {
    return lower.includes(`/${user}/reels`);
  }
  return (
    lower.includes(`instagram.com/${user}`) &&
    !lower.includes("/reels") &&
    !lower.includes("/tagged") &&
    !/\/(p|reel|tv)\//i.test(lower)
  );
}

export async function openProfileSurface(
  page: ScrapePage,
  username: string,
  surface: "posts" | "reels",
  map: InstagramUiMap,
): Promise<void> {
  const dest =
    surface === "reels"
      ? `https://www.instagram.com/${username}/reels/`
      : `https://www.instagram.com/${username}/`;
  if (urlLooksLikeSurface(page.url(), username, surface)) {
    console.log(`[scrape] ${surface} already on ${page.url()}`);
    return;
  }
  if (await clickProfileTab(page as MappedPage, map, surface, username)) {
    console.log(`[scrape] ${surface} tab clicked via validated locator`);
    await sleep(1200);
  }
  if (!urlLooksLikeSurface(page.url(), username, surface) && page.goto) {
    try {
      console.log(`[scrape] ${surface} goto ${dest}`);
      await timedPhase(`navigate:${surface}`, () => page.goto!(dest, {
        waitUntil: "domcontentloaded",
        timeoutMs: 60_000,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[scrape] ${surface} nav wait: ${msg} (url=${page.url()})`);
    }
    await sleep(surface === "reels" ? 4000 : 2500);
  }
  console.log(`[scrape] ${surface} url=${page.url()}`);
}

export async function scrapeTab(
  stagehand: Stagehand,
  page: ScrapePage,
  surface: "posts" | "reels",
  max: number,
  scrollRounds: number,
  notes: string[],
  username: string,
  uiMap: InstagramUiMap,
  onGridCheckpoint?: (items: MediaItem[]) => void,
): Promise<MediaItem[]> {
  console.log(`\n[scrape] ── ${surface.toUpperCase()} tab ──`);

  await openProfileSurface(page, username, surface, uiMap);
  if (!urlLooksLikeSurface(page.url(), username, surface)) {
    await observeActFirst(
      stagehand,
      surface === "posts" ? OBSERVE_POSTS_TAB : OBSERVE_REELS_TAB,
      surface === "posts" ? ACT_CLICK_POSTS_TAB : ACT_CLICK_REELS_TAB,
      undefined,
      { map: uiMap, action: surface, handle: username },
    );
  }

  const harvest = await timedPhase(`grid:${surface}`, () => deepScrollGrid(page, {
    maxRounds: scrollRounds,
    stallLimit: 6,
    targetCount: max,
  }));

  const harvestedItems = itemsFromHarvest(harvest, surface === "reels" ? "reels" : "all", username);
  const harvestCount = harvestedItems.length;
  if (harvestCount > 0) {
    onGridCheckpoint?.(harvestedItems);
  }
  let extractedItems: MediaItem[] = [];
  if (shouldSkipGridExtract(harvestCount, max)) {
    console.log(
      `[scrape] skip ${surface} LLM extract: ${harvestCount} owned DOM items`,
    );
  } else {
    console.log(
      `[scrape] extract ${surface} grid via LLM (harvest=${harvestCount} target=${max})`,
    );
    try {
      const grid = await optionalModel(`extract:grid:${surface}`, () => stagehand.extract(
        extractGridInstruction({ surface, max }),
        GridSchema,
      ));
      if (grid.notes) notes.push(...grid.notes.map((n) => `[${surface}] ${n}`));
      extractedItems = grid.items ?? [];
      console.log(
        `[scrape] extract ${surface} items=${extractedItems.length}`,
      );
    } catch (err) {
      // Provider error rethrows out of noteLlmError. Content extract failure
      // falls through to DOM harvest below.
      const msg = noteLlmError(err);
      notes.push(`[${surface}] extract failed: ${msg}`);
      console.log(`[scrape] extract ${surface} failed: ${msg}`);
    }
  }

  const map = new Map<string, MediaItem>();
  upsertItems(map, extractedItems, notes);
  // Posts grid mixes /p/ and /reel/ tiles — keep both; main() splits by shortcode.
  // Reels tab is reels-only.
  upsertItems(
    map,
    harvestedItems,
    notes,
  );

  if (surface === "reels") {
    upsertItems(
      map,
      itemsFromHarvest(harvest, "all", username).filter((i) => {
        return (
          i.type === "reel" ||
          (i.permalink ? /\/reel\//i.test(i.permalink) : false)
        );
      }),
      notes,
    );
  }

  const list = [...map.values()].slice(0, max);
  console.log(`[scrape] ${surface} merged unique=${list.length}`);
  return list;
}

/** List the posts and reels on the profile, or reuse an earlier run's complete list. */
export async function listPosts(run: CollectRun, header: HeaderExtract): Promise<{ posts: MediaItem[]; reels: MediaItem[] }> {
  const { stagehand, page, handle, url, uiMap, notes, prior, scrollRounds } = run;
  const { max, skipReels, resume, fresh } = run.options;
  const reuseRequested = process.env.PATRONUM_REUSE_GRID === "1" && resume && !fresh;
  const reusable = reuseRequested
    ? validateReusableGrid(prior, handle, url, skipReels)
    : null;
  let postsNew: MediaItem[];
  let reelsNew: MediaItem[];
  if (reusable?.posts && reusable.reels) {
    postsNew = reusable.posts;
    reelsNew = reusable.reels;
    console.log(`[scrape] reuse-grid: ${reusable.reason}; skipping Posts/Reels scans`);
  } else {
    if (reuseRequested) console.log(`[scrape] reuse-grid rejected: ${reusable?.reason ?? "no checkpoint"}; scanning profile`);
    postsNew = await scrapeTab(
      stagehand, page, "posts", max, scrollRounds, notes, handle, uiMap,
      (posts) => saveGridProgress(run, header, posts, []),
    );
    reelsNew = skipReels ? [] : await scrapeTab(
      stagehand, page, "reels", max, scrollRounds, notes, handle, uiMap,
      (reels) => saveGridProgress(run, header, postsNew, reels),
    );
    saveGridProgress(run, header, postsNew, reelsNew);
  }
  if (skipReels) {
    notes.push(
      "skip-reels: Reels tab omitted; keeping image + carousel posts only",
    );
  }
  return { posts: postsNew, reels: reelsNew };
}
