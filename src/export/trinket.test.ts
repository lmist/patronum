import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { KnowledgeDocument, KnowledgeSink } from "./sink.js";
import { exportTrinket } from "./trinket.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { root: string; targetDir: string } {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = resolve(import.meta.dir, `.test-trinket-repo-${nonce}`);
  const targetDir = resolve(import.meta.dir, `.test-trinket-okf-${nonce}`);
  roots.push(root, targetDir);
  mkdirSync(join(root, "data/profiles"), { recursive: true });
  mkdirSync(join(root, "data/analysis/acme"), { recursive: true });
  mkdirSync(join(root, "data/acme-unique"), { recursive: true });
  mkdirSync(join(root, "data/media/acme/POST_A"), { recursive: true });
  mkdirSync(join(root, "data/media/acme/POST_B"), { recursive: true });
  mkdirSync(join(targetDir, ".ok"), { recursive: true });
  writeFileSync(join(targetDir, ".ok/config.yml"), "content:\n  dir: .\n");
  writeFileSync(join(root, "data/acme-unique/photo.jpg"), "independent image bytes");
  writeFileSync(join(root, "data/acme-unique/clip.mp4"), "independent video bytes");
  writeFileSync(join(root, "data/media/acme/POST_A/photo.jpg"), "independent image bytes");
  writeFileSync(join(root, "data/media/acme/POST_B/clip.mp4"), "independent video bytes");
  writeFileSync(join(root, "data/profiles/acme-profile.json"), JSON.stringify({
    username: "acme",
    posts: [
      { shortcode: "POST_A", type: "carousel", caption: "Full caption\nwith [markup] and `code`.", timestamp: "2026-09-13T10:00:00Z", permalink: "https://www.instagram.com/p/POST_A/" },
      { shortcode: "POST_B", type: "video", caption: "Second caption", timestamp: "2026-09-12T10:00:00Z", permalink: "https://www.instagram.com/reel/POST_B/" },
    ],
    reels: [],
  }, null, 2));
  writeFileSync(join(root, "data/analysis/acme/analysis.json"), JSON.stringify({
    username: "acme",
    analyzedAt: "2026-09-14T00:00:00Z",
    items: [
      { id: "POST_A__still", shortcode: "POST_A", kind: "post", localPath: "data/media/acme/POST_A/photo.jpg", mediaType: "image", caption: "Full caption", status: "ok", model: "fixture-model", analysis: { summary: "Exact summary", style_tags: ["Editorial minimal"], mood: ["Calm"], subjects: ["Bottle"], confidence: 0.875, nested: { preserved: true } } },
      { id: "POST_B", shortcode: "POST_B", kind: "post", localPath: "data/media/acme/POST_B/clip.mp4", mediaType: "video", status: "error", error: "recorded failure" },
    ],
  }, null, 2));
  writeFileSync(join(root, "data/acme-unique/manifest.json"), JSON.stringify({
    username: "acme",
    files: [
      { title: "Photo", date: "2026-09-13", shortcode: "POST_A", kind: "image", src: "data/media/acme/POST_A/photo.jpg", dest: "data/acme-unique/photo.jpg" },
      { title: "Clip", date: "2026-09-12", shortcode: "POST_B", kind: "video", src: "data/media/acme/POST_B/clip.mp4", dest: "data/acme-unique/clip.mp4" },
    ],
    stills: [],
  }, null, 2));
  return { root, targetDir };
}

class FixtureSink implements KnowledgeSink {
  writes: KnowledgeDocument[][] = [];
  audits: string[] = [];
  prepared: string[][] = [];

  constructor(private failWrite = false) {}

  async writeDocuments(documents: KnowledgeDocument[]): Promise<void> {
    this.writes.push(documents.map((document) => ({ ...document })));
    if (this.failWrite) throw new Error("OpenKnowledge returned an incomplete document batch result");
  }

  async audit(path: string): Promise<void> {
    this.audits.push(path);
  }

  async prepareFolders(paths: string[]): Promise<void> {
    this.prepared.push(paths);
  }

  async close(): Promise<void> {}
}

function flattened(sink: FixtureSink): KnowledgeDocument[] {
  return sink.writes.flat();
}

