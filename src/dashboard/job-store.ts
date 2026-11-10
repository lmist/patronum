/**
 * Read jobs from the job engine's database.
 *
 * The Go engine (igflow) stores its workflows in SQLite with Go-encoded
 * values. This is the only file that knows that format. Everything else in
 * the dashboard asks plain questions: list jobs, get one job, its steps, its
 * events, which stage it is on.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { log } from "./log";
import { DB_PATH } from "./settings";

// Six collection stages plus the retired Knowledge stage for historical results.
export const STAGES = [
  "preflight",
  "scrape",
  "verify",
  "download",
  "unique",
  "analyze",
  "knowledge",
] as const;

export type Stage = (typeof STAGES)[number];

// DBOS serializes JSON values into base64 in workflow_events / streams. Decode
// leniently: try base64 → JSON, then plain JSON, then raw string.
export function decodeDbosValue(raw: string | null): unknown {
  if (raw == null) return null;
  const tryJson = (s: string) => {
    try { return JSON.parse(s); } catch { return undefined; }
  };
  if (raw === "__DBOS_STREAM_CLOSED__") return { closed: true };
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const reencoded = Buffer.from(decoded, "utf8").toString("base64");
    if (reencoded.replace(/=+$/, "") === raw.replace(/=+$/, "")) {
      const parsed = tryJson(decoded);
      if (parsed !== undefined) return parsed;
    }
  } catch {}
  const parsed = tryJson(raw);
  if (parsed !== undefined) return parsed;
  return raw;
}

export const INTERNAL_STEP = /^DBOS\./;

export const GOB_NOISE = /^(flow\.CLIError|CLIError|Stage|ExitCode|Retryable|Code|Msg|LogPath|Argv|Cause|\[\]string)$/;

export function printableRuns(buf: Buffer): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of buf) {
    if (b >= 32 && b < 127) cur += String.fromCharCode(b);
    else {
      if (cur.length >= 4) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 4) out.push(cur);
  return out;
}

export function looksGob(s: string): boolean {
  if (s.length < 24) return false;
  if (/flow\.CLIError/.test(s)) return true;
  let ctrl = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return ctrl > 2;
}

// DBOS stores Go gob for typed step errors. Surface printable fragments
// instead of a base64 blob in the UI.
export function humanizeValue(v: unknown): unknown {
  if (v == null || typeof v === "object") return v;
  if (typeof v !== "string") return v;
  let bytes: Buffer | null = null;
  try {
    const b = Buffer.from(v, "base64");
    const reenc = b.toString("base64").replace(/=+$/, "");
    if (reenc === v.replace(/=+$/, "") && b.length > 8) bytes = b;
  } catch {}
  const source = bytes ?? (looksGob(v) ? Buffer.from(v, "latin1") : null);
  if (source && (source.includes(Buffer.from("CLIError")) || looksGob(source.toString("latin1")))) {
    const extracted = printableRuns(source).filter((s) =>
      !GOB_NOISE.test(s) && !/CLIError/i.test(s) && s.length >= 5,
    );
    log.debug("decoded gob step payload", { extra: { extracted } });
    return { encoded: "gob", extracted };
  }
  return v;
}

export function displayErrorText(events: Record<string, unknown>, steps: any[], wf: { error?: unknown } | null): string | null {
  if (typeof events.error === "string" && events.error.trim()) return events.error.trim();
  if (typeof wf?.error === "string" && wf.error.trim() && !looksGob(wf.error)) return wf.error.trim();
  for (const st of steps) {
    if (!st.error) continue;
    const h = humanizeValue(st.error);
    if (typeof h === "string" && h.trim() && !looksGob(h)) return h.trim();
    if (h && typeof h === "object" && Array.isArray((h as any).extracted)) {
      const useful = (h as any).extracted.filter((s: string) =>
        /llm|auth|error|fail|preflight|exit|quota|key/i.test(s),
      );
      if (useful.length) return useful.join(" · ");
    }
  }
  return null;
}

export function handleFromId(id: string): string {
  const m = /^ig:([^:]+):/.exec(id);
  return m ? m[1] : "";
}

export function openDb(): Database | null {
  if (!existsSync(DB_PATH)) {
    log.debug("db missing", { extra: { path: DB_PATH } });
    return null;
  }
  try {
    // WAL needs a writable shm even for SELECT. readonly:true fails with
    // "unable to open database file" after a fresh sqlite (no leftover -shm).
    const db = new Database(DB_PATH, { safeIntegers: false });
    db.exec("PRAGMA busy_timeout=5000");
    try { db.exec("PRAGMA query_only=1"); } catch {}
    return db;
  } catch (e) {
    log.error("db open failed", { err: (e as Error).message, extra: { path: DB_PATH } });
    return null;
  }
}

/** Extra way to name a job's profile when its id does not carry the handle. */
let handleFallback: (workflowId: string) => string | null | undefined = () => undefined;

