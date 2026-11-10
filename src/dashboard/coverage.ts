import { Database } from "bun:sqlite";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { layout } from "../paths";

// All-frames runs can produce 15,000 analysis rows. The aggregate repeats each
// model response in `analysis` and `rawText`, so it can be far larger than the
// profile or media manifests. Reject outliers explicitly rather than truncating.
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ANALYSIS_BYTES = 512 * 1024 * 1024;
const MAX_POSTS = 10_000;
const MAX_ENTRIES = 250_000;
const MAX_ITEM_FILES = 25_000;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ITEM_BYTES = 512 * 1024 * 1024;
const SHORTCODE = /^[A-Za-z0-9_-]{1,80}$/;
const ITEM_FILE_STEM = /^[A-Za-z0-9_-]{1,240}$/;
const HANDLE = /^[A-Za-z0-9._]{1,80}$/;

type RecordValue = Record<string, unknown>;
type AnalysisStatus = "pending" | "complete" | "partial" | "failed" | "skipped";

export type PostCoverage = {
  shortcode: string;
  postKind: string;
  sourcePermalink: string | null;
  inCurrentScrape: boolean;
  discoveredCount: number;
  downloadedCount: number;
  uniqueCount: number;
  analysisCount: number;
  analysisOk: number;
  analysisFailed: number;
  analysisSkipped: number;
  analysisStatus: AnalysisStatus;
  reasons: string[];
  paths: { profile: string; downloads: string[]; unique: string[]; analysis: string[] };
  hashes: { unique: string[]; analysisInputs: string[] };
  timestamps: { publishedAt: string | null; scrapedAt: string | null; analyzedAt: string | null };
  updatedAt: string;
};

export type CoverageSnapshot = {
  handle: string;
  updatedAt: string | null;
  profileScrapedAt: string | null;
  summary: {
    total: number;
    current: number;
    complete: number;
    partial: number;
    failed: number;
    skipped: number;
    pending: number;
  };
  posts: PostCoverage[];
};

type Row = {
  shortcode: string; post_kind: string; source_permalink: string | null;
  in_current_scrape: number; discovered_count: number; downloaded_count: number;
  unique_count: number; analysis_count: number; analysis_ok: number;
  analysis_failed: number; analysis_skipped: number; analysis_status: AnalysisStatus;
  reasons_json: string; paths_json: string; hashes_json: string; timestamps_json: string;
  updated_at: string;
};

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function validShortcode(value: unknown): value is string { return typeof value === "string" && SHORTCODE.test(value); }
function itemFileStem(id: string): string | null {
  // Mirrors iganalyze's sanitize: all-frames IDs contain media extensions,
  // e.g. SC__SC_10_hash.jpg -> SC__SC_10_hash_jpg.json on disk.
  const stem = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return ITEM_FILE_STEM.test(stem) ? stem : null;
}

function validateHandle(handle: string): void {
  if (!HANDLE.test(handle) || handle === "." || handle === "..") throw new Error("invalid coverage handle");
}

function boundedArray(value: unknown, name: string): unknown[] {
  const values = array(value);
  if (values.length > MAX_ENTRIES) throw new Error(`${name} has too many entries`);
  return values;
}

async function readJson(path: string, optional = false, maxBytes = MAX_ARTIFACT_BYTES): Promise<RecordValue | null> {
  const info = await stat(path).catch(() => null);
  if (!info) {
    if (optional) return null;
    throw new Error(`coverage artifact missing: ${path}`);
  }
  if (!info.isFile() || info.size > maxBytes) throw new Error(`coverage artifact is not a bounded file: ${path}`);
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  const parsed = object(value);
  if (!parsed) throw new Error(`coverage artifact is not a JSON object: ${path}`);
  return parsed;
}

function artifactPath(root: string, raw: unknown, prefix: string): string | null {
  const candidate = string(raw);
  if (!candidate) return null;
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith(".." + sep) || rel === ".." || !rel.startsWith(prefix + sep)) return null;
  return rel.split(sep).join("/");
}

async function regularFile(root: string, path: string): Promise<boolean> {
  const info = await lstat(join(root, path)).catch(() => null);
  return info?.isFile() === true;
}

