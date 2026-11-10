// Structured JSON logging for igdash. stderr + on-disk file + in-memory ring.
// stdout stays the single boot URL.
// Never logs secret values (API keys, passwords, TOTP). Request bodies are
// summarized (keys + handle/workflowId) rather than dumped.

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { redact } from "./redact";
import { dirname } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogEvent = {
  ts: string;
  level: Level;
  msg: string;
  req?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  pid?: number;
  handle?: string;
  workflowId?: string;
  kind?: string;
  argv?: string[];
  err?: string;
  extra?: Record<string, unknown>;
};

const RING_MAX = 400;
const ring: LogEvent[] = [];
let minLevel: Level = (process.env.IGDASH_LOG_LEVEL as Level) || "info";
if (!(minLevel in ORDER)) minLevel = "info";

let filePath: string | null = process.env.IGDASH_LOG_FILE ?? null;
let lastError: LogEvent | null = null;
const startedAt = Date.now();

export function setLogFile(path: string | null) {
  filePath = path;
  if (path) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function setLogLevel(level: Level) {
  if (level in ORDER) minLevel = level;
}

function write(ev: LogEvent) {
  ev = JSON.parse(redact(JSON.stringify(ev)));
  if (ORDER[ev.level] < ORDER[minLevel]) return;
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  if (ev.level === "error") lastError = ev;
  const line = JSON.stringify(ev);
  try { process.stderr.write(line + "\n"); } catch {}
  if (filePath) {
    try { appendFileSync(filePath, line + "\n"); } catch {}
  }
}

function emit(level: Level, msg: string, extra?: Partial<LogEvent>) {
  const ev: LogEvent = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  write(ev);
}

export const log = {
  debug: (msg: string, extra?: Partial<LogEvent>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Partial<LogEvent>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Partial<LogEvent>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Partial<LogEvent>) => emit("error", msg, extra),
};

export function recentLogs(n = 80): LogEvent[] {
  const take = Math.max(1, Math.min(RING_MAX, n));
  return ring.slice(-take);
}

export function logHealth() {
  return {
    uptimeMs: Date.now() - startedAt,
    level: minLevel,
    file: filePath,
    ring: ring.length,
    lastError,
  };
}

export function newReqId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const QUIET_PATHS = new Set(["/api/now"]);

export function shouldLogRequest(path: string, status: number, method: string): boolean {
  if (status >= 400) return true;
  if (method !== "GET" && method !== "HEAD") return true;
  if (QUIET_PATHS.has(path) || path.startsWith("/api/launch/")) return false;
  if (!path.startsWith("/api/")) return false;
  return true;
}
