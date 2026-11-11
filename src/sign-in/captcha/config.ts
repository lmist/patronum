import { access, constants } from "node:fs/promises";
import { inHome } from "../../paths.js";
import { visionEndpoint, type VisionConfig } from "./vision.js";
import { resolveModelId, resolveQwenApiKey, resolveQwenBaseUrl } from "../../llm/qwen.js";

type Environment = Record<string, string | undefined>;
export function localConfig(env: Environment = process.env) {
  return { python: inHome(env.CAPTCHA_LOCAL_PYTHON || "data/captcha/venv/bin/python"), modelPath: inHome(env.CAPTCHA_LOCAL_MODEL || "data/captcha/models/recaptcha_classification_57k.onnx") };
}
export function visionConfig(env: Environment = process.env): VisionConfig {
  if (hasCustomVisionConfig(env)) return { baseUrl: env.CAPTCHA_VISION_BASE_URL || "", apiKey: env.CAPTCHA_VISION_API_KEY || "", model: env.CAPTCHA_VISION_MODEL || "" };
  let apiKey = "";
  try { apiKey = resolveQwenApiKey(env); } catch {}
  return { baseUrl: resolveQwenBaseUrl(env), apiKey, model: resolveModelId("vision", env as NodeJS.ProcessEnv) };
}
function hasCustomVisionConfig(env: Environment): boolean {
  return [env.CAPTCHA_VISION_BASE_URL, env.CAPTCHA_VISION_API_KEY, env.CAPTCHA_VISION_MODEL].some(value => value !== undefined);
}
export async function captchaReadiness(env: Environment = process.env) {
  const local = localConfig(env);
  let available = false;
  try { await Promise.all([access(local.python, constants.X_OK), access(local.modelPath, constants.R_OK)]); available = true; } catch {}
  let configured = false;
  const vision = visionConfig(env);
  try { visionEndpoint(vision); configured = true; } catch {}
  return {
    mode: "recognition-only" as const, automaticSubmission: false as const,
    login: { mode: "per-tile", automaticSubmission: configured, maxParallel: 16 },
    local: { configured: available, available, reason: available ? "assets-present" : "missing-local-assets", checked: "files-only", grids: [3] },
    vision: { configured, reason: configured ? "configured-unverified" : "missing-or-invalid-vision-config", source: hasCustomVisionConfig(env) ? "custom" : "qwen", ...(configured ? { baseUrl: vision.baseUrl, model: vision.model } : {}), grids: [3, 4] },
  };
}
