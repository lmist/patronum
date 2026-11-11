/**
 * Which model to talk to.
 *
 * Any OpenAI-compatible endpoint works: a provider, or a router in front of
 * many. One key and one base URL; one model per role, because the three jobs
 * need different things:
 *
 *   browser  drive Chrome (Stagehand act/observe/extract): text, structured output
 *   vision   read sign-in image puzzles: image input
 *   video    describe collected media: image input and video input
 *
 *   LLM_API_KEY, LLM_BASE_URL
 *   LLM_MODEL                 the model for every role, unless a role names its own
 *   LLM_MODEL_BROWSER, LLM_MODEL_VISION, LLM_MODEL_VIDEO
 *   LLM_VIDEO_FORMAT          how a video is attached: video_url | file | image_url
 *
 * The older QWEN_API_KEY (DASHSCOPE_API_KEY, ALIBABA_API_KEY), QWEN_BASE_URL
 * and QWEN_MODEL are read when the LLM_* name is unset. cmd/iganalyze reads the same
 * names for the video role.
 */
export const QWEN_MODEL_DEFAULT = "qwen3.8-max";
export const QWEN_BASE_URL_DEFAULT =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export type ModelRole = "browser" | "vision" | "video";
export const MODEL_ROLES: ModelRole[] = ["browser", "vision", "video"];
/** video_url: Qwen native. file: an OpenAI file part (Gemini through routers). image_url: a video data URL in an image part. */
export type VideoFormat = "video_url" | "file" | "image_url";
export const VIDEO_FORMATS: VideoFormat[] = ["video_url", "file", "image_url"];
export const API_KEY_NAMES = ["LLM_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY"];

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
  const fromEnv = firstNonEmpty(...API_KEY_NAMES.map((name) => env[name]));
  if (fromEnv) return fromEnv;

  throw new Error(
    "LLM_API_KEY (or QWEN_API_KEY) is not set — required for every model call",
  );
}

/** OpenAI-compatible Qwen chat base URL (Alibaba Token Plan). */
export function resolveQwenBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return firstNonEmpty(env.LLM_BASE_URL, env.QWEN_BASE_URL) ?? QWEN_BASE_URL_DEFAULT;
}

/** The provider's model id for a role, exactly as the API expects it. */
export function resolveModelId(
  role: ModelRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    firstNonEmpty(env[`LLM_MODEL_${role.toUpperCase()}`], env.LLM_MODEL, env.QWEN_MODEL) ??
    QWEN_MODEL_DEFAULT;
  return raw.replace(/^openai\//i, "");
}

/**
 * Stagehand modelName for a role: always `openai/<id>`, so Stagehand treats
 * it as an OpenAI-compatible model whatever the id looks like
 * (`qwen3.8-max`, `claude/claude-haiku-5-5`, ...).
 */
export function resolveQwenModelName(
  env: NodeJS.ProcessEnv = process.env,
  role: ModelRole = "browser",
): string {
  return `openai/${resolveModelId(role, env)}`;
}

/**
 * How to attach a video. Qwen's own endpoint takes `video_url`; other
 * endpoints get a `file` part unless LLM_VIDEO_FORMAT says otherwise.
 */
export function resolveVideoFormat(env: NodeJS.ProcessEnv = process.env): VideoFormat {
  const set = firstNonEmpty(env.LLM_VIDEO_FORMAT)?.toLowerCase();
  if (set) {
    if (!(VIDEO_FORMATS as string[]).includes(set)) throw new Error(`LLM_VIDEO_FORMAT must be one of ${VIDEO_FORMATS.join(", ")}; got "${set}"`);
    return set as VideoFormat;
  }
  return /aliyuncs\.com|dashscope/i.test(resolveQwenBaseUrl(env)) ? "video_url" : "file";
}
