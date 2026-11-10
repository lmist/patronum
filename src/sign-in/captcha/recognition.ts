import { z } from "zod";

const indices = z.array(z.number().int().min(0).max(15)).max(16);
const observationSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  round: z.number().int().min(0).max(99),
  capturedAt: z.string().datetime(),
  gridSize: z.union([z.literal(3), z.literal(4)]),
  kind: z.enum(["selection", "replacement", "squares"]),
  target: z.string().trim().min(1).max(200),
  image: z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), dataBase64: z.string().min(16).max(12_000_000) }).strict(),
  changedIndices: indices.optional(),
}).strict();
export type GridObservation = z.infer<typeof observationSchema>;
export type RecognitionReason = "recognized" | "low-confidence" | "model-abstained" | "invalid-observation" | "invalid-response" | "round-limit" | "stale-observation" | "timeout" | "backend-error" | "unconfigured" | "unsupported-grid" | "unsupported-target" | "model-unavailable" | "unauthorized" | "rate-limited";
export class RecognitionError extends Error {
  constructor(readonly reason: RecognitionReason) { super(reason); }
}
export interface RecognitionBackend {
  readonly name: string;
  recognize(observation: GridObservation, signal: AbortSignal): Promise<unknown>;
}
export interface RecognitionResult {
  status: "proposed" | "abstained" | "error";
  reason: RecognitionReason;
  observationId: string | null;
  round: number | null;
  selectedIndices: number[];
  confidence: number | null;
  backend: string;
  timestamp: string;
  latencyMs: number;
  manualFallback: true;
}
const responseSchema = z.object({ selectedIndices: indices, confidence: z.number().min(0).max(1), abstain: z.boolean().optional(), reason: z.enum(["unsupported-grid", "unsupported-target", "low-confidence"]).optional() }).strict();

export function validateObservation(value: unknown): GridObservation {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success) throw new RecognitionError("invalid-observation");
  const observation = parsed.data;
  const { gridSize, changedIndices, kind, image } = observation;
  if ((kind === "squares" && gridSize !== 4) || (kind === "replacement" && gridSize !== 3)) throw new RecognitionError("invalid-observation");
  if (kind === "replacement" && !changedIndices?.length) throw new RecognitionError("invalid-observation");
  if (kind !== "replacement" && changedIndices !== undefined) throw new RecognitionError("invalid-observation");
  if (changedIndices && (new Set(changedIndices).size !== changedIndices.length || changedIndices.some(i => i >= gridSize ** 2))) throw new RecognitionError("invalid-observation");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) || image.dataBase64.length % 4 !== 0) throw new RecognitionError("invalid-observation");
  const bytes = Buffer.from(image.dataBase64, "base64");
  const validMagic = image.mimeType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image.mimeType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!validMagic) throw new RecognitionError("invalid-observation");
  return observation;
}

/** Recognition produces reviewable proposals only; this module has no browser actions. */
export class RecognitionSession {
  private rounds = 0;
  private lastRound = -1;
  private seen = new Set<string>();
  private startedAt = Date.now();
  private busy = false;
  private readonly maxRounds: number;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly minConfidence: number;

  constructor(private readonly backend: RecognitionBackend, options: { maxRounds?: number; timeoutMs?: number; totalTimeoutMs?: number; minConfidence?: number } = {}) {
    this.maxRounds = options.maxRounds ?? 5;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 120_000;
    this.minConfidence = options.minConfidence ?? 0.85;
    if (!Number.isInteger(this.maxRounds) || this.maxRounds < 1 || this.maxRounds > 20 || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000 || !Number.isFinite(this.totalTimeoutMs) || this.totalTimeoutMs < 1 || this.totalTimeoutMs > 300_000 || !Number.isFinite(this.minConfidence) || this.minConfidence < 0 || this.minConfidence > 1) throw new Error("Invalid recognition limits");
  }

  async recognize(value: unknown): Promise<RecognitionResult> {
    const started = Date.now();
    const result: RecognitionResult = { status: "error", reason: "invalid-observation", observationId: null, round: null, selectedIndices: [], confidence: null, backend: /^[a-z0-9_-]{1,40}$/i.test(this.backend.name) ? this.backend.name : "custom", timestamp: new Date().toISOString(), latencyMs: 0, manualFallback: true };
    let ownsBusy = false;
    try {
      const observation = validateObservation(value);
      result.observationId = observation.id;
      result.round = observation.round;
      if (this.rounds >= this.maxRounds) throw new RecognitionError("round-limit");
      if (this.busy || this.seen.has(observation.id) || observation.round <= this.lastRound) throw new RecognitionError("stale-observation");
      const remaining = this.totalTimeoutMs - (Date.now() - this.startedAt);
      if (remaining <= 0) throw new RecognitionError("timeout");
      this.rounds++;
      this.seen.add(observation.id);
      this.lastRound = observation.round;
      this.busy = ownsBusy = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let raw: unknown;
      try {
        raw = await Promise.race([
          this.backend.recognize(observation, controller.signal),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RecognitionError("timeout")); }, Math.min(this.timeoutMs, remaining)); }),
        ]);
      } finally { clearTimeout(timer); }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) throw new RecognitionError("invalid-response");
      const proposal = parsed.data;
      const allowed = observation.kind === "replacement" ? observation.changedIndices! : Array.from({ length: observation.gridSize ** 2 }, (_, i) => i);
      if (new Set(proposal.selectedIndices).size !== proposal.selectedIndices.length || proposal.selectedIndices.some(i => !allowed.includes(i))) throw new RecognitionError("invalid-response");
      result.confidence = proposal.confidence;
      if (proposal.abstain || proposal.confidence < this.minConfidence) {
        result.status = "abstained";
        result.reason = proposal.abstain ? proposal.reason ?? "model-abstained" : "low-confidence";
      } else {
        result.status = "proposed";
        result.reason = "recognized";
        result.selectedIndices = [...proposal.selectedIndices].sort((a, b) => a - b);
      }
    } catch (error) {
      result.reason = error instanceof RecognitionError ? error.reason : "backend-error";
      if (["round-limit", "stale-observation", "timeout", "unconfigured", "unsupported-grid", "unsupported-target", "model-unavailable"].includes(result.reason)) result.status = "abstained";
    } finally {
      if (ownsBusy) this.busy = false;
      result.latencyMs = Date.now() - started;
    }
    return result;
  }
}
