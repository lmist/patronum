import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, closeSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { KnowledgeDocument, KnowledgeSink } from "./sink.js";
import { layout } from "../paths.js";

const EXPORTER_VERSION = "1";
const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_NAME_RE = /^[A-Za-z0-9._-]+$/;
const MEDIA_EXT_RE = /\.(?:avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)$/i;
const MAX_POSTS = 2500;
const MAX_MEDIA = 25000;
const MAX_JSON_BYTES = 128 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

type ProfileItem = JsonObject & {
  shortcode?: unknown;
  caption?: unknown;
  permalink?: unknown;
  timestamp?: unknown;
  type?: unknown;
};

type Profile = JsonObject & {
  username?: unknown;
  posts?: unknown;
  reels?: unknown;
};

type AnalysisItem = JsonObject & {
  shortcode?: unknown;
  status?: unknown;
  analysis?: unknown;
};

type AnalysisFile = JsonObject & {
  username?: unknown;
  items?: unknown;
};

type UniqueEntry = JsonObject & {
  shortcode?: unknown;
  dest?: unknown;
  kind?: unknown;
  width?: unknown;
  height?: unknown;
  duration_s?: unknown;
};

type UniqueManifest = JsonObject & {
  username?: unknown;
  files?: unknown;
  stills?: unknown;
};

type InputFile<T> = {
  value: T;
  raw: Buffer;
};

type Post = {
  shortcode: string;
  item: ProfileItem;
  collection: "post" | "reel";
  analyses: AnalysisItem[];
  media: Media[];
};

type Media = {
  entry: UniqueEntry;
  shortcode: string;
  source: string;
  outputName: string;
  sha256: string;
  bytes: number;
};

type TopicKind = "style" | "mood" | "subject";

type Topic = {
  kind: TopicKind;
  label: string;
  slug: string;
  shortcodes: string[];
};

type InventoryEntry = {
  path: string;
  sha256: string;
  bytes: number;
  kind: "media" | "source-json";
};

type SnapshotManifest = {
  schemaVersion: 1;
  exporterVersion: string;
  handle: string;
  contentHash: string;
  inventoryScope: string;
  inventory: InventoryEntry[];
  coverage: {
    posts: number;
    analyses: number;
    media: number;
    topics: number;
    analysisStatuses: Record<string, number>;
    byPost: Array<{
      shortcode: string;
      collection: "post" | "reel";
      analysisStatuses: string[];
      media: number;
      topics: number;
      mediaRecords: Array<{
        path: string;
        kind: "image" | "video";
        sha256: string;
        analysis: Array<{ id: string | null; status: string; analysisBasis?: "source-video" }>;
      }>;
    }>;
  };
};

export type TrinketExportOptions = {
  root: string;
  handle: string;
  targetDir: string;
};

export type TrinketExportResult = {
  ok: true;
  handle: string;
  hash: string;
  dir: string;
  indexPath: string;
  manifestPath: string;
  docs: string[];
  assets: number;
  postCount: number;
  assetCount: number;
  topicCount: number;
  changed: boolean;
};

export type TrinketSink = KnowledgeSink & {
  prepareFolders?: (paths: string[]) => Promise<void>;
};

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function requiredDirectory(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} missing: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return realpathSync(path);
}

function assertNoSymlinkComponents(base: string, target: string, label: string): void {
  if (!inside(base, target)) throw new Error(`${label} is outside ${base}: ${target}`);
  let current = base;
  for (const part of relative(base, target).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} contains a symlink: ${current}`);
    }
  }
}

function readJson<T extends JsonObject>(path: string, label: string): InputFile<T> {
  let raw: Buffer;
  try {
    if (statSync(path).size > MAX_JSON_BYTES) throw new Error(`exceeds ${MAX_JSON_BYTES} bytes`);
    raw = readFileSync(path);
  } catch (error) {
    throw new Error(`${label} missing: ${path}: ${(error as Error).message}`);
  }
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    return { value: value as T, raw };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}: ${(error as Error).message}`);
  }
}