function mediaCount(item: RecordValue): number {
  // Legacy mediaUrls can contain other posts' grid URLs. Only versioned ownership
  // is reliable evidence of the number of post-owned media slots.
  if (item.mediaOwnershipVersion !== 1) return 0;
  const slides = array(item.carouselMedia).map(object).filter((x): x is RecordValue => !!x);
  if (slides.length) return slides.filter(x => string(x.mediaUrl) || string(x.thumbnailUrl)).length;
  // A single image/video can have several URL variants, but is one slot.
  if (array(item.mediaUrls).some(string)) return 1;
  return string(item.thumbnailUrl) ? 1 : 0;
}

function sourceKey(value: unknown): string | null {
  const raw = string(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : null;
  } catch { return null; }
}

function postKind(item: RecordValue, tab: "posts" | "reels"): string {
  if (tab === "reels") return "reel";
  return string(item.type) ?? (item.isVideo === true ? "video" : "post");
}

type UniqueAsset = {
  sources: Set<string>;
  hash: string | null;
  primaryVideo: boolean;
  derivedFrom: string | null;
};
type WorkingPost = { item: RecordValue; tab: "posts" | "reels"; downloads: Set<string>;
  uniqueAssets: Map<string, UniqueAsset>; uniqueHashes: Set<string>; analyses: Map<string, RecordValue> };

function addReason(reasons: string[], code: string): void { if (!reasons.includes(code)) reasons.push(code); }
function isVideoPath(path: string): boolean { return /\.(?:mp4|mov|webm|mkv|avi)$/i.test(path); }

function classify(items: RecordValue[]): { status: AnalysisStatus; ok: number; failed: number; skipped: number; reasons: string[] } {
  let ok = 0, failed = 0, skipped = 0;
  const reasons: string[] = [];
  for (const item of items) {
    const status = string(item.status);
    if (status === "ok" || (status === "skipped" && object(item.analysis))) {
      ok++;
      if (status === "skipped") addReason(reasons, "analysis_cache_reused");
    } else if (status === "error" || status === "failed") {
      failed++;
      const error = string(item.error);
      if (error) addReason(reasons, `analysis_error: ${error.slice(0, 500)}`);
    } else if (status === "skipped") {
      skipped++;
      addReason(reasons, string(item.error) ? `analysis_skipped: ${string(item.error)!.slice(0, 500)}` : "analysis_skipped_without_result");
    } else {
      skipped++;
      addReason(reasons, `analysis_unknown_status: ${status ?? "missing"}`);
    }
  }
  const status: AnalysisStatus = items.length === 0 ? "pending"
    : ok && (failed || skipped) ? "partial"
    : ok ? "complete"
    : failed && skipped ? "partial"
    : failed ? "failed" : "skipped";
  return { status, ok, failed, skipped, reasons };
}

