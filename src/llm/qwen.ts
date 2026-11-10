/**
 * Which model to talk to.
 *
 * Reads the Qwen key, base URL and model name from the environment. The
 * browser driver, the readiness check and image verification all ask here.
 */
export const QWEN_MODEL_DEFAULT = "qwen3.8-max";
export const QWEN_BASE_URL_DEFAULT =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Qwen API key for Stagehand LLM calls (same family as cmd/iganalyze).
 * QWEN_API_KEY, DASHSCOPE_API_KEY, or ALIBABA_API_KEY.
 * Fails closed if none are present. MINIMAX_API_KEY / DEEPSEEK_API_KEY are never used.
 */
export function resolveQwenApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = firstNonEmpty(
    env.QWEN_API_KEY,
    env.DASHSCOPE_API_KEY,
    env.ALIBABA_API_KEY,
  );
  if (fromEnv) return fromEnv;

  throw new Error(
    "QWEN_API_KEY (or DASHSCOPE_API_KEY / ALIBABA_API_KEY) is not set — required for local Stagehand LLM calls",
  );
}

/** OpenAI-compatible Qwen chat base URL (Alibaba Token Plan). */
export function resolveQwenBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return firstNonEmpty(env.QWEN_BASE_URL) ?? QWEN_BASE_URL_DEFAULT;
}

/**
 * Stagehand modelName: OpenAI-compatible provider prefix + Qwen id.
 * `qwen3.8-max` → `openai/qwen3.8-max`. Already-prefixed names pass through.
 */
export function resolveQwenModelName(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = firstNonEmpty(env.QWEN_MODEL) ?? QWEN_MODEL_DEFAULT;
  return raw.includes("/") ? raw : `openai/${raw}`;
}