/** server.ts supplies the lookup, so this file does not need to know about launches. */
export function useHandleFallback(lookup: (workflowId: string) => string | null | undefined): void {
  handleFallback = lookup;
}

export function normalizeWorkflow(r: any) {
  const result = humanizeValue(decodeDbosValue(r.output)) as {skipped?:unknown} | null;
  return {
    id: r.workflow_uuid,
    handle: handleFromId(r.workflow_uuid) || r.deduplication_id || handleFallback(r.workflow_uuid) || "",
    status: r.status,
    name: r.name,
    queue: r.queue_name,
    executor: r.executor_id,
    appVersion: r.application_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at_epoch_ms,
    completedAt: r.completed_at,
    recoveryAttempts: r.recovery_attempts ?? 0,
    dedupId: r.deduplication_id,
    parentId: r.parent_workflow_id,
    forkedFrom: r.forked_from ?? null,
    skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    error: r.error,
    timeoutMs: r.workflow_timeout_ms,
    deadlineMs: r.workflow_deadline_epoch_ms,
  };
}

export function listWorkflows(db: Database, opts: { status?: string; handle?: string; limit?: number; parentsOnly?: boolean }) {
  const wh: string[] = [];
  const args: any[] = [];
  if (opts.status) {
    wh.push("status = ?");
    args.push(opts.status.toUpperCase());
  }
  if (opts.handle) {
    wh.push("workflow_uuid LIKE ?");
    args.push(`ig:${opts.handle}:%`);
  }
  if (opts.parentsOnly) {
    wh.push("(parent_workflow_id IS NULL OR parent_workflow_id = '')");
  }
  const where = wh.length ? "WHERE " + wh.join(" AND ") : "";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const sql = `SELECT * FROM workflow_status ${where} ORDER BY created_at DESC LIMIT ?`;
  return db.query(sql).all(...args, limit).map(normalizeWorkflow);
}

export function getWorkflow(db: Database, id: string) {
  const row = db.query("SELECT * FROM workflow_status WHERE workflow_uuid = ?").get(id) as any;
  return row ? normalizeWorkflow(row) : null;
}

export function getSteps(db: Database, id: string) {
  const rows = db
    .query(
      "SELECT function_id, function_name, output, error, child_workflow_id, started_at_epoch_ms, completed_at_epoch_ms FROM operation_outputs WHERE workflow_uuid = ? ORDER BY function_id ASC",
    )
    .all(id) as any[];
  return rows.map((r) => ({
    stepId: r.function_id,
    name: r.function_name,
    childWorkflowId: r.child_workflow_id ?? null,
    childStatus: r.child_workflow_id ? getWorkflow(db, r.child_workflow_id)?.status ?? null : null,
    childStartedAt: r.child_workflow_id ? getWorkflow(db, r.child_workflow_id)?.startedAt ?? null : null,
    childCompletedAt: r.child_workflow_id ? getWorkflow(db, r.child_workflow_id)?.completedAt ?? null : null,
    output: humanizeValue(decodeDbosValue(r.output)),
    error: humanizeValue(decodeDbosValue(r.error)),
    startedAt: r.started_at_epoch_ms,
    completedAt: r.completed_at_epoch_ms,
    internal: INTERNAL_STEP.test(r.function_name ?? ""),
  }));
}

export function getEvents(db: Database, id: string) {
  const rows = db
    .query("SELECT key, value FROM workflow_events WHERE workflow_uuid = ?")
    .all(id) as any[];
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = decodeDbosValue(r.value);
  return out;
}

export function getEventHistory(db: Database, id: string) {
  const rows = db
    .query(
      "SELECT function_id, key, value FROM workflow_events_history WHERE workflow_uuid = ? ORDER BY function_id ASC",
    )
    .all(id) as any[];
  return rows.map((r) => ({ stepId: r.function_id, key: r.key, value: decodeDbosValue(r.value) }));
}