describe("standalone OpenKnowledge trinket export", () => {
  it("exports saved checkpoints without an aggregate or new analysis requests", async () => {
    const { root, targetDir } = fixture();
    const aggregatePath = join(root, "data/analysis/acme/analysis.json");
    const original = JSON.parse(readFileSync(aggregatePath, "utf8"));
    const itemsDir = join(root, "data/analysis/acme/items");
    mkdirSync(itemsDir);
    for (const item of original.items) writeFileSync(join(itemsDir, `${item.id}.json`), JSON.stringify(item));
    rmSync(aggregatePath);
    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);
    expect(result.postCount).toBe(2);
    expect(existsSync(aggregatePath)).toBe(false);
    const saved = JSON.parse(readFileSync(join(targetDir, result.dir, "original/analysis.json"), "utf8"));
    expect(saved.source).toBe("item-checkpoints");
    expect(saved.complete).toBe(false);
    expect(saved.ok).toBe(1);
    expect(saved.failed).toBe(1);
    expect(saved.items).toEqual(original.items);
    expect(flattened(sink).some(doc => doc.content.includes("Exact summary"))).toBe(true);
  });
  it("labels sampled-video-frame analysis without claiming native motion or audio inspection", async () => {
    const { root, targetDir } = fixture();
    const path = join(root, "data/analysis/acme/analysis.json");
    const analysis = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(analysis.items[1], { status: "ok", analysisMethod: "sampled-video-frames", frameCount: 3,
      limitations: "Audio and motion between samples were not verified.", analysis: { summary: "Design visible in three frames" } });
    writeFileSync(path, JSON.stringify(analysis));
    const sink = new FixtureSink();
    await exportTrinket({ root, handle: "acme", targetDir }, sink);
    const doc = flattened(sink).find(doc => doc.path.endsWith("/posts/POST_B/analysis"))!.content;
    expect(doc).toContain("sampled video frames (3 frames)");
    expect(doc).toContain("Audio and motion between samples were not verified.");
  });
  it("creates an immutable content-addressed snapshot with portable evidence and inventory", async () => {
    const { root, targetDir } = fixture();
    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);

    expect(result.changed).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.dir).toBe(`exports/acme/${result.hash}`);
    expect(result).toMatchObject({ postCount: 2, assetCount: 2, topicCount: 3 });
    expect(sink.audits).toEqual([result.dir]);
    expect(sink.prepared[0]).toContain(`${result.dir}/posts/POST_A`);
    expect(existsSync(join(targetDir, result.dir, "posts/POST_A/media/001-photo.jpg"))).toBe(true);
    expect(existsSync(join(targetDir, result.dir, "posts/POST_B/media/001-clip.mp4"))).toBe(true);
    expect(readFileSync(join(targetDir, result.dir, "posts/POST_A/media/001-photo.jpg"), "utf8")).toBe("independent image bytes");

    const docs = flattened(sink);
    const source = docs.find((document) => document.path.endsWith("/posts/POST_A/source"))?.content ?? "";
    expect(source).toContain("type: source");
    expect(source).toContain('source_url: "https://www.instagram.com/p/POST_A/"');
    expect(source).toContain("Full caption\nwith [markup] and `code`.");
    expect(source).toContain("](./media/001-photo.jpg)");
    expect(source).toContain("![Exact summary — image 1]");
    expect(source).not.toContain("data/acme-unique");

    const analysis = docs.find((document) => document.path.endsWith("/posts/POST_A/analysis"))?.content ?? "";
    expect(analysis).toContain("[post source](./source.md)");
    expect(analysis).toContain('"confidence": 0.875');
    expect(analysis).toContain("**Confidence:** 0.875");
    expect(analysis).toContain("[Local media](./media/001-photo.jpg)");
    expect(analysis).not.toContain("data/media/acme/POST_A/photo.jpg");
    expect(analysis).toContain('"nested"');
    expect(analysis).toContain('"status": "ok"');
    const failed = docs.find((document) => document.path.endsWith("/posts/POST_B/analysis"))?.content ?? "";
    expect(failed).toContain('"status": "error"');
    expect(failed).toContain('"error": "recorded failure"');

    const topic = docs.find((document) => document.path.includes("/topics/style/") && !document.path.endsWith("/index"))?.content ?? "";
    expect(topic).toContain("type: topic");
    expect(topic).toContain("[POST\\_A analysis](../../posts/POST_A/analysis.md)");
    expect(docs.find((document) => document.path.endsWith("/dates/index"))?.content.startsWith("# Date index")).toBe(true);
    expect(docs.find((document) => document.path.endsWith("/types/index"))?.content.startsWith("# Type index")).toBe(true);
    expect(docs.find((document) => document.path.endsWith("/topics/index"))?.content.startsWith("# Topic index")).toBe(true);
    const home = docs.find((document) => document.path === result.dir + "/index")?.content ?? "";
    expect(home.startsWith("# @acme trinket box")).toBe(true);
    expect(home).not.toContain("Immutable input hash");
    expect(home).toContain("![Full caption cover](./posts/POST_A/media/001-photo.jpg)");
    expect(home).toContain("[Open the gallery](./gallery/index.md)");
    expect(docs.find(document=>document.path.endsWith("/gallery/index"))?.content).toContain("](../posts/POST_A/source.md)");
    expect(docs.find(document=>document.path.endsWith("/gallery/index"))?.content).toContain("](../posts/POST_A/media/001-photo.jpg)");

    const manifest = JSON.parse(readFileSync(join(targetDir, result.manifestPath), "utf8"));
    expect(manifest.contentHash).toBe(result.hash);
    expect(manifest.coverage).toMatchObject({ posts: 2, analyses: 2, media: 2, analysisStatuses: { ok: 1, error: 1 } });
    expect(manifest.inventory.every((entry: any) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(manifest.inventory.map((entry: any) => entry.path)).toContain("original/profile.json");
    expect(manifest.inventory.map((entry: any) => entry.path)).toContain("posts/POST_A/media/001-photo.jpg");
    expect(manifest.coverage.byPost[0].mediaRecords[0]).toMatchObject({
      path: "posts/POST_A/media/001-photo.jpg", analysis: [{ id: "POST_A__still", status: "ok" }],
    });
    expect(readFileSync(join(targetDir, result.dir, "original/profile.json"), "utf8"))
      .toBe(readFileSync(join(root, "data/profiles/acme-profile.json"), "utf8"));
  });

  it("does not rewrite or audit an existing snapshot", async () => {
    const { root, targetDir } = fixture();
    const firstSink = new FixtureSink();
    const first = await exportTrinket({ root, handle: "acme", targetDir }, firstSink);
    writeFileSync(join(targetDir, first.dir, "personal-notes.txt"), "User annotation\n");

    const repeatSink = new FixtureSink();
    const repeated = await exportTrinket({ root, handle: "acme", targetDir }, repeatSink);
    expect(repeated.hash).toBe(first.hash);
    expect(repeated.changed).toBe(false);
    expect(repeatSink.writes).toHaveLength(0);
    expect(repeatSink.audits).toHaveLength(0);
    expect(readFileSync(join(targetDir, first.dir, "personal-notes.txt"), "utf8")).toBe("User annotation\n");
  });

  it("shows manifest geometry beside each asset without changing the model analysis", async () => {
    const { root, targetDir } = fixture();
    const analysisPath = join(root, "data/analysis/acme/analysis.json");
    const analysisInput = JSON.parse(readFileSync(analysisPath, "utf8"));
    analysisInput.items[1].status = "ok";
    delete analysisInput.items[1].error;
    analysisInput.items[1].analysis = { summary: "A 9:16 vertical video." };
    writeFileSync(analysisPath, JSON.stringify(analysisInput));

    const manifestPath = join(root, "data/acme-unique/manifest.json");
    const unique = JSON.parse(readFileSync(manifestPath, "utf8"));
    Object.assign(unique.files[0], { width: 1080, height: 1080 });
    Object.assign(unique.files[1], { width: 720, height: 900, duration_s: 13.6 });
    writeFileSync(manifestPath, JSON.stringify(unique));

    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);
    const docs = flattened(sink);
    const photoSource = docs.find((document) => document.path.endsWith("/posts/POST_A/source"))?.content ?? "";
    const videoSource = docs.find((document) => document.path.endsWith("/posts/POST_B/source"))?.content ?? "";
    const videoAnalysis = docs.find((document) => document.path.endsWith("/posts/POST_B/analysis"))?.content ?? "";

    expect(photoSource).toContain("Dimensions: 1080 × 1080 px (1:1)");
    expect(videoSource).toContain("Dimensions: 720 × 900 px (4:5) · Duration: 13.6 s");
    expect(videoAnalysis).toContain("[Local media](./media/001-clip.mp4)");
    expect(videoAnalysis).toContain("Dimensions: 720 × 900 px (4:5) · Duration: 13.6 s");
    expect(videoAnalysis).toContain("A 9:16 vertical video.");
    expect(readFileSync(join(targetDir, result.dir, "original/analysis.json"), "utf8"))
      .toBe(readFileSync(analysisPath, "utf8"));
  });

  it("links derived previews only to their exact analyzed source video", async () => {
    const { root, targetDir } = fixture();
    const analysisPath = join(root, "data/analysis/acme/analysis.json");
    const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
    analysis.items[1].status = "ok";
    delete analysis.items[1].error;
    analysis.items[1].analysis = { summary: "A video of a bottle." };
    writeFileSync(analysisPath, JSON.stringify(analysis));

    writeFileSync(join(root, "data/acme-unique/clip-preview.jpg"), "preview frame bytes");
    writeFileSync(join(root, "data/acme-unique/orphan-preview.jpg"), "orphan frame bytes");
    const manifestPath = join(root, "data/acme-unique/manifest.json");
    const unique = JSON.parse(readFileSync(manifestPath, "utf8"));
    unique.stills = [
      { shortcode: "POST_B", kind: "still", src: "data/acme-unique/clip.mp4", dest: "data/acme-unique/clip-preview.jpg", width: 720, height: 900 },
      { shortcode: "POST_B", kind: "still", src: "data/acme-unique/missing.mp4", dest: "data/acme-unique/orphan-preview.jpg", width: 720, height: 900 },
    ];
    writeFileSync(manifestPath, JSON.stringify(unique));

    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);
    const docs = flattened(sink);
    const source = docs.find((document) => document.path.endsWith("/posts/POST_B/source"))?.content ?? "";
    const notes = docs.find((document) => document.path.endsWith("/posts/POST_B/analysis"))?.content ?? "";
    expect(source).toContain("Preview derived from [analyzed source video](./media/001-clip.mp4); not analyzed separately.");
    expect(source.match(/Preview derived from/g)).toHaveLength(1);
    expect(notes).toContain("**Derived previews (not analyzed separately):**");
    expect(notes).toContain("[002-clip-preview.jpg](./media/002-clip-preview.jpg)");
    expect(notes).not.toContain("[003-orphan-preview.jpg](./media/003-orphan-preview.jpg)");
    expect(notes.match(/### Asset /g)).toHaveLength(1);

    const exported = JSON.parse(readFileSync(join(targetDir, result.manifestPath), "utf8"));
    const mediaRecords = exported.coverage.byPost.find((post: { shortcode: string }) => post.shortcode === "POST_B").mediaRecords;
    expect(mediaRecords.find((media: { path: string }) => media.path.endsWith("/002-clip-preview.jpg")).analysis)
      .toEqual([{ id: "POST_B", status: "ok", analysisBasis: "source-video" }]);
    expect(mediaRecords.find((media: { path: string }) => media.path.endsWith("/003-orphan-preview.jpg")).analysis)
      .toEqual([]);
  });

  it("keeps carousel coverage at the media-record level", async () => {
    const { root, targetDir } = fixture();
    const manifestPath = join(root, "data/acme-unique/manifest.json");
    const unique = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (let index = 2; index <= 10; index++) {
      const name = `slide-${index}.jpg`;
      writeFileSync(join(root, "data/acme-unique", name), `slide ${index}`);
      unique.files.push({ shortcode: "POST_A", kind: "image", dest: `data/acme-unique/${name}` });
    }
    writeFileSync(manifestPath, JSON.stringify(unique));

    const result = await exportTrinket({ root, handle: "acme", targetDir }, new FixtureSink());
    const manifest = JSON.parse(readFileSync(join(targetDir, result.manifestPath), "utf8"));
    const carousel = manifest.coverage.byPost.find((post: { shortcode: string }) => post.shortcode === "POST_A");
    expect(carousel.mediaRecords).toHaveLength(10);
    expect(carousel.mediaRecords.filter((media: { analysis: unknown[] }) => media.analysis.length > 0)).toHaveLength(1);
    expect(carousel).not.toHaveProperty("status", "complete");
  });

  it("pages 825 posts and accepts a manifest beyond the former media cap", async () => {
    const { root, targetDir } = fixture();
    const posts = Array.from({ length: 825 }, (_, index) => ({
      shortcode: `P${String(index).padStart(4, "0")}`,
      type: "carousel",
      caption: `Post ${index}`,
      timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    writeFileSync(join(root, "data/profiles/acme-profile.json"), JSON.stringify({ username: "acme", posts, reels: [] }));
    writeFileSync(join(root, "data/analysis/acme/analysis.json"), JSON.stringify({ username: "acme", items: [] }));
    const manifestPath = join(root, "data/acme-unique/manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ username: "acme", files: [], stills: [] }));

    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);
    expect(result).toMatchObject({ postCount: 825, assetCount: 0 });
    const docs = flattened(sink);
    expect(docs.filter((document) => document.path.includes("/gallery/"))).toHaveLength(35);
    const first = docs.find((document) => document.path.endsWith("/gallery/index"))?.content ?? "";
    const last = docs.find((document) => document.path.endsWith("/gallery/page-35"))?.content ?? "";
    expect(first).toContain("](../posts/P0824/source.md)");
    expect(first).toContain("[Next](./page-2.md)");
    expect(last).toContain("[Previous](./page-34.md)");
    expect(last).toContain("](../posts/P0000/source.md)");
    expect(last).not.toContain("[Next]");
    const home = docs.find((document) => document.path === `${result.dir}/index`)?.content ?? "";
    expect(home).toContain("](./posts/P0824/source.md)");

    const files = Array.from({ length: 5001 }, (_, index) => ({
      shortcode: posts[index % posts.length]!.shortcode,
      kind: "image",
      dest: index === 5000 ? "data/acme-unique/missing.jpg" : "data/acme-unique/photo.jpg",
    }));
    writeFileSync(manifestPath, JSON.stringify({ username: "acme", files, stills: [] }));
    await expect(exportTrinket({ root, handle: "acme", targetDir }, new FixtureSink()))
      .rejects.toThrow("unique media missing");
  });

  it("uses cached analyses with recorded skipped status as topic evidence", async () => {
    const { root, targetDir } = fixture();
    const path = join(root, "data/analysis/acme/analysis.json");
    const analysis = JSON.parse(readFileSync(path, "utf8"));
    analysis.items[0].status = "skipped";
    writeFileSync(path, JSON.stringify(analysis));
    const sink = new FixtureSink();
    const result = await exportTrinket({ root, handle: "acme", targetDir }, sink);
    expect(result.topicCount).toBe(3);
    const doc = flattened(sink).find((entry) => entry.path.endsWith("/posts/POST_A/analysis"))?.content ?? "";
    expect(doc).toContain("Asset 1 — skipped");
    expect(doc).toContain("**Style Tags**");
  });

  it("rejects unsafe inputs and targets inside the repository before exporting", async () => {
    const { root, targetDir } = fixture();
    await expect(exportTrinket({ root, handle: "../acme", targetDir }, new FixtureSink()))
      .rejects.toThrow("handle must match");
    mkdirSync(join(root, ".ok"), { recursive: true });
    await expect(exportTrinket({ root, handle: "acme", targetDir: root }, new FixtureSink()))
      .rejects.toThrow("outside and disjoint");

    const profilePath = join(root, "data/profiles/acme-profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.posts[0].shortcode = "../escape";
    writeFileSync(profilePath, JSON.stringify(profile));
    await expect(exportTrinket({ root, handle: "acme", targetDir }, new FixtureSink()))
      .rejects.toThrow("shortcode");
  });

  it("fails on missing source artifacts or referenced media", async () => {
    const { root, targetDir } = fixture();
    rmSync(join(root, "data/analysis/acme/analysis.json"));
    await expect(exportTrinket({ root, handle: "acme", targetDir }, new FixtureSink()))
      .rejects.toThrow("analysis JSON missing");

    const next = fixture();
    rmSync(join(next.root, "data/acme-unique/photo.jpg"));
    await expect(exportTrinket({ ...next, handle: "acme" }, new FixtureSink()))
      .rejects.toThrow("unique media missing");
  });

  it("detects a sink that reports success after writing only part of the batch", async () => {
    const { root, targetDir } = fixture();
    const partial = new FixtureSink(true);
    await expect(exportTrinket({ root, handle: "acme", targetDir }, partial))
      .rejects.toThrow("incomplete document batch");
    expect(partial.audits).toHaveLength(0);
    const dir = partial.writes[0]?.[0]?.path.split("/").slice(0, 3).join("/");
    expect(existsSync(join(targetDir, dir!, "manifest.json"))).toBe(true);
    expect(existsSync(join(targetDir, dir!, "complete.json"))).toBe(false);
    const recovered = await exportTrinket({ root, handle: "acme", targetDir }, new FixtureSink());
    expect(recovered.changed).toBe(true);
    expect(existsSync(join(targetDir, dir!, "complete.json"))).toBe(true);
  });
});
