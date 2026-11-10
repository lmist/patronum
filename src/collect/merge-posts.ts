/**
 * Step 4: combine what the grid and the post page said.
 *
 * Clean up one post record, merge two records for the same post, and keep a
 * list free of duplicates.
 */
import { type MediaItem, isReelOrVideoPost } from "./post-shape.js";
import {
  unique,
  normalizePermalink,
  shortcodeFromPermalink,
  isHttp,
  videoFirstUrls,
} from "./links.js";
import type { CollectRun } from "./run.js";

export function normalizeMediaItem(raw: MediaItem, notes: string[]): MediaItem {
  const permalink = normalizePermalink(raw.permalink ?? null);
  const shortcode =
    raw.shortcode ?? shortcodeFromPermalink(permalink) ?? raw.id ?? null;
  const selectedUrls = (raw.mediaUrls ?? []).filter((u) => isHttp(u));
  const mediaUrls = ["embedded-json", "graphql", "api-info"].includes(raw.detailSource ?? "") && raw.type === "carousel"
    ? unique(selectedUrls)
    : videoFirstUrls(selectedUrls);
  const thumbnailUrl = isHttp(raw.thumbnailUrl) ? raw.thumbnailUrl : null;

  if (!mediaUrls.length && !thumbnailUrl) {
    notes.push(
      `no mediaUrls/thumbnail for ${shortcode ?? permalink ?? "unknown item"}`,
    );
  }

  let type = raw.type ?? null;
  if (!type && permalink) {
    if (/\/reel\//i.test(permalink)) type = "reel";
  }
  const isVideo =
    raw.isVideo ??
    (type === "video" || type === "reel"
      ? true
      : type === "image"
        ? false
        : null);

  return {
    mediaOwnershipVersion: raw.mediaOwnershipVersion,
    ...(raw.metricsVersion === 1 ? { metricsVersion: 1 as const } : {}),
    detailSource: raw.detailSource,
    carouselComplete: raw.carouselComplete === true,
    captionComplete: raw.captionComplete === true,
    detailStatus: raw.detailStatus,
    detailError: raw.detailError ?? null,
    detailAttempts: raw.detailAttempts,
    fromProfileGrid: raw.fromProfileGrid === true,
    shortcode,
    id: raw.id ?? shortcode,
    type,
    caption: raw.caption ?? null,
    timestamp: raw.timestamp ?? null,
    permalink,
    mediaUrls,
    thumbnailUrl,
    isVideo,
    carouselMedia:
      (raw.carouselMedia ?? null)?.map((c) => ({
        mediaUrl: isHttp(c.mediaUrl) ? c.mediaUrl : null,
        thumbnailUrl: isHttp(c.thumbnailUrl) ? c.thumbnailUrl : null,
        isVideo: c.isVideo ?? null,
      })) ?? null,
    ...postMetrics(raw),
  };
}

export const RECORD_SOURCES = new Set(["embedded-json", "graphql", "api-info"]);

export const METRIC_KEYS = ["likeCount", "commentCount", "playCount", "viewCount", "videoDurationSec"] as const;

export type PostMetrics = Partial<Record<(typeof METRIC_KEYS)[number], number>>;

/** Engagement/duration fields stated by an Instagram record; absent stays absent. */
export function postMetrics(...sources: Array<Partial<Record<string, unknown>> | null | undefined>): PostMetrics {
  const out: PostMetrics = {};
  for (const key of METRIC_KEYS) {
    for (const source of sources) {
      const value = source?.[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) { out[key] = value; break; }
    }
  }
  return out;
}

export function mediaKey(item: MediaItem): string {
  return (
    item.shortcode ??
    shortcodeFromPermalink(item.permalink) ??
    item.permalink ??
    JSON.stringify({
      t: item.thumbnailUrl,
      m: item.mediaUrls?.[0],
    })
  );
}

/** Prefer richer fields when merging two items with same key. */
export function mergeMediaItem(a: MediaItem, b: MediaItem): MediaItem {
  const verified = (item: MediaItem) => item.mediaOwnershipVersion === 1 &&
    (item.type !== "carousel" || (item.carouselComplete === true && (item.carouselMedia?.length ?? 0) > 1));
  if (verified(a) || verified(b)) {
    const owned = verified(b) ? b : a;
    const captionSource = b.captionComplete && b.caption ? b : a.captionComplete && a.caption ? a : owned;
    return {
      ...a, ...b, ...owned,
      caption: captionSource.caption,
      captionComplete: captionSource.captionComplete,
      fromProfileGrid: a.fromProfileGrid || b.fromProfileGrid,
      detailStatus: b.detailStatus ?? a.detailStatus,
      detailError: b.detailError !== undefined ? b.detailError : a.detailError,
      detailAttempts: b.detailAttempts ?? a.detailAttempts,
      detailSource: owned.detailSource ?? b.detailSource ?? a.detailSource,
    };
  }
  const mediaUrls = unique([...(a.mediaUrls ?? []), ...(b.mediaUrls ?? [])]);
  const carousel = [...(a.carouselMedia ?? []), ...(b.carouselMedia ?? [])];
  return {
    carouselComplete: a.carouselComplete === true || b.carouselComplete === true,
    captionComplete: a.captionComplete === true || b.captionComplete === true,
    detailStatus: b.detailStatus ?? a.detailStatus,
    detailError: b.detailError !== undefined ? b.detailError : a.detailError,
    detailAttempts: b.detailAttempts ?? a.detailAttempts,
    detailSource: b.detailSource ?? a.detailSource,
    ...(b.metricsVersion === 1 || a.metricsVersion === 1 ? { metricsVersion: 1 as const } : {}),
    fromProfileGrid: a.fromProfileGrid || b.fromProfileGrid,
    shortcode: a.shortcode ?? b.shortcode ?? null,
    id: a.id ?? b.id ?? null,
    type: a.type ?? b.type ?? null,
    caption: b.caption || a.caption || null,
    timestamp: a.timestamp || b.timestamp || null,
    permalink: a.permalink ?? b.permalink ?? null,
    mediaUrls,
    thumbnailUrl: a.thumbnailUrl ?? b.thumbnailUrl ?? null,
    isVideo: a.isVideo ?? b.isVideo ?? null,
    carouselMedia: carousel.length ? carousel : null,
    ...postMetrics(b, a),
  };
}

export function upsertItems(
  map: Map<string, MediaItem>,
  items: MediaItem[],
  notes: string[],
): void {
  for (const raw of items) {
    const n = normalizeMediaItem(raw, notes);
    const key = mediaKey(n);
    const prev = map.get(key);
    map.set(key, prev ? mergeMediaItem(prev, n) : n);
  }
}

/** Combine this run's grid with an earlier run's posts, and keep posts and reels apart. */
export function mergeWithEarlierRun(
  run: CollectRun,
  grid: { posts: MediaItem[]; reels: MediaItem[] },
): { posts: MediaItem[]; reels: MediaItem[] } {
  const { prior, notes } = run;
  const { max, skipReels } = run.options;
  // Merge maps: prior → new
  const postsMap = new Map<string, MediaItem>();
  const reelsMap = new Map<string, MediaItem>();
  if (prior?.posts) upsertItems(postsMap, prior.posts, notes);
  if (prior?.reels && !skipReels) upsertItems(reelsMap, prior.reels, notes);
  upsertItems(postsMap, grid.posts, notes);
  if (!skipReels) upsertItems(reelsMap, grid.reels, notes);

  // Keep posts/reels disjoint by shortcode preference
  for (const [k, item] of postsMap) {
    if (skipReels && isReelOrVideoPost(item)) {
      postsMap.delete(k);
      continue;
    }
    const isReel =
      item.type === "reel" ||
      (item.permalink ? /\/reel\//i.test(item.permalink) : false);
    if (isReel) {
      postsMap.delete(k);
      const prev = reelsMap.get(k);
      reelsMap.set(k, prev ? mergeMediaItem(prev, item) : item);
    }
  }

  return {
    posts: [...postsMap.values()].slice(0, max),
    reels: [...reelsMap.values()].slice(0, max),
  };
}
