/**
 * Which files the dashboard may read.
 *
 * Keep every path inside the repository and inside the folders that hold
 * collection output, then read or summarise the file.
 */
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { redact } from "./redact";
import { HOME } from "./settings";

export function guardPath(p: string): string | null {
  const abs = resolve(HOME, p);
  const rel = relative(HOME, abs);
  if (rel.startsWith("..") || rel === "" ) return null;
  return abs;
}

export async function tailFile(path: string, maxBytes = 64 * 1024): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  const size = info.size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = Bun.file(path);
  const buf = await fd.slice(start).arrayBuffer();
  const slice = new Uint8Array(buf);
  const text = new TextDecoder().decode(slice);
  const lines = text.split(/\r?\n/);
  if (start > 0) lines.shift();
  return lines.filter((l) => l.length > 0).map(redact);
}

export async function summarizeArtifact(abs: string) {
  const info = await stat(abs).catch(() => null);
  if (!info) return { exists: false };
  if (info.isDirectory()) {
    const entries = await readdir(abs).catch(() => [] as string[]);
    return { exists: true, kind: "dir", count: entries.length, sample: entries.slice(0, 20) };
  }
  const kind = /\.json$/.test(abs) ? "json" : /\.(md|txt|log)$/.test(abs) ? "text" : "binary";
  if (kind === "json" && info.size < 512 * 1024) {
    const raw = await readFile(abs, "utf8").catch(() => "");
    try {
      const parsed = JSON.parse(raw);
      const summary: Record<string, unknown> = { size: info.size };
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed)) summary.arrayLength = parsed.length;
        else summary.keys = Object.keys(parsed).slice(0, 40);
        if (parsed.counts) summary.counts = parsed.counts;
        if (parsed.items && Array.isArray(parsed.items)) summary.itemsLength = parsed.items.length;
      }
      return { exists: true, kind, ...summary };
    } catch {
      return { exists: true, kind: "text", size: info.size };
    }
  }
  if (kind === "text") {
    const lines = await tailFile(abs, 8 * 1024);
    return { exists: true, kind, size: info.size, tail: lines.slice(-40) };
  }
  return { exists: true, kind, size: info.size };
}

export function allowedArtifact(raw: string): string | null {
  const abs = guardPath(raw);
  if (!abs) return null;
  const rel = relative(HOME, abs);
  const allowed = (p: string) => /^(?:data\/(?:media|analysis|knowledge|profiles|dbos\/logs|captcha\/(?:captures|diagnostics))\/|data\/[^/]+-unique(?:\/|$)|knowledge\/clients\/)/.test(p);
  if (!allowed(rel)) return null;
  if (existsSync(abs)) {
    // Compare real path with real path: the home itself may be reached
    // through a symlink (/tmp on macOS, a mounted data volume).
    try { if (!allowed(relative(realpathSync(HOME), realpathSync(abs)))) return null; } catch { return null; }
  }
  return abs;
}