function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_coverage_refresh (
      handle TEXT PRIMARY KEY, updated_at TEXT NOT NULL, profile_scraped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS dashboard_post_coverage (
      handle TEXT NOT NULL, shortcode TEXT NOT NULL, post_kind TEXT NOT NULL,
      source_permalink TEXT, in_current_scrape INTEGER NOT NULL,
      discovered_count INTEGER NOT NULL, downloaded_count INTEGER NOT NULL,
      unique_count INTEGER NOT NULL, analysis_count INTEGER NOT NULL,
      analysis_ok INTEGER NOT NULL, analysis_failed INTEGER NOT NULL,
      analysis_skipped INTEGER NOT NULL, analysis_status TEXT NOT NULL,
      reasons_json TEXT NOT NULL, paths_json TEXT NOT NULL, hashes_json TEXT NOT NULL,
      timestamps_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (handle, shortcode)
    );
  `);
}

function rowToPost(row: Row): PostCoverage {
  return {
    shortcode: row.shortcode, postKind: row.post_kind, sourcePermalink: row.source_permalink,
    inCurrentScrape: !!row.in_current_scrape, discoveredCount: row.discovered_count,
    downloadedCount: row.downloaded_count, uniqueCount: row.unique_count,
    analysisCount: row.analysis_count, analysisOk: row.analysis_ok,
    analysisFailed: row.analysis_failed, analysisSkipped: row.analysis_skipped,
    analysisStatus: row.analysis_status, reasons: JSON.parse(row.reasons_json),
    paths: JSON.parse(row.paths_json), hashes: JSON.parse(row.hashes_json),
    timestamps: JSON.parse(row.timestamps_json), updatedAt: row.updated_at,
  };
}

function emptySnapshot(handle: string): CoverageSnapshot {
  return { handle, updatedAt: null, profileScrapedAt: null,
    summary: { total: 0, current: 0, complete: 0, partial: 0, failed: 0, skipped: 0, pending: 0 }, posts: [] };
}

/** Reads persisted coverage only; safe to call for every dashboard GET. */
export function readCoverage(dbPath: string, handle: string): CoverageSnapshot {
  validateHandle(handle);
  if (!existsSync(dbPath)) return emptySnapshot(handle);
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_post_coverage'").get();
    if (!tables) return emptySnapshot(handle);
    const refresh = db.query<{ updated_at: string; profile_scraped_at: string | null }, [string]>(
      "SELECT updated_at, profile_scraped_at FROM dashboard_coverage_refresh WHERE handle = ?").get(handle);
    const posts = db.query<Row, [string]>("SELECT * FROM dashboard_post_coverage WHERE handle = ? ORDER BY in_current_scrape DESC, shortcode").all(handle).map(rowToPost);
    const snapshot = emptySnapshot(handle);
    snapshot.updatedAt = refresh?.updated_at ?? null;
    snapshot.profileScrapedAt = refresh?.profile_scraped_at ?? null;
    snapshot.posts = posts;
    snapshot.summary.total = posts.length;
    for (const post of posts) {
      if (!post.inCurrentScrape) continue;
      snapshot.summary.current++;
      snapshot.summary[post.analysisStatus]++;
    }
    return snapshot;
  } finally { db.close(); }
}

/** Reconciles one explicit handle on dashboard refresh; no workflow state is touched. */
export async function reconcileCoverage(root: string, dbPath: string, handle: string): Promise<CoverageSnapshot> {
  validateHandle(handle);
  root = resolve(root);
  const profilePath = layout.profileJson(handle);
  const profile = (await readJson(join(root, profilePath)))!;
  if (string(profile.username) && profile.username !== handle) throw new Error("coverage profile username mismatch");
  const posts = new Map<string, WorkingPost>();
  for (const tab of ["posts", "reels"] as const) {
    const entries = boundedArray(profile[tab], `profile.${tab}`);
    for (const raw of entries) {
      const item = object(raw);
      if (!item || !validShortcode(item.shortcode)) continue;
      if (!posts.has(item.shortcode)) posts.set(item.shortcode,
        { item, tab, downloads: new Set(), uniqueAssets: new Map(), uniqueHashes: new Set(), analyses: new Map() });
      if (posts.size > MAX_POSTS) throw new Error("coverage profile has too many posts");
    }
  }

  const sourceOwners = new Map<string, Set<string>>();
  for (const [shortcode, post] of posts) {
    if (post.item.mediaOwnershipVersion !== 1) continue;
    const slides = array(post.item.carouselMedia).map(object).filter((x): x is RecordValue => !!x);
    const urls = slides.length
      ? slides.flatMap(slide => [slide.mediaUrl, slide.thumbnailUrl])
      : [...array(post.item.mediaUrls), post.item.thumbnailUrl];
    for (const raw of urls) {
      const key = sourceKey(raw);
      if (!key) continue;
      const owners = sourceOwners.get(key) ?? new Set<string>();
      owners.add(shortcode); sourceOwners.set(key, owners);
    }
  }

  const downloads = await readJson(join(root, layout.mediaManifest(handle)), true);
  if (downloads && string(downloads.username) && downloads.username !== handle) throw new Error("coverage download username mismatch");
  const downloadCandidates = new Map<string, Set<string>>();
  const mediaPrefix = layout.mediaDir(handle);
  const collectDownload = (raw: unknown, rawUrl?: unknown, explicitOwners: unknown[] = []) => {
    const path = artifactPath(root, raw, mediaPrefix);
    if (!path) return;
    const owners = new Set<string>();
    const directoryOwner = path.slice(mediaPrefix.length + 1).split("/")[0];
    if (posts.has(directoryOwner)) owners.add(directoryOwner);
    for (const owner of explicitOwners) if (validShortcode(owner) && posts.has(owner)) owners.add(owner);
    const key = sourceKey(rawUrl);
    if (key) for (const owner of sourceOwners.get(key) ?? []) owners.add(owner);
    for (const owner of owners) {
      const paths = downloadCandidates.get(owner) ?? new Set<string>();
      paths.add(path); downloadCandidates.set(owner, paths);
    }
  };
  for (const raw of boundedArray(downloads?.results, "download results")) {
    const entry = object(raw);
    if (entry && (entry.status === "ok" || entry.status === "skipped"))
      collectDownload(entry.localPath, entry.url, [entry.shortcode, ...array(entry.shortcodes)]);
  }
  const byUrl = object(downloads?.byUrl);
  if (byUrl) {
    if (Object.keys(byUrl).length > MAX_ENTRIES) throw new Error("download byUrl has too many entries");
    for (const [url, path] of Object.entries(byUrl)) collectDownload(path, url);
  }
  for (const [shortcode, paths] of downloadCandidates) {
    const post = posts.get(shortcode)!;
    for (const path of paths) if (await regularFile(root, path)) post.downloads.add(path);
  }

  const unique = await readJson(join(root, layout.uniqueManifest(handle)), true);
  if (unique && string(unique.username) && unique.username !== handle) throw new Error("coverage unique username mismatch");
  const uniquePrefix = layout.uniqueDir(handle);
  for (const key of ["files", "stills"] as const) {
    for (const raw of boundedArray(unique?.[key], `unique ${key}`)) {
      const entry = object(raw);
      if (!entry || !validShortcode(entry.shortcode)) continue;
      const post = posts.get(entry.shortcode);
      const path = artifactPath(root, entry.dest, uniquePrefix);
      if (!post || !path || !(await regularFile(root, path))) continue;
      const source = artifactPath(root, entry.src, mediaPrefix);
      const derivedFrom = key === "stills" ? artifactPath(root, entry.src, uniquePrefix) : null;
      const hash = string(entry.sha256_16) ?? string(entry.sha256);
      const asset = post.uniqueAssets.get(path) ?? {
        sources: new Set<string>(), hash, primaryVideo: false, derivedFrom: null,
      };
      if (source) {
        asset.sources.add(source);
        if (await regularFile(root, source)) post.downloads.add(source);
      }
      if (key === "files" && isVideoPath(path)) asset.primaryVideo = true;
      if (derivedFrom) asset.derivedFrom = derivedFrom;
      if (hash) asset.hash = hash;
      post.uniqueAssets.set(path, asset);
      if (hash) post.uniqueHashes.add(hash);
    }
  }

  const analysisPath = layout.analysisJson(handle);
  const analysis = await readJson(join(root, analysisPath), true, MAX_ANALYSIS_BYTES);
  if (analysis && string(analysis.username) && analysis.username !== handle) throw new Error("coverage analysis username mismatch");
  let analysisItems = boundedArray(analysis?.items, "analysis items");
  if (!analysis) {
    const itemsDir = join(root, layout.analysisItemsDir(handle));
    const names = await readdir(itemsDir).catch(() => []);
    if (names.length > MAX_ITEM_FILES) throw new Error("coverage has too many analysis item files");
    analysisItems = [];
    let itemBytes = 0;
    for (const name of names) {
      if (!name.endsWith(".json") || !ITEM_FILE_STEM.test(name.slice(0, -5))) continue;
      const path = join(itemsDir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      itemBytes += info.size;
      if (itemBytes > MAX_TOTAL_ITEM_BYTES) throw new Error("coverage analysis item files exceed size limit");
      const item = await readJson(path, true, MAX_ITEM_BYTES);
      if (item) analysisItems.push(item);
    }
  }
  for (const raw of analysisItems) {
    const item = object(raw);
    if (!item || !validShortcode(item.shortcode)) continue;
    const post = posts.get(item.shortcode);
    if (!post) continue;
    const id = string(item.id) ?? `${item.shortcode}:${post.analyses.size}`;
    // The aggregate can contain duplicate IDs from a resume. Keep the last row.
    post.analyses.set(id, item);
  }

  const now = new Date().toISOString();
  const scrapedAt = string(profile.scrapedAt);
  const itemDirInfo = await stat(join(root, layout.analysisItemsDir(handle))).catch(() => null);
  const hasItemDir = itemDirInfo?.isDirectory() === true;
  const current: PostCoverage[] = [];
  for (const [shortcode, post] of posts) {
    const items = [...post.analyses.values()];
    const result = classify(items);
    const reasons = [...result.reasons];
    const successful = items.filter(item => item.status === "ok" ||
      (item.status === "skipped" && object(item.analysis)));
    const sampledVideos = successful.filter(item => item.analysisMethod === "sampled-video-frames").length;
    if (sampledVideos) {
      addReason(reasons, `sampled_video_frame_analysis_count: ${sampledVideos}`);
      addReason(reasons, "motion_and_audio_not_verified_for_sampled_clips");
    }
    const directlyCovered = new Map<string, boolean>();
    for (const [path, asset] of post.uniqueAssets) {
      directlyCovered.set(path, successful.some(item => {
        const source = artifactPath(root, item.localPath, "data");
        if (source === path || (source && asset.sources.has(source))) return true;
        const digest = string(item.sourceSha256) ?? string(item.sourceSHA256) ??
          string(item.sourceHash) ?? string(item.sha256_16);
        return !!asset.hash && !!digest && digest.startsWith(asset.hash);
      }));
    }
    const missingAssets: string[] = [];
    let derivedPreviewsCovered = 0;
    for (const [path, asset] of post.uniqueAssets) {
      let covered = directlyCovered.get(path) === true;
      if (!covered && asset.derivedFrom) {
        const parentVideo = post.uniqueAssets.get(asset.derivedFrom);
        if (parentVideo?.primaryVideo && directlyCovered.get(asset.derivedFrom)) {
          covered = true;
          derivedPreviewsCovered++;
        }
      }
      if (!covered) missingAssets.push(path);
    }
    if (derivedPreviewsCovered) {
      addReason(reasons, "derived_preview_covered_by_video_analysis");
      addReason(reasons, `derived_preview_covered_by_video_analysis_count: ${derivedPreviewsCovered}`);
    }
    if (missingAssets.length) {
      addReason(reasons, `analysis_missing_for_unique_assets: ${missingAssets.length}`);
      for (const path of missingAssets.slice(0, 20)) addReason(reasons, `analysis_missing: ${path}`);
      if (missingAssets.length > 20) addReason(reasons, `analysis_missing_paths_omitted: ${missingAssets.length - 20}`);
    }
    const incompleteCarousel = post.item.type === "carousel" && (post.item.carouselComplete === false || array(post.item.carouselMedia).length < 2);
    if (incompleteCarousel) addReason(reasons,"carousel_incomplete");
    if (post.item.detailStatus === "failed" || post.item.detailStatus === "incomplete") addReason(reasons,"capture_"+post.item.detailStatus);
    if (string(post.item.detailError)) addReason(reasons,"capture_error: "+String(post.item.detailError).slice(0,500));
    const analysisStatus = result.ok && (missingAssets.length || incompleteCarousel) ? "partial" : result.status;
    const discoveredCount = mediaCount(post.item);
    if (post.item.mediaOwnershipVersion !== 1) addReason(reasons, "media_ownership_unverified");
    if (!discoveredCount) addReason(reasons, "no_verified_media_discovered");
    if (discoveredCount && !post.downloads.size) addReason(reasons, "download_missing");
    if (post.downloads.size && !post.uniqueAssets.size) addReason(reasons, "unique_missing");
    if (!items.length) addReason(reasons, "analysis_pending");
    const analyzedAt = items.map(item => string(item.analyzedAt)).filter((x): x is string => !!x).sort().at(-1) ?? null;
    const inputHashes = [...new Set(items.map(item => string(item.inputHash)).filter((x): x is string => !!x))].sort();
    const analysisPaths = new Set<string>();
    if (items.length && analysis) analysisPaths.add(analysisPath);
    for (const item of hasItemDir ? items : []) {
      const id = string(item.id);
      const stem = id && itemFileStem(id);
      if (!stem) continue;
      const itemPath = `${layout.analysisItemsDir(handle)}/${stem}.json`;
      if (await regularFile(root, itemPath)) analysisPaths.add(itemPath);
    }
    current.push({
      shortcode, postKind: postKind(post.item, post.tab), sourcePermalink: string(post.item.permalink),
      inCurrentScrape: true, discoveredCount, downloadedCount: post.downloads.size,
      uniqueCount: post.uniqueAssets.size, analysisCount: items.length, analysisOk: result.ok,
      analysisFailed: result.failed, analysisSkipped: result.skipped, analysisStatus,
      reasons, paths: { profile: profilePath, downloads: [...post.downloads].sort(),
        unique: [...post.uniqueAssets.keys()].sort(), analysis: [...analysisPaths].sort() },
      hashes: { unique: [...post.uniqueHashes].sort(), analysisInputs: inputHashes },
      timestamps: { publishedAt: string(post.item.timestamp), scrapedAt, analyzedAt }, updatedAt: now,
    });
  }

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    createTables(db);
    const upsert = db.query(`INSERT INTO dashboard_post_coverage (
      handle, shortcode, post_kind, source_permalink, in_current_scrape,
      discovered_count, downloaded_count, unique_count, analysis_count, analysis_ok,
      analysis_failed, analysis_skipped, analysis_status, reasons_json, paths_json,
      hashes_json, timestamps_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(handle, shortcode) DO UPDATE SET
      post_kind=excluded.post_kind, source_permalink=excluded.source_permalink,
      in_current_scrape=excluded.in_current_scrape, discovered_count=excluded.discovered_count,
      downloaded_count=excluded.downloaded_count, unique_count=excluded.unique_count,
      analysis_count=excluded.analysis_count, analysis_ok=excluded.analysis_ok,
      analysis_failed=excluded.analysis_failed, analysis_skipped=excluded.analysis_skipped,
      analysis_status=excluded.analysis_status, reasons_json=excluded.reasons_json,
      paths_json=excluded.paths_json, hashes_json=excluded.hashes_json,
      timestamps_json=excluded.timestamps_json, updated_at=excluded.updated_at`);
    const transaction = db.transaction(() => {
      db.query("UPDATE dashboard_post_coverage SET in_current_scrape = 0, updated_at = ? WHERE handle = ?").run(now, handle);
      for (const post of current) {
        upsert.run(handle, post.shortcode, post.postKind, post.sourcePermalink, 1,
          post.discoveredCount, post.downloadedCount, post.uniqueCount, post.analysisCount,
          post.analysisOk, post.analysisFailed, post.analysisSkipped, post.analysisStatus,
          JSON.stringify(post.reasons), JSON.stringify(post.paths), JSON.stringify(post.hashes),
          JSON.stringify(post.timestamps), post.updatedAt);
      }
      db.query(`UPDATE dashboard_post_coverage SET reasons_json =
        CASE WHEN EXISTS (SELECT 1 FROM json_each(reasons_json) WHERE value = 'not_in_latest_scrape')
          THEN reasons_json ELSE json_insert(reasons_json, '$[#]', 'not_in_latest_scrape') END
        WHERE handle = ? AND in_current_scrape = 0`).run(handle);
      db.query(`INSERT INTO dashboard_coverage_refresh (handle, updated_at, profile_scraped_at)
        VALUES (?, ?, ?) ON CONFLICT(handle) DO UPDATE SET
        updated_at=excluded.updated_at, profile_scraped_at=excluded.profile_scraped_at`).run(handle, now, scrapedAt);
    });
    transaction();
  } finally { db.close(); }
  return readCoverage(dbPath, handle);
}
