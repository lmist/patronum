/**
 * Start, resume, cancel and clean up jobs.
 *
 * Checks what the web UI sent, then starts the job engine with matching
 * flags. Also starts the API-mapping action.
 */
import { join, relative } from "node:path";
import { HOME, ROOT } from "./settings";
import { handleFromId } from "./job-store";
import { json, BadRequest, readJson } from "./http";
import {
  type Launch,
  launches,
  refreshLaunches,
  workflowLaunch,
  browserBusy,
  spawnDetached,
} from "./launcher";

// ————————— launch (job spawning) —————————
//
// Handle grammar matches internal/flow.NormalizeHandle: [A-Za-z0-9._]+ after
// stripping @ and instagram-URL parsing. The dashboard only accepts the
// already-normalized shape — the CLI re-normalizes for a second guard.
export const HANDLE_RE = /^[A-Za-z0-9._]+$/;

// Whitelisted flags for `:run`. Boolean flags become bare argv tokens; value
// flags become two tokens (`--name`, `value`). Anything else is rejected.
export type FlagDef = { kind: "bool" } | { kind: "int"; min?: number } | { kind: "duration" } | { kind: "id" };

export const RUN_FLAGS: Record<string, FlagDef> = {
  "max": { kind: "int", min: 1 },
  "no-detail": { kind: "bool" },
  "skip-reels": { kind: "bool" },
  "force-login": { kind: "bool" },
  "fresh": { kind: "bool" },
  "skip-download": { kind: "bool" },
  "skip-unique": { kind: "bool" },
  "skip-analyze": { kind: "bool" },
  "skip-kb": { kind: "bool" },
  "dl-workers": { kind: "int", min: 1 },
  "analyze-workers": { kind: "int", min: 1 },
  "all-frames": { kind: "bool" },
  "scroll-rounds": { kind: "int", min: 0 },
  "timeout": { kind: "duration" },
  "workflow-id": { kind: "id" },
  "no-preflight": { kind: "bool" },
  "skip-llm-preflight": { kind: "bool" },
};

export const GC_FLAGS: Record<string, FlagDef> = {
  "older-than": { kind: "duration" },
  "keep-errors": { kind: "bool" },
  "dry-run": { kind: "bool" },
};

export const DURATION_RE = /^\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h)$/;

export const WFID_RE = /^(?:ig:[A-Za-z0-9._]+:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function validateFlags(input: Record<string, unknown>, defs: Record<string, FlagDef>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const def = defs[k];
    if (!def) throw new BadRequest(`unknown flag --${k}`);
    if (def.kind === "bool") {
      if (v === true) out.push(`--${k}`);
      else if (v === false || v == null) { /* skip */ }
      else throw new BadRequest(`--${k} takes no value`);
    } else if (def.kind === "int") {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isInteger(n) || (def.min != null && n < def.min)) {
        throw new BadRequest(`--${k} requires integer >= ${def.min ?? 0}`);
      }
      out.push(`--${k}`, String(n));
    } else if (def.kind === "duration") {
      const s = String(v ?? "");
      if (!DURATION_RE.test(s)) throw new BadRequest(`--${k} must be a Go duration (e.g. 6h, 30m, 30d is not valid Go — use 720h)`);
      out.push(`--${k}`, s);
    } else if (def.kind === "id") {
      const s = String(v ?? "");
      if (!WFID_RE.test(s)) throw new BadRequest(`--${k} must match ig:<handle>:<unix>`);
      out.push(`--${k}`, s);
    }
  }
  return out;
}

export function unixSeconds(): number { return Math.floor(Date.now() / 1000); }

