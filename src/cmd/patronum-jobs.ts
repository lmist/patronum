/**
 * The command line as a client of the Patronum server.
 *
 * The server (src/dashboard/server.ts) owns jobs: it starts, resumes and
 * cancels them, keeps one browser job at a time, and records each launch.
 * The dashboard is one client of it. This is the other: `patronum run`,
 * `resume` and `cancel` send the same requests the dashboard's buttons send,
 * and start the server first when none is running.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { REPO_ROOT, inHome, inRepo, layout } from "../paths.js";

export const SERVER_URL = `http://127.0.0.1:${process.env.IGDASH_PORT ?? 7799}`;
/** Where the server writes when the command line starts it. */
export const SERVER_LOG = `${layout.jobLogs}/server.log`;

export class ServerError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly body: unknown = null) { super(message); }
}

type Health = { ok: boolean; pid?: number; home?: string; port?: number };

export async function serverHealth(timeoutMs = 700): Promise<Health | null> {
  try {
    const response = await fetch(`${SERVER_URL}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? ((await response.json()) as Health) : null;
  } catch {
    return null;
  }
}

/** Make sure the server is up. Returns whether this call started it. */
export async function ensureServer(): Promise<{ started: boolean; url: string; log: string }> {
  const log = inHome(SERVER_LOG);
  if (await serverHealth()) return { started: false, url: SERVER_URL, log };
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, "a");
  try {
    // Its own session: the server outlives this command and the terminal it ran in.
    spawn(process.execPath, [inRepo("src/dashboard/server.ts")], { cwd: REPO_ROOT, stdio: ["ignore", out, out], env: process.env, detached: true }).unref();
  } finally {
    closeSync(out);
  }
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(250)) {
    if (await serverHealth()) return { started: true, url: SERVER_URL, log };
  }
  throw new ServerError(`the server did not start within 20 seconds; see ${log}`);
}

export async function stopServer(): Promise<{ stopped: boolean; pid: number | null }> {
  const health = await serverHealth();
  if (!health) return { stopped: false, pid: null };
  if (!health.pid) throw new ServerError("the running server does not report its process id; stop it where it was started");
  process.kill(health.pid, "SIGTERM");
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await Bun.sleep(150)) {
    if (!(await serverHealth(300))) return { stopped: true, pid: health.pid };
  }
  throw new ServerError(`the server (pid ${health.pid}) did not stop within 5 seconds`);
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      // The server accepts state-changing requests only from its own origin.
      headers: { "content-type": "application/json", origin: SERVER_URL },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ServerError(`the server at ${SERVER_URL} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw new ServerError(data?.error ?? `the server answered ${response.status}`, response.status, data);
  return data;
}

export type Launch = { pid: number; workflowId: string | null; logPath: string; status: string; exitCode?: number | null; kind?: string; handle?: string | null; tail?: string[] };

/** The options `patronum run` accepts, in the terms of the dashboard's New collection form. */
export type RunOptions = {
  handle: string; max?: string; analyze: boolean; skipReels: boolean; showBrowser: boolean; forceLogin: boolean; allFrames: boolean;
  browserTabs?: string; downloadWorkers?: string; analysisWorkers?: string; timeoutMinutes?: string;
};

/** Build the request the New collection form would send, using the form's own rules and defaults. */
export async function runRequest(options: RunOptions): Promise<{ body?: Record<string, unknown>; errors: Record<string, string> }> {
  // The dashboard's files sit outside the root typecheck, so the form module is loaded by path.
  const form = await import(inRepo("src/dashboard/web/features/collections/collection-form.ts"));
  const draft = {
    ...form.collectionDefaults,
    handle: options.handle,
    ...(options.max != null ? { max: options.max } : {}),
    media: options.skipReels ? "images" : "all",
    goal: options.analyze ? "analyze" : "download",
    showBrowser: options.showBrowser, forceLogin: options.forceLogin, allFrames: options.allFrames,
    ...(options.browserTabs != null ? { browserWorkers: options.browserTabs } : {}),
    ...(options.downloadWorkers != null ? { downloadWorkers: options.downloadWorkers } : {}),
    ...(options.analysisWorkers != null ? { analysisWorkers: options.analysisWorkers } : {}),
    ...(options.timeoutMinutes != null ? { timeoutMinutes: options.timeoutMinutes } : {}),
  };
  return form.collectionRequest(draft);
}

export const startJob = (body: Record<string, unknown>): Promise<Launch> => call("POST", "/api/run", body);
export const resumeJob = (workflowId: string): Promise<Launch> => call("POST", "/api/resume", { workflowId });
export const cancelJob = (workflowId: string): Promise<Launch> => call("POST", "/api/cancel", { workflowId });
export const launchState = (pid: number): Promise<Launch> => call("GET", `/api/launch/${pid}`);

/** Follow a launch until its process exits. `onTick` is called on every poll. */
export async function waitForLaunch(pid: number, onTick: () => void | Promise<void>, pollMs = 3_000): Promise<Launch> {
  for (;;) {
    const launch = await launchState(pid);
    await onTick();
    if (launch.exitCode != null) return launch;
    await Bun.sleep(pollMs);
  }
}