export function getStream(db: Database, id: string, key: string, sinceOffset: number) {
  const rows = db
    .query(
      `SELECT "offset" AS off, function_id, value FROM streams WHERE workflow_uuid = ? AND key = ? AND "offset" >= ? ORDER BY "offset" ASC`,
    )
    .all(id, key, sinceOffset) as any[];
  const entries = rows.map((r) => ({
    offset: r.off,
    stepId: r.function_id,
    value: decodeDbosValue(r.value),
  }));
  const nextOffset = entries.length ? entries[entries.length - 1].offset + 1 : sinceOffset;
  return { entries, nextOffset };
}

export function getQueues(db: Database) {
  const rows = db
    .query(
      "SELECT name, concurrency, worker_concurrency, priority_enabled, polling_interval_sec FROM queues ORDER BY CASE name WHEN 'ig-jobs' THEN 0 WHEN 'ig-scrape' THEN 1 WHEN 'ig-download' THEN 2 WHEN 'ig-analyze' THEN 3 ELSE 4 END, name"
    )
    .all() as any[];
  const occ = db
    .query(
      "SELECT queue_name, status, COUNT(*) AS n FROM workflow_status WHERE queue_name IS NOT NULL AND status IN ('ENQUEUED','PENDING') GROUP BY queue_name, status",
    )
    .all() as any[];
  const byQueue: Record<string, { enqueued: number; pending: number }> = {};
  for (const o of occ) {
    if (!byQueue[o.queue_name]) byQueue[o.queue_name] = { enqueued: 0, pending: 0 };
    if (o.status === "ENQUEUED") byQueue[o.queue_name].enqueued = o.n;
    if (o.status === "PENDING") byQueue[o.queue_name].pending = o.n;
  }
  return rows.map((r) => ({
    name: r.name,
    concurrency: r.concurrency,
    workerConcurrency: r.worker_concurrency,
    priorityEnabled: !!r.priority_enabled,
    pollingIntervalSec: r.polling_interval_sec,
    enqueued: byQueue[r.name]?.enqueued ?? 0,
    pending: byQueue[r.name]?.pending ?? 0,
  }));
}

export function getExecutorSummary(db: Database) {
  const row = db
    .query(
      "SELECT executor_id, application_version, application_name FROM workflow_status WHERE executor_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as any;
  const versions = db
    .query("SELECT version_name, application_name, version_timestamp FROM application_versions ORDER BY version_timestamp DESC LIMIT 5")
    .all() as any[];
  return {
    executorId: row?.executor_id ?? null,
    appVersion: row?.application_version ?? null,
    appName: row?.application_name ?? null,
    versions,
  };
}

export function deriveStages(steps: any[], events: Record<string, any>, workflowStatus?: string) {
  const state: Record<Stage, any> = Object.create(null);
  for (const s of STAGES) {
    state[s] = { name: s, state: "idle", stepId: null, startedAt: null, completedAt: null, output: null, error: null };
  }
  for (const st of steps) {
    const matched = STAGES.find(s => st.name === s || st.name?.startsWith(s + "-"));
    if (matched) {
      const s = matched;
      state[s].stepId = st.stepId;
      state[s].startedAt = state[s].startedAt ?? st.startedAt;
      state[s].completedAt = st.completedAt;
      state[s].output = st.output;
      state[s].error = state[s].error ?? st.error;
      if (state[s].error) state[s].state = "error";
      else if (st.completedAt) state[s].state = "done";
      else if (st.startedAt) state[s].state = "running";
    }
  }
  const currentStage = typeof events.stage === "string" ? events.stage : null;
  if (currentStage && (STAGES as readonly string[]).includes(currentStage)) {
    const s = currentStage as Stage;
    if (state[s].state !== "error" && !["SUCCESS","ERROR","CANCELLED"].includes(workflowStatus ?? "")) state[s].state = "running";
    for (const prior of STAGES.slice(0,STAGES.indexOf(s))) if(state[prior].state === "idle" && prior === "scrape") state[prior].state = "done";
  }
  if (currentStage === "done") for(const s of STAGES) if(state[s].state === "running") state[s].state = "done";
  return { stages: state, currentStage };
}
