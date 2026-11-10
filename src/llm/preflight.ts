/**
 * Fail-closed LLM preflight + provider-error recogniser.
 *
 * `pingLlm` sends one cheap POST to an OpenAI-compatible /chat/completions
 * endpoint and classifies the outcome. `isProviderError` recognises the
 * same failure classes in errors thrown by Stagehand observe/act/extract
 * mid-run so the caller can die (exit 4) instead of degrading silently.
 *
 * Never prints the API key.
 */

export type LlmKind =
  | "missing-key"
  | "bad-key"
  | "bad-model"
  | "quota"
  | "unreachable";

export type PingResult = {
  ok: boolean;
  kind?: LlmKind;
  model: string;
  baseUrl: string;
  status: number | null;
  reason: string;
  latencyMs: number;
};

export class LlmError extends Error {
  readonly code = "llm" as const;
  readonly kind: LlmKind;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly status?: number | null;
  constructor(
    kind: LlmKind,
    message: string,
    opts: { baseUrl?: string; model?: string; status?: number | null } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.baseUrl = opts.baseUrl;
    this.model = opts.model;
    this.status = opts.status ?? null;
  }
}

/** True if this error has our fail-closed llm shape (LlmError or duck-typed). */
export function isLlmError(err: unknown): err is LlmError {
  return (
    err instanceof LlmError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "llm")
  );
}

/** Match the Alibaba Token Plan "usage limit" / 2056 style quota exhaust. */
const QUOTA_RE =
  /\b(?:2056|token[\s_-]*plan[\s_-]*(?:usage|exhaust)|usage[\s_-]*limit|insufficient[_\s-]*quota|quota[\s_-]*exhaust|rate[\s_-]*limit)\b/i;
const BAD_KEY_RE =
  /\b(?:invalid[_\s-]*api[_\s-]*key|authentication[_\s-]*failed|unauthorized|invalid[_\s-]*credentials|401)\b/i;
const BAD_MODEL_RE =
  /\b(?:model[_\s-]*not[_\s-]*found|does[_\s-]*not[_\s-]*exist|the model .* does not exist|unknown[_\s-]*model)\b/i;
const NETWORK_RE =
  /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo|fetch failed|network|socket hang up)\b/i;

/**
 * Recognise a provider-level LLM failure hiding in an arbitrary error
 * (as thrown by Stagehand / underlying SDK / fetch). Returns an LlmError
 * on match, otherwise null.
 *
 * Order matters: quota / bad-key / bad-model → unreachable last.
 */
export function isProviderError(err: unknown): LlmError | null {
  if (err == null) return null;
  if (isLlmError(err)) return err as LlmError;

  const raw = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const causeMsg = (() => {
    const c = (err as { cause?: unknown }).cause;
    if (!c) return "";
    if (c instanceof Error) return `${c.message}\n${c.stack ?? ""}`;
    return String(c);
  })();
  const codeStr = (() => {
    const anyErr = err as { code?: unknown };
    return typeof anyErr.code === "string" ? anyErr.code : "";
  })();
  const statusN = (() => {
    const anyErr = err as { status?: unknown; statusCode?: unknown };
    if (typeof anyErr.status === "number") return anyErr.status;
    if (typeof anyErr.statusCode === "number") return anyErr.statusCode;
    return null as number | null;
  })();

  const hay = `${raw}\n${causeMsg}\n${codeStr}`;

  if (QUOTA_RE.test(hay) || statusN === 429) {
    return new LlmError("quota", `LLM quota/plan exhausted: ${firstLine(raw)}`, {
      status: statusN,
    });
  }
  if (BAD_KEY_RE.test(hay) || statusN === 401 || statusN === 403) {
    return new LlmError("bad-key", `LLM key rejected: ${firstLine(raw)}`, {
      status: statusN,
    });
  }
  if (BAD_MODEL_RE.test(hay) || statusN === 404) {
    return new LlmError("bad-model", `LLM model not found: ${firstLine(raw)}`, {
      status: statusN,
    });
  }
  if (NETWORK_RE.test(hay) || (typeof statusN === "number" && statusN >= 500 && statusN < 600)) {
    return new LlmError(
      "unreachable",
      `LLM endpoint unreachable: ${firstLine(raw)}`,
      { status: statusN },
    );
  }
  return null;
}