export async function handleRunPost(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  const rawHandle = String(body.handle ?? "").trim();
  if (!rawHandle) return json({ ok: false, error: "handle required" }, 400);
  const stripped = rawHandle.replace(/^@+/, "");
  if (!HANDLE_RE.test(stripped)) return json({ ok: false, error: "handle must match [A-Za-z0-9._]+" }, 400);

  // Optional caller-supplied workflow id; otherwise mint one so the frontend
  // knows exactly which DB row to watch.
  let wfId = typeof body["workflow-id"] === "string" ? String(body["workflow-id"]).trim()
           : typeof body.workflowId === "string" ? String(body.workflowId).trim() : "";
  if (wfId) {
    if (!WFID_RE.test(wfId)) return json({ ok: false, error: "workflow-id must match ig:<handle>:<unix>" }, 400);
  } else {
    wfId = `ig:${stripped}:${unixSeconds()}`;
  }
  let authSource: Launch | undefined;
  if (body.sourcePid != null) {
    refreshLaunches(); authSource = launches.get(Number(body.sourcePid));
    if (!authSource || !["cold-login","warm-session","recover-login"].includes(authSource.kind) || authSource.result?.ok !== true) return json({ok:false,error:"Select a successfully checked login action before collecting with its session."},400);
  }
  const passable: Record<string, unknown> = { ...body };
  if (body["show-browser"] != null && typeof body["show-browser"] !== "boolean") return json({ok:false,error:"show-browser must be a boolean"},400);
  if (body["reuse-grid"] != null && typeof body["reuse-grid"] !== "boolean") return json({ok:false,error:"reuse-grid must be a boolean"},400);
  delete passable["show-browser"];
  delete passable["reuse-grid"];
  if(body["detail-workers"] != null && (!Number.isInteger(body["detail-workers"]) || Number(body["detail-workers"])<1 || Number(body["detail-workers"])>32))return json({ok:false,error:"Detail workers must be an integer from 1 to 32"},400);
  delete passable["detail-workers"];
  delete passable.sourcePid; delete passable.handle; delete passable.workflowId; delete passable["workflow-id"];
  let flagArgv: string[];
  try { flagArgv = validateFlags(passable, RUN_FLAGS); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  const tailArgs = ["run", "--handle", stripped, "--workflow-id", wfId, ...flagArgv.filter((a, i, arr) => {
    // Skip any duplicate --workflow-id emitted by validateFlags.
    if (a === "--workflow-id") return false;
    if (i > 0 && arr[i - 1] === "--workflow-id") return false;
    return true;
  })];
  const busy = browserBusy();
  if (busy) return json({ok:false, error:"A browser action is already running. Wait or stop it before launching another.", pid:busy.pid}, 409);
  let launch: Launch;
  try {
    launch = spawnDetached({
      kind: "run",
      handle: stripped,
      workflowId: wfId,
      tailArgs,
      logStem: stripped,
      detached: true,
      sourcePid: authSource?.pid,
      env: {HEADLESS:body["show-browser"]===true?"false":"true",PATRONUM_REUSE_GRID:body["reuse-grid"]===true?"1":"0",PATRONUM_DETAIL_WORKERS:String(body["detail-workers"]??10),...(authSource?.profileDir ? {PATRONUM_CHROME_PROFILE_DIR:authSource.profileDir,...(authSource.cacheDir ? {PATRONUM_AUTH_CACHE_DIR:authSource.cacheDir} : {})} : {})},
    });
  } catch (e) {
    return json({ ok: false, error: `spawn failed: ${(e as Error).message}` }, 500);
  }
  return json({ ok: true, pid: launch.pid, workflowId: wfId, logPath: relative(HOME, launch.logPath), status: launch.status });
}

export async function handleMapNetworkPost(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e) { return json({ok:false,error:(e as Error).message},400); }
  const rawHandle = String(body.handle ?? "").trim();
  if (!rawHandle) return json({ok:false,error:"handle required"},400);
  const handle = rawHandle.replace(/^@+/, "");
  if (handle.length > 30 || !HANDLE_RE.test(handle)) return json({ok:false,error:"handle must be 1–30 letters, numbers, periods, or underscores"},400);
  if (body["show-browser"] != null && typeof body["show-browser"] !== "boolean") return json({ok:false,error:"show-browser must be a boolean"},400);
  if (body.surface != null && body.surface !== "profile" && body.surface !== "saved") return json({ok:false,error:"surface must be profile or saved"},400);
  const unexpected = Object.keys(body).find(key => !["handle", "show-browser", "sourcePid", "surface"].includes(key));
  if (unexpected) return json({ok:false,error:`unknown field ${unexpected}`},400);
  let authSource: Launch | undefined;
  if (body.sourcePid != null) {
    refreshLaunches(); authSource = launches.get(Number(body.sourcePid));
    if (!authSource || !["cold-login","warm-session","recover-login"].includes(authSource.kind) || authSource.result?.ok !== true) return json({ok:false,error:"Select a successfully checked login action before mapping with its session."},400);
  }
  const busy = browserBusy();
  if (busy) return json({ok:false,error:"A browser action is already running. Wait or stop it before launching another.",pid:busy.pid},409);
  try {
    const command = process.env.IGDASH_MAP_NETWORK_CMD ? JSON.parse(process.env.IGDASH_MAP_NETWORK_CMD) : [process.execPath,join(ROOT,"src/cmd/map-network.ts")];
    const surface = body.surface === "saved" ? "saved" : null;
    const tailArgs = surface ? ["--handle",handle,"--surface",surface] : ["--handle",handle];
    const launch = spawnDetached({
      kind:"map-network",handle,workflowId:null,command,tailArgs,
      logStem:`map-network-${handle}${surface ? `-${surface}` : ""}`,detached:true,sourcePid:authSource?.pid,
      env:{HEADLESS:body["show-browser"]===true?"false":"true",...(authSource?.profileDir ? {PATRONUM_CHROME_PROFILE_DIR:authSource.profileDir,...(authSource.cacheDir ? {PATRONUM_AUTH_CACHE_DIR:authSource.cacheDir} : {})} : {})},
    });
    return json({ok:true,pid:launch.pid,logPath:relative(HOME,launch.logPath),status:launch.status});
  } catch (e) {
    return json({ok:false,error:`spawn failed: ${(e as Error).message}`},500);
  }
}

