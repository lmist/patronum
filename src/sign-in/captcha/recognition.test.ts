import { describe, expect, test } from "bun:test";
import { RecognitionSession, type GridObservation, type RecognitionBackend } from "./recognition.js";
import { createVisionBackend } from "./vision.js";
import { captchaReadiness, visionConfig } from "./config.js";
import { createLocalBackend } from "./local.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=";
export const observation = (overrides: Partial<GridObservation> = {}): GridObservation => ({
  id: "fixture-1", round: 0, capturedAt: new Date().toISOString(), gridSize: 3,
  kind: "selection", target: "buses", image: { mimeType: "image/png", dataBase64: png }, ...overrides,
});
const backend = (value: unknown): RecognitionBackend => ({ name: "fixture", recognize: async () => value });

describe("recognition boundary", () => {
  test("returns sorted zero-based proposals tied to the observation", async () => {
    const result = await new RecognitionSession(backend({ selectedIndices: [8, 0], confidence: 0.96 })).recognize(observation());
    expect(result).toMatchObject({ status: "proposed", selectedIndices: [0, 8], observationId: "fixture-1", round: 0 });
  });
  test.each([{ selectedIndices: [9] }, { selectedIndices: [-1] }, { selectedIndices: [1.5] }, { selectedIndices: [1, 1] }, { selectedIndices: ["1"] }])("rejects invalid model indices %j", async ({ selectedIndices }) => {
    const result = await new RecognitionSession(backend({ selectedIndices, confidence: 0.99 })).recognize(observation());
    expect(result).toMatchObject({ status: "error", reason: "invalid-response", selectedIndices: [] });
  });
  test("abstains on uncertainty and explicit model abstention", async () => {
    for (const value of [{ selectedIndices: [1], confidence: 0.5 }, { selectedIndices: [], confidence: 0.99, abstain: true }]) {
      expect((await new RecognitionSession(backend(value)).recognize(observation())).status).toBe("abstained");
    }
  });
  test("replacement decisions cannot refer to unchanged tiles", async () => {
    const result = await new RecognitionSession(backend({ selectedIndices: [2], confidence: 0.99 })).recognize(observation({ kind: "replacement", changedIndices: [1], round: 1 }));
    expect(result.reason).toBe("invalid-response");
  });
  test("rejects duplicate observations and enforces round limits", async () => {
    let calls = 0;
    const session = new RecognitionSession({ name: "fixture", recognize: async () => { calls++; return { selectedIndices: [], confidence: 0.99 }; } }, { maxRounds: 1 });
    await session.recognize(observation());
    expect((await session.recognize(observation({ id: "fixture-2", round: 1 }))).reason).toBe("round-limit");
    expect(calls).toBe(1);
  });
  test("rejects duplicate and out-of-order observations before a second call", async () => {
    let calls = 0;
    const session = new RecognitionSession({ name: "fixture", recognize: async () => { calls++; return { selectedIndices: [], confidence: 0.99 }; } });
    await session.recognize(observation({ round: 2 }));
    expect((await session.recognize(observation({ round: 3 }))).reason).toBe("stale-observation");
    expect((await session.recognize(observation({ id: "another", round: 1 }))).reason).toBe("stale-observation");
    expect(calls).toBe(1);
  });
  test("accepts index 15 only for a 4x4 grid", async () => {
    const result = await new RecognitionSession(backend({ selectedIndices: [15], confidence: 0.95 })).recognize(observation({ gridSize: 4, kind: "squares" }));
    expect(result).toMatchObject({ status: "proposed", selectedIndices: [15] });
  });
  test("local 4x4 explicitly abstains without launching inference", async () => {
    const result = await new RecognitionSession(createLocalBackend({ python: "/missing-python", modelPath: "/missing-model" })).recognize(observation({ gridSize: 4, kind: "squares" }));
    expect(result).toMatchObject({ status: "abstained", reason: "unsupported-grid" });
  });
  test("missing local runtime returns a fixed manual fallback", async () => {
    const result = await new RecognitionSession(createLocalBackend({ python: "/missing-python", modelPath: "/missing-model" })).recognize(observation());
    expect(result).toMatchObject({ status: "abstained", reason: "model-unavailable" });
  });
  test("bounds even a backend that ignores cancellation", async () => {
    const session = new RecognitionSession({ name: "fixture", recognize: () => new Promise(() => {}) }, { timeoutMs: 20 });
    expect((await session.recognize(observation())).reason).toBe("timeout");
  });
  test("rejects missing images without invoking the backend", async () => {
    expect((await new RecognitionSession(backend({})).recognize(observation({ image: { mimeType: "image/png", dataBase64: "" } }))).reason).toBe("invalid-observation");
  });
  test("diagnostics omit image content, prompts, backend exceptions and secrets", async () => {
    const result = await new RecognitionSession({ name: "fixture", recognize: async () => { throw new Error("secret-token data:image/png"); } }).recognize(observation());
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain(png);
    expect(result.timestamp).toMatch(/^\d{4}-/);
  });
});

describe("vision transport", () => {
  test("sends actual image data with structured output instructions", async () => {
    let request: any;
    const vision = createVisionBackend({ baseUrl: "https://vision.example/v1", apiKey: "own-key", model: "vision-model" }, async (_url, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ selectedIndices: [0], confidence: 0.95 }) } }] }));
    });
    expect((await new RecognitionSession(vision).recognize(observation())).status).toBe("proposed");
    expect(request.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${png}`, detail: "high" } });
    expect(request.model).toBe("vision-model");
  });
  test("does not follow redirects or expose remote error bodies", async () => {
    let redirect: unknown;
    const vision = createVisionBackend({ baseUrl: "https://vision.example/v1", apiKey: "own-key", model: "vision-model" }, async (_url, init) => { redirect = init?.redirect; return new Response("secret", { status: 401 }); });
    const result = await new RecognitionSession(vision).recognize(observation());
    expect(result.reason).toBe("unauthorized");
    expect(redirect).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  test("never inherits Qwen credentials into another endpoint", async () => {
    const status = await captchaReadiness({ QWEN_API_KEY: "secret", CAPTCHA_VISION_BASE_URL: "https://example.com/v1", CAPTCHA_VISION_MODEL: "vision" });
    expect(status.vision.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status.automaticSubmission).toBe(false);
  });
  test("uses the authorized existing Qwen destination by default", async () => {
    const env = { QWEN_API_KEY: "existing-key", QWEN_BASE_URL: "https://existing.example/v1", QWEN_MODEL: "openai/qwen3.8-max" };
    expect(visionConfig(env)).toEqual({ apiKey: "existing-key", baseUrl: "https://existing.example/v1", model: "qwen3.8-max" });
    const status = await captchaReadiness(env);
    expect(status.vision).toMatchObject({ configured: true, source: "qwen", model: "qwen3.8-max" });
    expect(JSON.stringify(status)).not.toContain("existing-key");
  });
});
