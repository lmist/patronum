/**
 * Waiting and time limits.
 *
 * Pause, put a deadline on a slow step, log how long a phase took, and decide
 * whether a model failure should stop the whole run.
 */
import { isProviderError } from "../llm/preflight.js";

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Fail-closed on provider errors: turn any recognisable LLM failure into an
 * LlmError so the top-level catch exits 4. Return the original message for
 * per-call CONTENT-failure fallbacks (schema mismatch / empty extract /
 * one slow page) — never for provider failures.
 */
export function noteLlmError(err: unknown): string {
  const provider = isProviderError(err);
  if (provider) throw provider;
  return err instanceof Error ? err.message : String(err);
}

export async function timedPhase<T>(name: string, task: () => Promise<T>): Promise<T> {
  const started = Date.now();
  console.log(`[scrape] phase=${name} start`);
  try {
    return await task();
  } finally {
    console.log(`[scrape] phase=${name} elapsedMs=${Date.now() - started}`);
  }
}

/** Optional LLM discovery must not hold up a collection indefinitely. */
export async function optionalModel<T>(name: string, task: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await timedPhase(name, () => Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]));
  } finally {
    clearTimeout(timer);
  }
}