function firstLine(s: string, max = 240): string {
  const line = s.split("\n", 1)[0] ?? s;
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** Remove the Stagehand OpenAI routing prefix before sending the provider API request. */
export function apiModelId(name: string): string {
  return name.replace(/^openai\//i, "");
}

/**
 * One-shot preflight against an OpenAI-compatible provider.
 * Success is 2xx. Any other outcome is classified into an LlmKind.
 *
 * The API key is only sent in Authorization; it is never logged, embedded
 * in `reason`, or returned in the result.
 */
export async function pingLlm(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<PingResult> {
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  if (!opts.apiKey) {
    return {
      ok: false,
      kind: "missing-key",
      model: opts.model,
      baseUrl: base,
      status: null,
      reason:
        "QWEN_API_KEY / DASHSCOPE_API_KEY / ALIBABA_API_KEY is not set",
      latencyMs: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status: number | null = null;
  let bodyText = "";
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        // Keep the reported model name, but send the provider's bare API id.
        model: apiModelId(opts.model),
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    status = res.status;
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Math.round(performance.now() - started);
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code ?? "";
    let kind: LlmKind = "unreachable";
    let reason = `fetch failed: ${msg}`;
    if (controller.signal.aborted || /aborted|timeout|timed out/i.test(msg)) {
      reason = `timeout after ${timeoutMs}ms`;
    } else if (NETWORK_RE.test(`${msg} ${code}`)) {
      reason = `network error (${code || msg})`;
    }
    return {
      ok: false,
      kind,
      model: opts.model,
      baseUrl: base,
      status: null,
      reason,
      latencyMs,
    };
  }
  clearTimeout(timer);

  const latencyMs = Math.round(performance.now() - started);
  const bodySnippet = firstLine(bodyText, 400);

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      model: opts.model,
      baseUrl: base,
      status,
      reason: "ok",
      latencyMs,
    };
  }

  // Classify by body first (Alibaba often uses 200/400 for quota with body code 2056)
  if (QUOTA_RE.test(bodyText) || status === 429) {
    return {
      ok: false,
      kind: "quota",
      model: opts.model,
      baseUrl: base,
      status,
      reason: `quota exhausted (status=${status}): ${bodySnippet}`,
      latencyMs,
    };
  }
  if (status === 401 || status === 403 || BAD_KEY_RE.test(bodyText)) {
    return {
      ok: false,
      kind: "bad-key",
      model: opts.model,
      baseUrl: base,
      status,
      reason: `key rejected (status=${status})`,
      latencyMs,
    };
  }
  if (status === 404 || BAD_MODEL_RE.test(bodyText)) {
    return {
      ok: false,
      kind: "bad-model",
      model: opts.model,
      baseUrl: base,
      status,
      reason: `model not found (status=${status}): ${bodySnippet}`,
      latencyMs,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      kind: "unreachable",
      model: opts.model,
      baseUrl: base,
      status,
      reason: `server error (status=${status}): ${bodySnippet}`,
      latencyMs,
    };
  }
  // Fallback: treat any other non-2xx as unreachable-ish
  return {
    ok: false,
    kind: "unreachable",
    model: opts.model,
    baseUrl: base,
    status,
    reason: `unexpected status ${status}: ${bodySnippet}`,
    latencyMs,
  };
}

/** Convert a failed PingResult into a matching LlmError (throw at boundary). */
export function pingToError(result: PingResult): LlmError {
  const kind = (result.kind ?? "unreachable") as LlmKind;
  return new LlmError(kind, result.reason, {
    baseUrl: result.baseUrl,
    model: result.model,
    status: result.status,
  });
}

export const HINT_LLM =
  "set QWEN_API_KEY/DASHSCOPE_API_KEY in .env or top up the Token Plan, then re-run";
