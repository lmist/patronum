import { RecognitionSession, type GridObservation, type RecognitionBackend } from "./recognition.js";

export type ChallengeState =
  | { kind: "checkbox" | "waiting" | "solved" }
  | { kind: "blocked"; reason: string }
  | { kind: "grid"; observation: GridObservation; fingerprint: string; dynamic: boolean };
export interface ChallengeDriver {
  inspect(round: number): Promise<ChallengeState>;
  open(): Promise<void>;
  select(indices: number[], fingerprint: string): Promise<boolean>;
  verify(): Promise<void>;
  wait(): Promise<void>;
}
export class CaptchaSolveError extends Error {
  constructor(readonly result: SolverResult) { super(`Automatic CAPTCHA verification failed: ${result.reason}`); }
}

export interface SolverResult { status: "solved" | "failed"; reason: string; rounds: number }

/** Every selection is tied to a current grid; provider failures never trigger guesses. */
export async function solveChallenge(driver: ChallengeDriver, backend: RecognitionBackend, options: { maxRounds?: number; timeoutMs?: number; log?: (event: Record<string, unknown>) => void } = {}): Promise<SolverResult> {
  const maxRounds = options.maxRounds ?? 12;
  const timeoutMs = options.timeoutMs ?? 240_000;
  const session = new RecognitionSession(backend, { maxRounds, timeoutMs: 45_000, totalTimeoutMs: Math.min(timeoutMs, 300_000) });
  const deadline = Date.now() + timeoutMs;
  let rounds = 0, opened = false, waitingForChange: string | null = null;
  let lastState: string | null = null;
  const finish = (status: SolverResult["status"], reason: string): SolverResult => ({ status, reason, rounds });
  while (Date.now() < deadline) {
    const state = await driver.inspect(rounds);
    if (state.kind !== lastState) { options.log?.({ phase: "challenge", state: state.kind }); lastState = state.kind; }
    if (state.kind === "solved") return finish("solved", "challenge-complete");
    if (state.kind === "blocked") return finish("failed", state.reason);
    if (state.kind === "checkbox" && !opened) { await driver.open(); opened = true; }
    if (state.kind !== "grid") { await driver.wait(); continue; }
    if (state.fingerprint === waitingForChange) { await driver.wait(); continue; }
    waitingForChange = null;
    if (rounds >= maxRounds) return finish("failed", "round-limit");
    const result = await session.recognize(state.observation);
    rounds++;
    options.log?.({ phase: "recognize", round: rounds, status: result.status, reason: result.reason, selectedIndices: result.selectedIndices, confidence: result.confidence, latencyMs: result.latencyMs });
    if (result.status !== "proposed") return finish("failed", result.reason);
    const current = await driver.inspect(rounds);
    if (current.kind === "solved") return finish("solved", "challenge-complete");
    if (current.kind !== "grid" || current.fingerprint !== state.fingerprint) {
      options.log?.({ phase: "stale-grid", round: rounds });
      continue;
    }
    if (result.selectedIndices.length && !await driver.select(result.selectedIndices, state.fingerprint)) continue;
    if (!state.dynamic || !result.selectedIndices.length) await driver.verify();
    waitingForChange = state.fingerprint;
    await driver.wait();
  }
  return finish("failed", "timeout");
}