export async function handleResumePost(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  const wfId = String(body.workflowId ?? body["workflow-id"] ?? "").trim();
  if (!WFID_RE.test(wfId)) return json({ ok: false, error: "workflowId must match ig:<handle>:<unix>" }, 400);
  const handle = handleFromId(wfId) || [...launches.values()].find(l=>l.workflowId===wfId)?.handle || null;
  const busy = browserBusy();
  if (busy) return json({ok:false, error:"A browser action is already running.", pid:busy.pid}, 409);
  const prior = workflowLaunch(wfId);
  const tailArgs = ["resume", wfId];
  const launch = spawnDetached({
    kind: "resume",
    handle,
    workflowId: wfId,
    tailArgs,
    logStem: `resume-${handle ?? "unknown"}`,
    detached: true,
    sourcePid: prior?.sourcePid,
    env: {HEADLESS:prior?.headless===false?"false":"true",PATRONUM_REUSE_GRID:prior?.reuseGrid?"1":"0",PATRONUM_DETAIL_WORKERS:String(prior?.detailWorkers??10),...(prior?.profileDir ? {PATRONUM_CHROME_PROFILE_DIR:prior.profileDir,...(prior.cacheDir ? {PATRONUM_AUTH_CACHE_DIR:prior.cacheDir} : {})} : {})},
  });
  return json({ ok: true, pid: launch.pid, workflowId: wfId, logPath: relative(HOME, launch.logPath), status: launch.status });
}

export async function handleCancelPost(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  const wfId = String(body.workflowId ?? body["workflow-id"] ?? "").trim();
  if (!WFID_RE.test(wfId)) return json({ ok: false, error: "workflowId must match ig:<handle>:<unix>" }, 400);
  const handle = handleFromId(wfId) || null;
  const tailArgs = ["cancel", wfId];
  const launch = spawnDetached({
    kind: "cancel",
    handle,
    workflowId: wfId,
    tailArgs,
    logStem: `cancel-${handle ?? "unknown"}`,
    detached: false,
  });
  return json({ ok: true, pid: launch.pid, workflowId: wfId, logPath: relative(HOME, launch.logPath), status: launch.status });
}

export async function handleGcPost(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  let flagArgv: string[];
  try { flagArgv = validateFlags(body, GC_FLAGS); }
  catch (e) { return json({ ok: false, error: (e as Error).message }, 400); }
  const tailArgs = ["gc", ...flagArgv];
  const launch = spawnDetached({
    kind: "gc",
    handle: null,
    workflowId: null,
    tailArgs,
    logStem: "gc",
    detached: false,
  });
  return json({ ok: true, pid: launch.pid, logPath: relative(HOME, launch.logPath), status: launch.status });
}
