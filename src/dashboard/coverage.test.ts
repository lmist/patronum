import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCoverage, reconcileCoverage } from "./coverage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patronum-coverage-"));
  roots.push(root);
  const dbPath = join(root, "patronum.sqlite");
  async function put(path: string, value: unknown) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, typeof value === "string" ? value : JSON.stringify(value));
  }
  return { root, dbPath, put };
}

describe("post coverage ledger", () => {
  test("records sampled-frame analysis and its limits in the database reasons", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "sample", posts: [{ shortcode: "SHORT", type: "video", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/short.mp4"] }] });
    await put("data/analysis/sample/analysis.json", { username: "sample", items: [{ id: "SHORT", shortcode: "SHORT", status: "ok", analysisMethod: "sampled-video-frames", frameCount: 3, analysis: { summary: "Frames" } }] });
    await reconcileCoverage(root, dbPath, "sample");
    const post = readCoverage(dbPath, "sample").posts[0]!;
    expect(post.reasons).toContain("sampled_video_frame_analysis_count: 1");
    expect(post.reasons).toContain("motion_and_audio_not_verified_for_sampled_clips");
    expect(post.analysisCount).toBe(1);
  });
  test("reconciles both profile tabs and distinguishes cached analysis from failures", async () => {
    const { root, dbPath, put } = await fixture();
    const handle = "sample";
    await put("data/profiles/sample-profile.json", {
      username: handle, scrapedAt: "2026-09-14T10:00:00Z",
      posts: [
        { shortcode: "IMAGE_1", type: "image", permalink: "https://www.instagram.com/p/IMAGE_1/", timestamp: "2026-09-01T00:00:00Z", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/a.jpg"] },
        { shortcode: "REEL_1", type: "video", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/v.mp4"] },
        { shortcode: "NO_JOB", type: "carousel", mediaOwnershipVersion: 1, carouselMedia: [{ mediaUrl: "https://cdn/a.jpg" }, { mediaUrl: "https://cdn/b.jpg" }] },
      ],
      reels: [{ shortcode: "REEL_1", type: "video", permalink: "https://www.instagram.com/reel/REEL_1/" }],
    });
    await put("data/media/sample/IMAGE_1/image.jpg", "image");
    await put("data/media/sample/REEL_1/video.mp4", "video");
    await put("data/media/sample/manifest.json", { username: handle, results: [
      { localPath: "data/media/sample/IMAGE_1/image.jpg", status: "ok" },
      { localPath: "data/media/sample/IMAGE_1/image.jpg", status: "skipped" },
      { localPath: "data/media/sample/REEL_1/video.mp4", status: "ok" },
      { localPath: "data/media/sample/NO_JOB/missing.jpg", status: "ok" },
    ] });
    await put("data/sample-unique/image.jpg", "unique-image");
    await put("data/sample-unique/video.mp4", "unique-video");
    await put("data/sample-unique/manifest.json", { username: handle, files: [
      { shortcode: "IMAGE_1", src: "data/media/sample/IMAGE_1/image.jpg", dest: "data/sample-unique/image.jpg", sha256_16: "abc123" },
      { shortcode: "REEL_1", src: "data/media/sample/REEL_1/video.mp4", dest: "data/sample-unique/video.mp4", sha256_16: "def456" },
    ], stills: [{ shortcode: "IMAGE_1", dest: "data/sample-unique/image.jpg", sha256_16: "abc123" }] });
    await put("data/analysis/sample/analysis.json", { username: handle, items: [
      { id: "IMAGE_1", shortcode: "IMAGE_1", localPath: "data/media/sample/IMAGE_1/image.jpg", status: "skipped", analysis: { summary: "reused" }, inputHash: "hash-one", analyzedAt: "2026-09-14T10:30:00Z" },
      { id: "REEL_1", shortcode: "REEL_1", localPath: "data/sample-unique/video.mp4", status: "ok", analysis: { summary: "video" } },
      { id: "REEL_1__still", shortcode: "REEL_1", status: "error", error: "unreadable video packet" },
    ] });

    const coverage = await reconcileCoverage(root, dbPath, handle);
    expect(coverage.summary).toEqual({ total: 3, current: 3, complete: 1, partial: 1, failed: 0, skipped: 0, pending: 1 });
    const byId = Object.fromEntries(coverage.posts.map(post => [post.shortcode, post]));
    expect(byId.IMAGE_1).toMatchObject({ discoveredCount: 1, downloadedCount: 1, uniqueCount: 1, analysisCount: 1, analysisOk: 1, analysisStatus: "complete" });
    expect(byId.IMAGE_1.reasons).toContain("analysis_cache_reused");
    expect(byId.IMAGE_1.hashes).toEqual({ unique: ["abc123"], analysisInputs: ["hash-one"] });
    expect(byId.IMAGE_1.paths.analysis).toEqual(["data/analysis/sample/analysis.json"]);
    expect(byId.REEL_1).toMatchObject({ postKind: "video", analysisCount: 2, analysisOk: 1, analysisFailed: 1, analysisStatus: "partial" });
    expect(byId.REEL_1.reasons).toContain("analysis_error: unreadable video packet");
    expect(byId.NO_JOB).toMatchObject({ discoveredCount: 2, downloadedCount: 0, analysisCount: 0, analysisStatus: "pending" });
    expect(byId.NO_JOB.reasons).toContain("download_missing");
    expect(readCoverage(dbPath, handle)).toEqual(coverage);
  });

  test("retains prior shortcodes after a smaller scrape without mixing handles", async () => {
    const { root, dbPath, put } = await fixture();
    const profile = (shortcodes: string[]) => ({ username: "sample", posts: shortcodes.map(shortcode => ({ shortcode, type: "image", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/a.jpg"] })) });
    await put("data/profiles/sample-profile.json", profile(["FIRST", "SECOND"]));
    await reconcileCoverage(root, dbPath, "sample");
    await put("data/profiles/sample-profile.json", profile(["SECOND"]));
    const next = await reconcileCoverage(root, dbPath, "sample");
    expect(next.summary).toMatchObject({ total: 2, current: 1 });
    expect(next.posts.find(post => post.shortcode === "FIRST")).toMatchObject({ inCurrentScrape: false });
    expect(next.posts.find(post => post.shortcode === "FIRST")?.reasons).toContain("not_in_latest_scrape");
    expect(readCoverage(dbPath, "other").posts).toEqual([]);
    const db = new Database(dbPath, { readonly: true });
    try { expect(db.query("SELECT count(*) AS count FROM dashboard_post_coverage").get()).toEqual({ count: 2 }); }
    finally { db.close(); }
  });

  test("marks an analyzed carousel partial when a unique slide has no analysis and credits a shared download", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "sample", posts: [
      { shortcode: "CAROUSEL", type: "carousel", mediaOwnershipVersion: 1,
        carouselMedia: [{ mediaUrl: "https://cdn/shared.jpg?one" }, { mediaUrl: "https://cdn/second.jpg" }] },
      { shortcode: "OTHER", type: "image", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/shared.jpg?two"] },
    ] });
    await put("data/media/sample/OTHER/shared.jpg", "shared");
    await put("data/media/sample/CAROUSEL/second.jpg", "second");
    await put("data/media/sample/manifest.json", { username: "sample", results: [
      { url: "https://cdn/shared.jpg?three", localPath: "data/media/sample/OTHER/shared.jpg", status: "ok" },
      { url: "https://cdn/second.jpg", localPath: "data/media/sample/CAROUSEL/second.jpg", status: "ok" },
    ] });
    await put("data/sample-unique/one.jpg", "one");
    await put("data/sample-unique/two.jpg", "two");
    await put("data/sample-unique/manifest.json", { username: "sample", files: [
      { shortcode: "CAROUSEL", src: "data/media/sample/OTHER/shared.jpg", dest: "data/sample-unique/one.jpg", sha256_16: "onehash" },
      { shortcode: "CAROUSEL", src: "data/media/sample/CAROUSEL/second.jpg", dest: "data/sample-unique/two.jpg", sha256_16: "twohash" },
    ] });
    await put("data/analysis/sample/analysis.json", { username: "sample", items: [
      { id: "CAROUSEL", shortcode: "CAROUSEL", localPath: "data/media/sample/OTHER/shared.jpg", status: "ok", analysis: { summary: "first slide" } },
    ] });

    const coverage = await reconcileCoverage(root, dbPath, "sample");
    const carousel = coverage.posts.find(post => post.shortcode === "CAROUSEL")!;
    expect(carousel).toMatchObject({ discoveredCount: 2, downloadedCount: 2, uniqueCount: 2, analysisCount: 1, analysisOk: 1, analysisStatus: "partial" });
    expect(carousel.reasons).toContain("analysis_missing_for_unique_assets: 1");
    expect(coverage.posts.find(post => post.shortcode === "OTHER")?.downloadedCount).toBe(1);
  });

  test("credits derived still previews through analyzed primary videos without counting still analyses", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "sample", posts: [{
      shortcode: "MIXED", type: "carousel", mediaOwnershipVersion: 1, carouselComplete: true,
      carouselMedia: [{ mediaUrl: "https://cdn/first.mp4" }, { mediaUrl: "https://cdn/second.mp4" }],
    }] });
    for (const path of ["data/media/sample/MIXED/first.mp4", "data/media/sample/MIXED/second.mp4",
      "data/sample-unique/first.mp4", "data/sample-unique/second.mp4",
      "data/sample-unique/first.jpg", "data/sample-unique/second.jpg"]) await put(path, path);
    await put("data/sample-unique/manifest.json", { username: "sample", files: [
      { shortcode: "MIXED", src: "data/media/sample/MIXED/first.mp4", dest: "data/sample-unique/first.mp4" },
      { shortcode: "MIXED", src: "data/media/sample/MIXED/second.mp4", dest: "data/sample-unique/second.mp4" },
    ], stills: [
      { shortcode: "MIXED", kind: "still", src: "data/sample-unique/first.mp4", dest: "data/sample-unique/first.jpg" },
      { shortcode: "MIXED", kind: "still", src: "data/sample-unique/second.mp4", dest: "data/sample-unique/second.jpg" },
    ] });
    await put("data/analysis/sample/analysis.json", { username: "sample", items: [
      { id: "MIXED__first", shortcode: "MIXED", localPath: "data/media/sample/MIXED/first.mp4", status: "ok", analysis: { summary: "first video" } },
      { id: "MIXED__second", shortcode: "MIXED", localPath: "data/media/sample/MIXED/second.mp4", status: "ok", analysis: { summary: "second video" } },
    ] });

    const post = (await reconcileCoverage(root, dbPath, "sample")).posts[0]!;
    expect(post).toMatchObject({ uniqueCount: 4, analysisCount: 2, analysisOk: 2, analysisStatus: "complete" });
    expect(post.reasons).toContain("derived_preview_covered_by_video_analysis");
    expect(post.reasons).toContain("derived_preview_covered_by_video_analysis_count: 2");
    expect(post.reasons.some(reason => reason.startsWith("analysis_missing"))).toBe(false);
  });

  test("keeps missing primary video and cross-post preview aliases partial", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "sample", posts: [
      { shortcode: "A", type: "carousel", mediaOwnershipVersion: 1, carouselComplete: true,
        carouselMedia: [{ mediaUrl: "https://cdn/a.mp4" }, { mediaUrl: "https://cdn/a.jpg" }] },
      { shortcode: "B", type: "video", mediaOwnershipVersion: 1, mediaUrls: ["https://cdn/b.mp4"] },
    ] });
    for (const path of ["data/media/sample/A/video.mp4", "data/media/sample/A/image.jpg",
      "data/media/sample/B/video.mp4", "data/sample-unique/a.mp4", "data/sample-unique/a-image.jpg",
      "data/sample-unique/b.mp4", "data/sample-unique/a-preview.jpg", "data/sample-unique/cross-preview.jpg"])
      await put(path, path);
    await put("data/sample-unique/manifest.json", { username: "sample", files: [
      { shortcode: "A", src: "data/media/sample/A/video.mp4", dest: "data/sample-unique/a.mp4" },
      { shortcode: "A", src: "data/media/sample/A/image.jpg", dest: "data/sample-unique/a-image.jpg" },
      { shortcode: "B", src: "data/media/sample/B/video.mp4", dest: "data/sample-unique/b.mp4" },
    ], stills: [
      { shortcode: "A", kind: "still", src: "data/sample-unique/a.mp4", dest: "data/sample-unique/a-preview.jpg" },
      { shortcode: "A", kind: "still", src: "data/sample-unique/b.mp4", dest: "data/sample-unique/cross-preview.jpg" },
    ] });
    await put("data/analysis/sample/analysis.json", { username: "sample", items: [
      { id: "A__image", shortcode: "A", localPath: "data/media/sample/A/image.jpg", status: "ok", analysis: { summary: "image" } },
      { id: "B__video", shortcode: "B", localPath: "data/media/sample/B/video.mp4", status: "ok", analysis: { summary: "video" } },
    ] });

    const byId = Object.fromEntries((await reconcileCoverage(root, dbPath, "sample")).posts.map(post => [post.shortcode, post]));
    expect(byId.A.analysisStatus).toBe("partial");
    expect(byId.A.reasons).toContain("analysis_missing_for_unique_assets: 3");
    expect(byId.A.reasons).not.toContain("derived_preview_covered_by_video_analysis");
    expect(byId.B.analysisStatus).toBe("complete");
  });

  test("rejects a mismatched profile before writing a ledger", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "other", posts: [{ shortcode: "FIRST" }] });
    await expect(reconcileCoverage(root, dbPath, "sample")).rejects.toThrow("profile username mismatch");
    expect(readCoverage(dbPath, "sample").posts).toEqual([]);
  });

  test("reads all analysis rows from an all-frames aggregate larger than the old 32 MiB limit", async () => {
    const { root, dbPath, put } = await fixture();
    const shortcodes = Array.from({ length: 825 }, (_, i) => `SC${String(i).padStart(4, "0")}`);
    await put("data/profiles/sample-profile.json", {
      username: "sample", posts: shortcodes.map(shortcode => ({ shortcode, type: "carousel",
        carouselComplete: true, mediaOwnershipVersion: 1,
        carouselMedia: Array.from({ length: 10 }, (_, i) => ({ mediaUrl: `https://cdn/${shortcode}/${i}.jpg` })) })),
    });
    const rawText = "x".repeat(4096);
    const items = shortcodes.flatMap(shortcode => Array.from({ length: 10 }, (_, i) => ({
      id: `${shortcode}__slide_${String(i + 1).padStart(2, "0")}.jpg`, shortcode,
      status: "ok", analysis: { summary: "analyzed" }, rawText,
    })));
    const aggregate = JSON.stringify({ username: "sample", items });
    expect(Buffer.byteLength(aggregate)).toBeGreaterThan(32 * 1024 * 1024);
    await put("data/analysis/sample/analysis.json", aggregate);

    const coverage = await reconcileCoverage(root, dbPath, "sample");
    expect(coverage.summary).toMatchObject({ total: 825, current: 825, complete: 825 });
    expect(coverage.posts.at(0)?.analysisCount).toBe(10);
    expect(coverage.posts.at(-1)?.analysisCount).toBe(10);
  });

  test("resolves sanitized numeric slide item filenames when only item files remain", async () => {
    const { root, dbPath, put } = await fixture();
    await put("data/profiles/sample-profile.json", { username: "sample", posts: [{ shortcode: "SC", type: "image" }] });
    await put("data/analysis/sample/items/SC__SC_10_hash_jpg.json", {
      id: "SC__SC_10_hash.jpg", shortcode: "SC", status: "ok", analysis: { summary: "slide ten" },
    });

    const coverage = await reconcileCoverage(root, dbPath, "sample");
    expect(coverage.posts[0]).toMatchObject({ analysisCount: 1, analysisStatus: "complete" });
    expect(coverage.posts[0]?.paths.analysis).toEqual(["data/analysis/sample/items/SC__SC_10_hash_jpg.json"]);
  });
});