function readAnalysisInput(root: string, handle: string): InputFile<AnalysisFile> {
  const aggregate = join(root, layout.analysisJson(handle));
  if (existsSync(aggregate)) return readJson<AnalysisFile>(aggregate, "analysis JSON");
  const directory = join(root, layout.analysisItemsDir(handle));
  assertNoSymlinkComponents(root, directory, "analysis checkpoints");
  if (!existsSync(directory)) return readJson<AnalysisFile>(aggregate, "analysis JSON");
  const names = readdirSync(directory).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).sort();
  if (!names.length) throw new Error("No saved analysis records are available to export");
  if (names.length > 25_000) throw new Error("Too many saved analysis checkpoints");
  let bytes = 0;
  const ids = new Set<string>();
  const items = names.map(name => {
    const path = join(directory, name);
    assertNoSymlinkComponents(root, path, "analysis checkpoint");
    const size = statSync(path).size;
    bytes += size;
    if (size > 2 * 1024 * 1024 || bytes > MAX_JSON_BYTES) throw new Error("Saved analysis checkpoints exceed export size limits");
    const item = readJson<JsonObject>(path, "analysis checkpoint").value;
    if (typeof item.id !== "string" || !item.id || typeof item.shortcode !== "string" || !SHORTCODE_RE.test(item.shortcode) || typeof item.status !== "string") {
      throw new Error(`Invalid saved analysis checkpoint: ${name}`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate saved analysis ID: ${item.id}`);
    ids.add(item.id);
    return item;
  });
  const value: AnalysisFile = {
    username: handle, source: "item-checkpoints", complete: false,
    total: items.length, ok: items.filter(item => item.status === "ok").length,
    skipped: items.filter(item => item.status === "skipped").length,
    failed: items.filter(item => !["ok", "skipped"].includes(String(item.status))).length,
    items,
  };
  return { value, raw: Buffer.from(JSON.stringify(value, null, 2) + "\n") };
}

function objectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    return item as JsonObject;
  });
}

function safeShortcode(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHORTCODE_RE.test(value)) {
    throw new Error(`${label} must match [A-Za-z0-9_-]{1,128}`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function sameInode(left: string, right: string): boolean {
  const a = statSync(left);
  const b = statSync(right);
  return a.dev === b.dev && a.ino === b.ino;
}

function markdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([`*_[\]<>#])/g, "\\$1");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function codeSpan(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

function fenced(language: string, value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function dateOf(item: ProfileItem): string {
  const timestamp = stringValue(item.timestamp);
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "unknown";
}

function typeOf(post: Post): string {
  const recorded = stringValue(post.item.type).trim();
  if (recorded) return recorded;
  const kinds = [...new Set(post.media.map((media) => stringValue(media.entry.kind).trim()).filter(Boolean))];
  return kinds.join("+") || post.collection;
}

function topicSlug(label: string): string {
  const base = label.normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "topic";
  return `${base}-${sha256(label).slice(0, 8)}`;
}

function mediaKind(media: Media): "image" | "video" {
  return /\.(?:m4v|mov|mp4|webm)$/i.test(media.outputName) ? "video" : "image";
}

function mediaDetails(media: Media): string | null {
  const { width, height, duration_s: duration } = media.entry;
  const details: string[] = [];
  if (typeof width === "number" && typeof height === "number" &&
      Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0) {
    let a = width;
    let b = height;
    while (b !== 0) [a, b] = [b, a % b];
    details.push(`Dimensions: ${width} × ${height} px (${width / a}:${height / a})`);
  }
  if (mediaKind(media) === "video" && typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    details.push(`Duration: ${duration} s`);
  }
  return details.length ? details.join(" · ") : null;
}

function assertSafeInventoryPath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\\")) throw new Error(`unsafe inventory path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe inventory path: ${path}`);
  }
}

function collectPosts(profile: Profile): Post[] {
  const seen = new Map<string, Post>();
  const add = (raw: unknown, collection: "post" | "reel") => {
    for (const [index, item] of objectArray(raw, `profile ${collection}s`).entries()) {
      const shortcode = safeShortcode(item.shortcode, `profile ${collection}s[${index}].shortcode`);
      if (seen.has(shortcode)) continue;
      seen.set(shortcode, { shortcode, item: item as ProfileItem, collection, analyses: [], media: [] });
      if (seen.size > MAX_POSTS) throw new Error(`profile exceeds ${MAX_POSTS} posts`);
    }
  };
  add(profile.posts, "post");
  add(profile.reels, "reel");
  return [...seen.values()].sort((a, b) =>
    (Date.parse(stringValue(b.item.timestamp)) || 0) - (Date.parse(stringValue(a.item.timestamp)) || 0) || a.shortcode.localeCompare(b.shortcode));
}

function postTitle(post: Post): string {
  const captionLine=stringValue(post.item.caption).split(/\r?\n/).map(line=>line.trim()).find(Boolean);
  const title=captionLine || stringValue(post.media[0]?.entry.title).trim() || post.shortcode;
  return title.length>100 ? title.slice(0,97)+"…" : title;
}

function attachAnalyses(posts: Post[], analysis: AnalysisFile): AnalysisItem[] {
  const byPost = new Map(posts.map((post) => [post.shortcode, post]));
  const items = objectArray(analysis.items, "analysis items") as AnalysisItem[];
  for (const [index, item] of items.entries()) {
    const shortcode = safeShortcode(item.shortcode, `analysis items[${index}].shortcode`);
    if (typeof item.status !== "string" || item.status.length === 0) {
      throw new Error(`analysis items[${index}].status must be a nonempty string`);
    }
    const post = byPost.get(shortcode);
    if (!post) throw new Error(`analysis shortcode is absent from profile: ${shortcode}`);
    post.analyses.push(item);
  }
  return items;
}

function collectMedia(root: string, handle: string, posts: Post[], manifest: UniqueManifest): Media[] {
  const uniqueRoot = resolve(root, layout.uniqueDir(handle));
  requiredDirectory(uniqueRoot, "unique media directory");
  assertNoSymlinkComponents(root, uniqueRoot, "unique media directory");
  const realUniqueRoot = realpathSync(uniqueRoot);
  const byPost = new Map(posts.map((post) => [post.shortcode, post]));
  const groups: Array<[string, unknown]> = [["files", manifest.files], ["stills", manifest.stills]];
  const all: Media[] = [];
  const outputNames = new Map<string, Set<string>>();
  const sourceHashes = new Map<string, string>();

  for (const [group, raw] of groups) {
    for (const [index, value] of objectArray(raw, `unique manifest ${group}`).entries()) {
      const entry = value as UniqueEntry;
      if (all.length >= MAX_MEDIA) throw new Error(`unique manifest exceeds ${MAX_MEDIA} media files`);
      const shortcode = safeShortcode(entry.shortcode, `unique manifest ${group}[${index}].shortcode`);
      const post = byPost.get(shortcode);
      if (!post) throw new Error(`unique media shortcode is absent from profile: ${shortcode}`);
      if (typeof entry.dest !== "string" || !entry.dest || isAbsolute(entry.dest) || entry.dest.includes("\\")) {
        throw new Error(`unsafe unique media path: ${String(entry.dest ?? "")}`);
      }
      const source = resolve(root, entry.dest);
      if (!inside(uniqueRoot, source)) throw new Error(`unique media path escapes its directory: ${entry.dest}`);
      if (!MEDIA_EXT_RE.test(source)) throw new Error(`unsupported unique media path: ${entry.dest}`);
      if (!existsSync(source)) throw new Error(`unique media missing: ${source}`);
      const info = lstatSync(source);
      if (info.isSymbolicLink()) throw new Error(`unique media symlink is not allowed: ${source}`);
      if (!info.isFile()) throw new Error(`unique media is not a regular file: ${source}`);
      if (!inside(realUniqueRoot, realpathSync(source))) {
        throw new Error(`unique media resolves outside its directory: ${entry.dest}`);
      }
      const name = basename(source);
      if (!MEDIA_NAME_RE.test(name)) throw new Error(`unsafe unique media filename: ${name}`);
      const numbered = `${String(post.media.length + 1).padStart(3, "0")}-${name}`;
      const names = outputNames.get(shortcode) ?? new Set<string>();
      if (names.has(numbered)) throw new Error(`duplicate unique media output name for ${shortcode}: ${numbered}`);
      names.add(numbered);
      outputNames.set(shortcode, names);
      const media: Media = {
        entry,
        shortcode,
        source,
        outputName: numbered,
        sha256: sourceHashes.get(source) ?? hashFile(source),
        bytes: info.size,
      };
      sourceHashes.set(source, media.sha256);
      post.media.push(media);
      all.push(media);
    }
  }
  return all;
}

function collectTopics(posts: Post[]): Topic[] {
  const fields: Array<[TopicKind, string]> = [
    ["style", "style_tags"],
    ["mood", "mood"],
    ["subject", "subjects"],
  ];
  const topics = new Map<string, Topic>();
  for (const post of posts) {
    for (const item of post.analyses) {
      if (!(["ok", "skipped"].includes(String(item.status))) || !item.analysis || typeof item.analysis !== "object" || Array.isArray(item.analysis)) continue;
      const analysis = item.analysis as JsonObject;
      for (const [kind, field] of fields) {
        const values = analysis[field];
        if (values === undefined || values === null) continue;
        if (!Array.isArray(values)) throw new Error(`successful analysis ${post.shortcode}.${field} must be an array`);
        for (const [index, value] of values.entries()) {
          if (typeof value !== "string" || value.trim().length === 0) {
            throw new Error(`successful analysis ${post.shortcode}.${field}[${index}] must be a nonempty string`);
          }
          const label = value.trim();
          const key = `${kind}\0${label.toLocaleLowerCase()}`;
          const topic = topics.get(key) ?? { kind, label, slug: topicSlug(label), shortcodes: [] };
          if (!topic.shortcodes.includes(post.shortcode)) topic.shortcodes.push(post.shortcode);
          topics.set(key, topic);
        }
      }
    }
  }
  return [...topics.values()]
    .map((topic) => ({ ...topic, shortcodes: topic.shortcodes.sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

function analysisMedia(item: AnalysisItem, post: Post, root: string): Media | undefined {
  const localPath = item.localPath;
  return (typeof localPath === "string" ? post.media.find((entry) => entry.source === resolve(root, localPath)) : undefined)
    ?? post.media.find((entry) => analysisMatchesMedia(root, item, entry));
}

function portableAnalysis(item: AnalysisItem, media?: Media): JsonObject {
  const { localPath, ...record } = item;
  return media ? { ...record, media: `./media/${media.outputName}` } : record;
}

function analysisMatchesMedia(root: string, item: AnalysisItem, media: Media): boolean {
  const localPath = stringValue(item.localPath);
  const sameKind = !stringValue(item.mediaType) || stringValue(item.mediaType) === mediaKind(media);
  if (localPath) {
    const sourcePath = resolve(root, localPath);
    if (sourcePath === media.source) return true;
    if (sameKind && typeof media.entry.src === "string" && sourcePath === resolve(root, media.entry.src)) return true;
  }
  if (!sameKind) return false;
  for (const key of ["sourceSha256", "sha256"]) {
    const value = item[key];
    if (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) && value.toLowerCase() === media.sha256) return true;
  }
  return false;
}

function sourceVideoForPreview(post: Post, media: Media, root: string): Media | undefined {
  if (mediaKind(media) !== "image" || media.entry.kind !== "still" || typeof media.entry.src !== "string") return;
  const source = resolve(root, media.entry.src);
  return post.media.find((candidate) => mediaKind(candidate) === "video" && candidate.source === source);
}

function mediaAnalysisReferences(post: Post, media: Media, root: string): Array<{ id: string | null; status: string; analysisBasis?: "source-video" }> {
  const direct = post.analyses.filter((record) => analysisMatchesMedia(root, record, media));
  if (direct.length) return direct.map((record) => ({ id: typeof record.id === "string" ? record.id : null, status: String(record.status) }));
  const sourceVideo = sourceVideoForPreview(post, media, root);
  return sourceVideo ? post.analyses
    .filter((record) => analysisMatchesMedia(root, record, sourceVideo))
    .map((record) => ({ id: typeof record.id === "string" ? record.id : null, status: String(record.status), analysisBasis: "source-video" })) : [];
}

function analysisSections(post: Post, root: string): string {
  if (!post.analyses.length) return "No analysis record was present for this post.";
  return post.analyses.map((item, index) => {
    const media = analysisMedia(item, post, root);
    const record = portableAnalysis(item, media);
    const details = item.analysis && typeof item.analysis === "object" && !Array.isArray(item.analysis)
      ? item.analysis as JsonObject : null;
    const lines = [`### Asset ${index + 1} — ${markdownText(String(item.status))}`];
    if (item.analysisMethod === "sampled-video-frames") {
      const count = Number.isSafeInteger(item.frameCount) && Number(item.frameCount) > 0 ? ` (${item.frameCount} frames)` : "";
      lines.push(`\n**Analysis input:** sampled video frames${count}.`);
      lines.push(`\n${markdownText(stringValue(item.limitations) || "Motion between frames, cuts, pacing, and audio cannot be verified from these samples.")}`);
    }
    if (typeof record.media === "string") lines.push(`\n[Local media](${record.media})`);
    if (media) {
      const facts = mediaDetails(media);
      if (facts) lines.push(`\n${facts}`);
      const previews = post.media.filter((candidate) => sourceVideoForPreview(post, candidate, root) === media &&
        !post.analyses.some((record) => analysisMatchesMedia(root, record, candidate)));
      if (previews.length) {
        lines.push(`\n**Derived previews (not analyzed separately):**\n`);
        lines.push(previews.map((preview) => `- [${markdownText(preview.outputName)}](./media/${preview.outputName})`).join("\n"));
      }
    }
    if (details) {
      if (typeof details.summary === "string") lines.push(`\n${markdownText(details.summary)}`);
      for (const [key, value] of Object.entries(details)) {
        if (key === "summary") continue;
        const title = key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
        if (Array.isArray(value)) {
          lines.push(`\n**${title}**\n`);
          lines.push(value.length ? value.map((entry) => `- ${markdownText(typeof entry === "string" ? entry : JSON.stringify(entry))}`).join("\n") : "- None recorded");
        } else if (value !== null && typeof value === "object") {
          lines.push(`\n**${title}**\n\n${fenced("json", JSON.stringify(value, null, 2))}`);
        } else {
          lines.push(`\n**${title}:** ${markdownText(String(value))}`);
        }
      }
    }
    lines.push(`\n**Recorded status:** ${codeSpan(String(item.status))}`);
    lines.push(`\n${fenced("json", JSON.stringify(record, null, 2))}`);
    return lines.join("\n");
  }).join("\n\n");
}

function buildDocuments(base: string, handle: string, posts: Post[], topics: Topic[], root: string): KnowledgeDocument[] {
  const documents: KnowledgeDocument[] = [];
  const topicCountByPost = new Map<string, number>();
  for (const topic of topics) {
    for (const shortcode of topic.shortcodes) topicCountByPost.set(shortcode, (topicCountByPost.get(shortcode) ?? 0) + 1);
  }

  for (const post of posts) {
    const postBase = `${base}/posts/${post.shortcode}`;
    const caption = stringValue(post.item.caption);
    const sourceUrl = stringValue(post.item.permalink);
    const altEvidence = post.analyses.find((item) => (item.status === "ok" || item.status === "skipped") && typeof (item.analysis as JsonObject | undefined)?.summary === "string")?.analysis as JsonObject | undefined;
    const altBase = (stringValue(altEvidence?.summary).trim() || caption.trim() || `${typeOf(post)} from @${handle}`).replace(/\s+/g," ");
    const mediaLines = post.media.length
      ? post.media.map((media, index) => {
        const visual = mediaKind(media) === "image"
          ? `![${markdownText(`${altBase.slice(0, 140)} — image ${index + 1}`)}](./media/${media.outputName})`
          : `<video src="./media/${media.outputName}" controls preload="none"></video>\n\n[${markdownText(media.outputName)}](./media/${media.outputName})`;
        const facts = mediaDetails(media);
        const sourceVideo = sourceVideoForPreview(post, media, root);
        const analyzedSource = sourceVideo && post.analyses.some((record) =>
          (record.status === "ok" || record.status === "skipped") && analysisMatchesMedia(root, record, sourceVideo));
        const previewNote = sourceVideo
          ? `Preview derived from [${analyzedSource ? "analyzed source video" : "source video"}](./media/${sourceVideo.outputName})${post.analyses.some((record) => analysisMatchesMedia(root, record, media)) ? "." : "; not analyzed separately."}`
          : null;
        return [visual, facts, previewNote].filter(Boolean).join("\n\n");
      }).join("\n\n")
      : "No local media was recorded for this post.";
    const source = `---\ntype: source\ntitle: ${yamlScalar(postTitle(post))}\nsource_url: ${yamlScalar(sourceUrl)}\nshortcode: ${yamlScalar(post.shortcode)}\n---\n# ${markdownText(postTitle(post))}\n\n[Collection](../../index.md) · [Design notes](./analysis.md)\n\n${markdownText(dateOf(post.item))} · ${markdownText(typeOf(post))}\n\n<details>\n<summary>Original caption</summary>\n\n${fenced("text", caption)}\n\n</details>\n\n${mediaLines}\n`;
    documents.push({ path: `${postBase}/source`, content: source, summary: `Export ${post.shortcode} source` });

    const statuses = post.analyses.length
      ? post.analyses.map((item) => `- ${codeSpan(String(item.status))}`).join("\n")
      : "- No analysis record";
    const analysis = `---\ntype: analysis\ntitle: ${yamlScalar(postTitle(post)+" — design notes")}\nshortcode: ${yamlScalar(post.shortcode)}\n---\n# ${markdownText(postTitle(post))} — design notes\n\nEvidence: [post source](./source.md). The [original analysis JSON](../../original/analysis.json) retains the exact records.\n\n## Recorded statuses\n\n${statuses}\n\n## Asset analysis\n\n${analysisSections(post, root)}\n`;
    documents.push({ path: `${postBase}/analysis`, content: analysis, summary: `Export ${post.shortcode} analysis` });
  }

  for (const topic of topics) {
    const path = `${base}/topics/${topic.kind}/${topic.slug}`;
    const evidence = topic.shortcodes.map((shortcode) =>
      `- [${markdownText(shortcode)} analysis](../../posts/${shortcode}/analysis.md) · [source](../../posts/${shortcode}/source.md)`,
    ).join("\n");
    const body = `---\ntype: topic\ntopic_kind: ${topic.kind}\nlabel: ${yamlScalar(topic.label)}\n---\n# ${markdownText(topic.label)}\n\n## Evidence\n\n${evidence}\n`;
    documents.push({ path, content: body, summary: `Export ${topic.kind} topic ${topic.label}` });
  }

  const byDate = new Map<string, Post[]>();
  const byType = new Map<string, Post[]>();
  for (const post of posts) {
    const date = dateOf(post.item);
    const type = typeOf(post);
    byDate.set(date, [...(byDate.get(date) ?? []), post]);
    byType.set(type, [...(byType.get(type) ?? []), post]);
  }
  const dateRows = [...byDate.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, entries]) =>
    `## ${markdownText(date)}\n\n${entries.map((post) => `- [${post.shortcode} source](../posts/${post.shortcode}/source.md) · [analysis](../posts/${post.shortcode}/analysis.md)`).join("\n")}`,
  ).join("\n\n") || "No posts.";
  documents.push({ path: `${base}/dates/index`, content: `# Date index\n\n${dateRows}\n`, summary: `Export @${handle} date index` });

  const typeRows = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, entries]) =>
    `## ${markdownText(type)}\n\n${entries.map((post) => `- [${post.shortcode} source](../posts/${post.shortcode}/source.md) · [analysis](../posts/${post.shortcode}/analysis.md)`).join("\n")}`,
  ).join("\n\n") || "No posts.";
  documents.push({ path: `${base}/types/index`, content: `# Type index\n\n${typeRows}\n`, summary: `Export @${handle} type index` });

  const topicRows = (["style", "mood", "subject"] as TopicKind[]).map((kind) => {
    const entries = topics.filter((topic) => topic.kind === kind);
    return `## ${kind[0].toUpperCase()}${kind.slice(1)}\n\n${entries.length ? entries.map((topic) => `- [${markdownText(topic.label)}](./${kind}/${topic.slug}.md) — ${topic.shortcodes.length} post(s)`).join("\n") : "No topics."}`;
  }).join("\n\n");
  documents.push({ path: `${base}/topics/index`, content: `# Topic index\n\n${topicRows}\n`, summary: `Export @${handle} topic index` });

  const recentPosts = [...posts].sort((a, b) =>
    dateOf(b.item).localeCompare(dateOf(a.item)) || a.shortcode.localeCompare(b.shortcode),
  );
  const postBlock = (post: Post, postsPath: string) => {
    const title = postTitle(post);
    const cover = post.media.find((media) => mediaKind(media) === "image");
    const visual = cover
      ? `![${markdownText(`${title} cover`)}](${postsPath}/${post.shortcode}/media/${cover.outputName})\n\n`
      : post.media.length ? `[Open local video](${postsPath}/${post.shortcode}/media/${post.media[0]!.outputName})\n\n` : "";
    return `### [${markdownText(title)}](${postsPath}/${post.shortcode}/source.md)\n\n${visual}${dateOf(post.item)} · ${markdownText(typeOf(post))} · ${post.media.length} media · ${topicCountByPost.get(post.shortcode) ?? 0} topics · [Analysis](${postsPath}/${post.shortcode}/analysis.md)`;
  };
  const postBlocks = recentPosts.map((post) => postBlock(post, "../posts"));
  const galleryPages=Math.max(1,Math.ceil(postBlocks.length/24));
  for(let page=0;page<galleryPages;page++){
    const name=page===0?"index":`page-${page+1}`;
    const navigation=[page>0?`[Previous](./${page===1?"index":`page-${page}`}.md)`:"",`[Collection home](../index.md)`,page+1<galleryPages?`[Next](./page-${page+2}.md)`:""].filter(Boolean).join(" · ");
    const body=postBlocks.slice(page*24,(page+1)*24).join("\n\n")||"No posts.";
    documents.push({path:`${base}/gallery/${name}`,content:`${page===0?"":`---\ntype: Gallery\ntitle: Gallery ${page+1}\n---\n`}# Gallery · ${page+1} of ${galleryPages}\n\n${navigation}\n\n${body}\n\n${navigation}\n`,summary:`Add gallery page ${page+1}`});
  }
  const postRows=recentPosts.slice(0,12).map((post) => postBlock(post, "./posts")).join("\n\n")||"No posts.";
  const index = `# @${markdownText(handle)} trinket box\n\nOriginals and design notes, kept together.\n\n## Browse\n\n- [Open the gallery](./gallery/index.md)\n- [By date](./dates/index.md)\n- [By type](./types/index.md)\n- [By topic](./topics/index.md)\n\n## Recent references\n\n${postRows}\n\n[Browse every post in the gallery](./gallery/index.md)\n\n## Original records\n\n- [Profile JSON](./original/profile.json)\n- [Analysis JSON](./original/analysis.json)\n- [Unique manifest JSON](./original/unique-manifest.json)\n- [Machine manifest](./manifest.json)\n`;
  documents.push({ path: `${base}/index`, content: index, summary: `Export @${handle} snapshot index` });
  return documents.sort((a, b) => a.path.localeCompare(b.path));
}

function contentHash(profile: InputFile<Profile>, analysis: InputFile<AnalysisFile>, unique: InputFile<UniqueManifest>, media: Media[]): string {
  const hash = createHash("sha256");
  const add = (label: string, bytes: Buffer | string) => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    hash.update(`${label.length}:${label}:${value.length}:`);
    hash.update(value);
    hash.update("\n");
  };
  add("exporter", EXPORTER_VERSION);
  add("profile.json", profile.raw);
  add("analysis.json", analysis.raw);
  add("unique-manifest.json", unique.raw);
  for (const item of [...media].sort((a, b) => a.shortcode.localeCompare(b.shortcode) || a.outputName.localeCompare(b.outputName))) {
    add(`media/${item.shortcode}/${item.outputName}`, `${item.sha256}:${item.bytes}`);
  }
  return hash.digest("hex");
}

