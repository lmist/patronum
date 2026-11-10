/**
 * Start background commands and keep track of them.
 *
 * Every job, login or mapping action the dashboard starts is a separate
 * process with its own log file. This file starts them, remembers the recent
 * ones, and reports whether each is still running.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { redact } from "./redact";
import { log } from "./log";
import { HOME, ROOT, LAUNCH_DIR, IGFLOW_CMD } from "./settings";
import { tailFile, allowedArtifact } from "./files";

export type Launch = {
  pid: number;
  kind: "run" | "resume" | "cancel" | "gc" | "preflight" | "warm-session" | "cold-login" | "recover-login" | "recognize-captcha" | "map-network";
  handle: string | null;
  workflowId: string | null;
  argv: string[];
  logPath: string;
  startedAt: number;
  exitCode: number | null;
  exitAt: number | null;
  status: string;         // one-line terse state for the bar
  result?: Record<string, unknown>;
  profileDir?: string;
  cacheDir?: string;
  headless?: boolean;
  reuseGrid?: boolean;
  detailWorkers?: number;
  sourcePid?: number;
  cwd?: string;
  statePath?: string;
  tail: string[];         // last few log lines when process died fast
};

export const launches = new Map<number, Launch>();

export const LAUNCHES_MAX = 32;

export function pruneLaunches() {
  if (launches.size <= LAUNCHES_MAX) return;
  const arr = Array.from(launches.values()).filter(l=>l.exitCode!=null).sort((a, b) => a.startedAt - b.startedAt);
  const drop = Math.min(arr.length, launches.size - LAUNCHES_MAX);
  for (let i = 0; i < drop; i++) launches.delete(arr[i].pid);
}

export function classifyExit(code: number | null): string {
  if (code === null) return "spawned";
  if (code === 0) return "ok";
  if (code === 2) return "usage";
  if (code === 3) return "lock held";
  if (code === 4) return "db error";
  if (code === 5) return "exit 5 precondition";
  return `exit ${code}`;
}

export function passthroughIgflowEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith("IGFLOW_") || k === "QWEN_API_KEY" || k === "DASHSCOPE_API_KEY" ||
        k === "IG_USER" || k === "IG_PASS" || k === "IG_TOTP_SECRET" ||
        k === "HEADLESS" || k === "PATH" || k === "HOME") {
      out[k] = v;
    }
  }
  // Tell every child where data lives, so it uses the same tree as the dashboard.
  out["PATRONUM_HOME"] = HOME;
  // When code and data were relocated together (IGDASH_ROOT), the job engine follows.
  if (process.env.IGDASH_ROOT) out["IGFLOW_REPO_ROOT"] = ROOT;
  return out;
}

export function tsStamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "-" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

export function ensureLaunchDir() {
  if (!existsSync(LAUNCH_DIR)) mkdirSync(LAUNCH_DIR, { recursive: true });
}

export async function readTail(path: string, maxLines = 4): Promise<string[]> {
  const lines = await tailFile(path, 8 * 1024);
  return lines.slice(-maxLines);
}

export function refreshLaunches() {
  if (!existsSync(LAUNCH_DIR)) return;
  for (const name of readdirSync(LAUNCH_DIR).filter(name => name.endsWith(".json"))) {
    try {
      const launch = JSON.parse(readFileSync(join(LAUNCH_DIR, name), "utf8")) as Launch;
      if (!launch.pid || !launch.logPath) continue;
      if (launch.exitCode == null) {
        try { process.kill(launch.pid, 0); } catch { launch.status = "interrupted"; launch.exitCode = -1; }
      }
      launches.set(launch.pid, launch);
    } catch {}
  }
  pruneLaunches();
}

export function workflowLaunch(id: string): Launch | undefined {
  const recent = [...launches.values()].find(l=>l.workflowId===id && ["run","resume"].includes(l.kind));
  if (recent) return recent;
  if (!existsSync(LAUNCH_DIR)) return;
  for (const name of readdirSync(LAUNCH_DIR).filter(name=>name.endsWith(".json"))) {
    try { const l = JSON.parse(readFileSync(join(LAUNCH_DIR,name),"utf8")) as Launch; if(l.workflowId===id && ["run","resume"].includes(l.kind)) return l; } catch {}
  }
}

export function browserBusy() {
  refreshLaunches();
  return [...launches.values()].find(l => l.exitCode == null && ["run", "resume", "warm-session", "cold-login", "recover-login", "map-network"].includes(l.kind));
}

export function spawnDetached(opts: {
  kind: Launch["kind"]; handle: string | null; workflowId: string | null;
  tailArgs: string[]; logStem: string; detached: boolean;
  command?: string[]; env?: Record<string, string>; sourcePid?: number;
}): Launch {
  ensureLaunchDir();
  const stem = `${tsStamp()}-${opts.logStem}-${crypto.randomUUID().slice(0, 8)}`;
  const logPath = join(LAUNCH_DIR, stem + ".log");
  const statePath = join(LAUNCH_DIR, stem + ".json");
  const argv = [...(opts.command ?? IGFLOW_CMD), ...opts.tailArgs];
  const launch: Launch = {pid: 0, kind: opts.kind, handle: opts.handle, workflowId: opts.workflowId,
    argv, logPath, statePath, cwd: ROOT, profileDir: opts.env?.PATRONUM_CHROME_PROFILE_DIR, cacheDir: opts.env?.PATRONUM_AUTH_CACHE_DIR, headless: opts.env?.HEADLESS === undefined ? undefined : opts.env.HEADLESS === "true", reuseGrid: opts.env?.PATRONUM_REUSE_GRID === "1", sourcePid: opts.sourcePid, startedAt: Date.now(), exitCode: null, exitAt: null, status: "running", tail: []};
  if(opts.env?.PATRONUM_DETAIL_WORKERS)launch.detailWorkers=Number(opts.env.PATRONUM_DETAIL_WORKERS);
  writeFileSync(logPath, `${new Date().toISOString()} [action] ${opts.kind} requested\n`);
  writeFileSync(statePath, JSON.stringify(launch));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "launch-worker.ts"), statePath], {
    cwd: ROOT, env: {...process.env, ...passthroughIgflowEnv(), ...opts.env}, stdio: ["ignore", "ignore", "ignore"], detached: opts.detached,
  });
  launch.pid = proc.pid;
  // The worker waits for this identity before persisting its outcome.
  writeFileSync(statePath + ".tmp", JSON.stringify(launch)); renameSync(statePath + ".tmp", statePath);
  launches.set(proc.pid, launch); pruneLaunches();
  log.info("launch spawn", {pid: proc.pid, kind: opts.kind, workflowId: opts.workflowId ?? undefined, argv});
  return launch;
}

export function lastLogLines(path: string, n: number): string[] {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\n/).filter((s) => s.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export function summarizeLaunch(l: Launch) {
  const tail = lastLogLines(l.logPath, 20).map(redact);
  return {
    pid: l.pid,
    kind: l.kind,
    handle: l.handle,
    workflowId: l.workflowId,
    argv: l.argv,
    logPath: relative(HOME, l.logPath),
    startedAt: l.startedAt,
    exitCode: l.exitCode,
    exitAt: l.exitAt,
    status: l.status,
    tail,
    result: l.result ? {...l.result,...(typeof l.result.diagnosticPath === "string" && allowedArtifact(l.result.diagnosticPath) ? {diagnosticUrl:`/api/file?path=${encodeURIComponent(l.result.diagnosticPath)}`} : {})} : null,
    profileDir: l.profileDir ?? null,
    sourcePid: l.sourcePid ?? null,
    isolated: Boolean(l.profileDir),
    hint: l.kind === "recover-login" ? "Complete verification in Chrome, close its window, then check the saved session." : null,
  };
}

export function recentLaunches(limit = 6) {
  refreshLaunches();
  return Array.from(launches.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(summarizeLaunch);
}
