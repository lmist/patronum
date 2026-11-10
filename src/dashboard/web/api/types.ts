export const STAGES = ["preflight", "scrape", "verify", "download", "unique", "analyze", "knowledge"] as const;
export type StageName = typeof STAGES[number];
export const STAGE_LABELS: Record<StageName, string> = { preflight: "Readiness", scrape: "Collect posts", verify: "Verify posts", download: "Download", unique: "Deduplicate", analyze: "Analyze", knowledge: "Publish wiki" };
export type WorkflowStatus = "SUCCESS" | "ERROR" | "PENDING" | "ENQUEUED" | "CANCELLED" | "MAX_RECOVERY_ATTEMPTS_EXCEEDED";
export interface Workflow {
  id: string; handle: string; status: WorkflowStatus; name: string; queue: string;
  createdAt: number; updatedAt: number; startedAt: number | null; completedAt: number | null;
  parentId: string | null; forkedFrom?: string | null; recoveryAttempts: number; skipped?: string[];
}
export interface Step {
  stepId: number; name: string; output: unknown; error: unknown; internal: boolean;
  startedAt: number | null; completedAt: number | null; childWorkflowId: string | null;
  childStatus?: string | null; childStartedAt?: number | null; childCompletedAt?: number | null;
}
export interface Stage {
  name: StageName; state: "idle" | "done" | "running" | "error"; stepId: number | null;
  startedAt: number | null; completedAt: number | null; output: unknown; error: unknown;
}
export interface Detail {
  workflow: Workflow; steps: Step[]; stages: Record<StageName, Stage>;
  currentStage: string | null; errorText: string | null; internalStepCount: number;
  events: Record<string, unknown>; history: unknown[];
}
export interface Recognition { status?: string; selectedIndices?: number[]; reason?: string }
export interface ActionResult extends Recognition {
  ok?: boolean; error?: unknown; authenticated?: boolean; didLogin?: boolean;
  workflowId?: string; recognition?: Recognition; result?: Recognition; diagnosticUrl?: string;
}
export interface Launch {
  pid: number; kind: string; handle: string | null; workflowId: string | null;
  startedAt: number; exitCode: number | null; status: string; tail: string[];
  isolated: boolean; profileDir: string | null; sourcePid: number | null; hint: string | null;
  result: ActionResult | null;
}
export interface Receipt { ok: boolean; pid: number; workflowId?: string; status: string; startedAt?: number }
export interface Snapshot {
  ts: number; empty: boolean; recent?: Workflow[]; running?: Workflow[]; launches: Launch[];
  executor: {executorId?: string; [key: string]: unknown} | null;
  queues: {name: string; concurrency?: number; [key: string]: unknown}[];
}
export interface Log { lines: string[]; exists?: boolean }
export interface FileArtifact {path: string; url: string; type: "media" | "analysis" | "knowledge"; id: string | null; playable?: boolean; previewable?: boolean; mediaKind?: "image" | "video"; title?: string}
export interface Post {id: string; title?: string; caption?: string; url?: string; media: FileArtifact[]; analysis: FileArtifact[]; knowledge: FileArtifact[]; preview?: FileArtifact | null}
export interface Results {ok: boolean; handle: string; posts: Post[]; files: FileArtifact[]; truncated: boolean}
export interface Capture {id: string; fixtureLabel?: string; timestamp?: string; gridSize?: number; capturePath?: string; imageUrl?: string; diagnosticUrl?: string}
export interface CaptchaStatus {local?: {available?: boolean}; vision?: {configured?: boolean; model?: string}}
export const isRunning = (status?: string) => status === "PENDING" || status === "ENQUEUED";
export const isActiveAction = (action?: Launch) => Boolean(action && action.exitCode == null && !["lost", "exited", "failed", "completed"].includes(action.status));
export const isSession = (action: Launch) => action.isolated && action.exitCode === 0 && action.result?.ok === true && ["cold-login", "warm-session", "recover-login"].includes(action.kind);
export function statusLabel(status?: string) {
  return ({SUCCESS:"Complete", ERROR:"Needs attention", PENDING:"Running", ENQUEUED:"Queued", CANCELLED:"Cancelled", MAX_RECOVERY_ATTEMPTS_EXCEEDED:"Needs attention", done:"Complete", error:"Needs attention", running:"Running", idle:"Waiting"} as Record<string,string>)[status ?? ""] ?? status ?? "Unknown";
}
export function duration(start?: number | null, end?: number | null) {
  if (!start) return "—";
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
  return seconds < 60 ? seconds + "s" : seconds < 3600 ? Math.floor(seconds / 60) + "m " + seconds % 60 + "s" : Math.floor(seconds / 3600) + "h " + Math.floor(seconds % 3600 / 60) + "m";
}
export const dateLabel = (time?: number | null) => time ? new Date(time).toLocaleString(undefined, {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}) : "—";
export const fileUrl = (path: string) => "/api/file?path=" + encodeURIComponent(path);
export const actionName = (kind?: string) => ({"preflight":"Readiness check","warm-session":"Saved login check","cold-login":"Fresh login","recover-login":"Complete verification","recognize-captcha":"Image recognition","map-network":"Instagram API map",run:"Collection launch",resume:"Resume",cancel:"Cancel",gc:"Cleanup"} as Record<string,string>)[kind ?? ""] ?? kind ?? "Action";