function writeOrVerify(path: string, bytes: Buffer | string): void {
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== expected.length || hashFile(path) !== sha256(expected)) {
      throw new Error(`existing snapshot file differs: ${path}`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, expected, { flag: "wx" });
}

function copyMedia(snapshotDir: string, media: Media): void {
  const dest = join(snapshotDir, "posts", media.shortcode, "media", media.outputName);
  assertNoSymlinkComponents(snapshotDir, dirname(dest), "snapshot media path");
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) copyFileSync(media.source, dest, constants.COPYFILE_EXCL);
  else if (lstatSync(dest).isSymbolicLink()) throw new Error(`snapshot media symlink is not allowed: ${dest}`);
  if (hashFile(dest) !== media.sha256 || sameInode(media.source, dest)) {
    throw new Error(`copied media verification failed: posts/${media.shortcode}/media/${media.outputName}`);
  }
}

function inventoryFor(media: Media[], originals: Array<{ path: string; raw: Buffer }>): InventoryEntry[] {
  const inventory: InventoryEntry[] = [];
  for (const item of media) {
    inventory.push({ path: `posts/${item.shortcode}/media/${item.outputName}`, sha256: item.sha256, bytes: item.bytes, kind: "media" });
  }
  for (const original of originals) {
    inventory.push({ path: original.path, sha256: sha256(original.raw), bytes: original.raw.length, kind: "source-json" });
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path));
}

