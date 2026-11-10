/**
 * Step 4 (with merge-posts.ts): decide what a previous run already finished.
 *
 * Load the last saved profile, check whether its grid can be reused, tell
 * which posts still need opening, and wipe everything for a fresh start.
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { inHome, layout } from "../paths.js";
import type { MediaItem } from "./post-shape.js";
import { isHttp, isVideoUrl, shortcodeFromPermalink } from "./links.js";
import { RECORD_SOURCES, mergeMediaItem } from "./merge-posts.js";

export type PriorProfile = {
  sourceUrl?: string;
  session?: { authenticated?: boolean };
  username?: string;
  fullName?: string | null;
  profilePicUrl?: string | null;
  bioRaw?: string | null;
  location?: string | null;
  counts?: {
    posts?: number | null;
    followers?: number | null;
    following?: number | null;
  } | null;
  posts?: MediaItem[];
  reels?: MediaItem[];
  notes?: string[];
};

export function validateReusableGrid(
  prior: PriorProfile | null,
  handle: string,
  sourceUrl: string,
  skipReels: boolean,
): { posts: MediaItem[]; reels: MediaItem[]; reason: string } | { posts: null; reels: null; reason: string } {
  const reject = (reason: string) => ({ posts: null, reels: null, reason } as const);
  if (!prior || prior.username?.toLowerCase() !== handle.toLowerCase() || prior.session?.authenticated !== true) {
    return reject("missing exact-handle authenticated checkpoint");
  }
  try {
    const saved = new URL(prior.sourceUrl ?? "");
    const requested = new URL(sourceUrl);
    if (saved.hostname !== "www.instagram.com" || requested.hostname !== saved.hostname ||
        saved.pathname !== `/${handle}/` || requested.pathname !== saved.pathname) return reject("checkpoint source does not match target profile");
  } catch {
    return reject("invalid checkpoint source URL");
  }
  const expected = prior.counts?.posts;
  if (!Number.isSafeInteger(expected) || !expected || expected <= 0 || !Array.isArray(prior.posts) ||
      (!skipReels && !Array.isArray(prior.reels))) return reject("checkpoint has no complete grid/counts");

  const knownRow = (item: MediaItem, requirePreview: boolean) => {
    if (!item.shortcode || !item.permalink ||
        (requirePreview && !(item.mediaUrls?.some(isHttp) || isHttp(item.thumbnailUrl)))) return false;
    try {
      const url = new URL(item.permalink);
      if (url.hostname !== "www.instagram.com") return false;
      const author = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
      return author === handle.toLowerCase() || item.fromProfileGrid === true;
    } catch { return false; }
  };
  const dedupe = (rows: MediaItem[], requirePreview: boolean) => {
    const byCode = new Map<string, MediaItem>();
    for (const row of rows) {
      if (!knownRow(row, requirePreview)) return null;
      const code = row.shortcode!;
      const prev = byCode.get(code);
      byCode.set(code, prev ? mergeMediaItem(prev, row) : row);
    }
    return [...byCode.values()];
  };
  const posts = dedupe(prior.posts, true);
  const reels = skipReels ? [] : dedupe(prior.reels ?? [], false);
  if (!posts || !reels || posts.length < expected || (!skipReels && reels.length === 0)) {
    return reject("checkpoint is missing identified posts or reels");
  }
  return { posts, reels, reason: `complete checkpoint posts=${posts.length} reels=${reels.length}` };
}

export function loadPrior(path: string): PriorProfile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PriorProfile;
  } catch {
    return null;
  }
}

export function wipeProfileArtifacts(username: string, outPath: string): void {
  if (existsSync(outPath)) {
    rmSync(outPath, { force: true });
    console.log(`[scrape] wiped ${outPath}`);
  }
  const mediaDir = inHome(layout.mediaDir(username));
  if (existsSync(mediaDir)) {
    rmSync(mediaDir, { recursive: true, force: true });
    console.log(`[scrape] wiped ${mediaDir}`);
  }
}

export function needsDetailEnrichment(item: MediaItem): boolean {
  if (item.detailStatus === "failed" || item.detailStatus === "incomplete") return true;
  if (item.mediaOwnershipVersion !== 1) return true;
  // Record-backed rows captured before metrics existed reopen once to read them.
  if (RECORD_SOURCES.has(item.detailSource ?? "") && item.metricsVersion !== 1) return true;
  if (item.type === "carousel" && item.carouselComplete !== true) return true;
  if (item.captionComplete !== true) return true;
  const urls = (item.mediaUrls ?? []).filter(isHttp);
  // Incomplete if no real media or missing caption
  if (urls.length === 0) return true;
  if (!item.caption && item.captionComplete !== true) return true;
  // Reels / video posts: still incomplete without a real mp4/CDN video URL
  // (poster JPGs alone are not enough for igdl + M3 video_url).
  const wantsVideo =
    item.isVideo === true ||
    item.type === "reel" ||
    item.type === "video" ||
    (item.permalink ?? "").includes("/reel/");
  if (wantsVideo && !urls.some(isVideoUrl) && !["embedded-json", "graphql", "api-info"].includes(item.detailSource ?? "")) return true;
  // Carousels need every slide, not just the grid thumbnail.
  const carouselCount = (item.carouselMedia ?? []).filter(
    (c) => isHttp(c.mediaUrl) || isHttp(c.thumbnailUrl),
  ).length;
  if (item.type === "carousel" && carouselCount < 2) return true;
  return false;
}

/**
 * Shortcodes that already had a complete detail pass (media + caption +
 * video URL / carousel slides when required). Incomplete prior rows reopen.
 */
export function alreadyComplete(prior: PriorProfile | null): Set<string> {
  const complete = new Set<string>();
  for (const it of [...(prior?.posts ?? []), ...(prior?.reels ?? [])]) {
    const sc = it.shortcode ?? shortcodeFromPermalink(it.permalink);
    if (sc && !needsDetailEnrichment(it)) complete.add(sc);
  }
  return complete;
}