function validateExisting(snapshotDir: string, expected: SnapshotManifest): boolean {
  const info = lstatSync(snapshotDir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`snapshot path is not a regular directory: ${snapshotDir}`);
  const manifestPath = join(snapshotDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  const existing = readJson<SnapshotManifest & JsonObject>(manifestPath, "snapshot manifest").value;
  if (existing.contentHash !== expected.contentHash || existing.handle !== expected.handle) {
    throw new Error(`existing snapshot identity does not match ${expected.contentHash}`);
  }
  if (!Array.isArray(existing.inventory)) throw new Error("existing snapshot manifest inventory is missing");
  const wanted = new Map(expected.inventory.map((entry) => [entry.path, entry]));
  for (const entry of existing.inventory as InventoryEntry[]) {
    if (!entry || typeof entry.path !== "string") throw new Error("existing snapshot inventory contains an invalid entry");
    assertSafeInventoryPath(entry.path);
    const expectedEntry = wanted.get(entry.path);
    if (!expectedEntry || entry.sha256 !== expectedEntry.sha256 || entry.bytes !== expectedEntry.bytes || entry.kind !== expectedEntry.kind) {
      throw new Error(`existing snapshot inventory differs: ${entry.path}`);
    }
    const path = join(snapshotDir, entry.path);
    if (!existsSync(path)) throw new Error(`existing snapshot is incomplete: ${entry.path}`);
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error(`existing snapshot has unsafe file: ${entry.path}`);
    if (file.size !== entry.bytes || hashFile(path) !== entry.sha256) {
      throw new Error(`existing immutable snapshot file changed: ${entry.path}`);
    }
    wanted.delete(entry.path);
  }
  if (wanted.size) throw new Error(`existing snapshot inventory is incomplete: ${[...wanted.keys()].join(", ")}`);
  const completionPath = join(snapshotDir, "complete.json");
  if (!existsSync(completionPath)) return false;
  const completion = readJson<JsonObject>(completionPath, "snapshot completion marker").value;
  if (completion.contentHash !== expected.contentHash || completion.audited !== true) {
    throw new Error(`existing snapshot completion marker differs: ${completionPath}`);
  }
  return true;
}

function resultFor(base: string, handle: string, hash: string, documents: KnowledgeDocument[], posts: Post[], media: Media[], topics: Topic[], changed: boolean): TrinketExportResult {
  return {
    ok: true,
    handle,
    hash,
    dir: base,
    indexPath: `${base}/index.md`,
    manifestPath: `${base}/manifest.json`,
    docs: documents.map((document) => `${document.path}.md`),
    assets: media.length,
    postCount: posts.length,
    assetCount: media.length,
    topicCount: topics.length,
    changed,
  };
}

export async function exportTrinket(
  options: TrinketExportOptions,
  sink: TrinketSink,
): Promise<TrinketExportResult> {
  const rootInput = resolve(options.root);
  const targetInput = resolve(options.targetDir);
  const handle = options.handle.trim().replace(/^@+/, "");
  if (!HANDLE_RE.test(handle)) throw new Error("handle must match [A-Za-z0-9._]{1,30}");
  const root = requiredDirectory(rootInput, "repository root");
  const target = requiredDirectory(targetInput, "target OpenKnowledge directory");
  requiredDirectory(join(target, ".ok"), "target OpenKnowledge initialization");
  if (inside(root, target) || inside(target, root)) {
    throw new Error("target OpenKnowledge directory must be outside and disjoint from the repository");
  }

  const profilePath = join(root, layout.profileJson(handle));
  const uniquePath = join(root, layout.uniqueManifest(handle));
  const profile = readJson<Profile>(profilePath, "profile JSON");
  const analysis = readAnalysisInput(root, handle);
  const unique = readJson<UniqueManifest>(uniquePath, "unique manifest JSON");
  if (profile.value.username !== handle) throw new Error(`profile username ${JSON.stringify(profile.value.username)} does not match ${handle}`);
  if (analysis.value.username !== handle) throw new Error(`analysis username ${JSON.stringify(analysis.value.username)} does not match ${handle}`);
  if (unique.value.username !== handle) throw new Error(`unique manifest username ${JSON.stringify(unique.value.username)} does not match ${handle}`);

  const posts = collectPosts(profile.value);
  const analysisItems = attachAnalyses(posts, analysis.value);
  const media = collectMedia(root, handle, posts, unique.value);
  const topics = collectTopics(posts);
  const hash = contentHash(profile, analysis, unique, media);
  const base = `exports/${handle}/${hash}`;
  const snapshotDir = join(target, ...base.split("/"));
  const documents = buildDocuments(base, handle, posts, topics, root);
  const originals = [
    { path: "original/profile.json", raw: profile.raw },
    { path: "original/analysis.json", raw: analysis.raw },
    { path: "original/unique-manifest.json", raw: unique.raw },
  ];
  const inventory = inventoryFor(media, originals);
  const statuses: Record<string, number> = {};
  for (const item of analysisItems) statuses[String(item.status)] = (statuses[String(item.status)] ?? 0) + 1;
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    exporterVersion: EXPORTER_VERSION,
    handle,
    contentHash: hash,
    inventoryScope: "Original JSON and copied media. Markdown is managed by OpenKnowledge.",
    inventory,
    coverage: {
      posts: posts.length,
      analyses: analysisItems.length,
      media: media.length,
      topics: topics.length,
      analysisStatuses: statuses,
      byPost: posts.map((post) => ({
        shortcode: post.shortcode,
        collection: post.collection,
        analysisStatuses: post.analyses.map((item) => String(item.status)),
        media: post.media.length,
        topics: topics.filter((topic) => topic.shortcodes.includes(post.shortcode)).length,
        mediaRecords: post.media.map((item) => ({
          path: `posts/${post.shortcode}/media/${item.outputName}`,
          kind: mediaKind(item),
          sha256: item.sha256,
          analysis: mediaAnalysisReferences(post, item, root),
        })),
      })),
    },
  };

  const handleDir = join(target, "exports", handle);
  assertNoSymlinkComponents(target, handleDir, "snapshot parent path");
  assertNoSymlinkComponents(target, snapshotDir, "snapshot path");
  mkdirSync(handleDir, { recursive: true });
  if (!existsSync(snapshotDir)) mkdirSync(snapshotDir);
  if (validateExisting(snapshotDir, manifest)) {
    return resultFor(base, handle, hash, documents, posts, media, topics, false);
  }
  for (const item of media) copyMedia(snapshotDir, item);
  for (const original of originals) writeOrVerify(join(snapshotDir, ...original.path.split("/")), original.raw);
  writeOrVerify(join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await sink.prepareFolders?.([...new Set(documents.map((document) => dirname(document.path)))].sort());
  await sink.writeDocuments(documents);
  await sink.audit(base);
  writeOrVerify(join(snapshotDir, "complete.json"), `${JSON.stringify({ contentHash: hash, audited: true })}\n`);
  return resultFor(base, handle, hash, documents, posts, media, topics, true);
}
