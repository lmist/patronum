import { expect, test } from "bun:test";
import sharp from "sharp";
import { createTileAgentsBackend, type TileAgentTiming } from "./tile-agents.js";
import { type GridObservation } from "./recognition.js";

const config = { baseUrl: "https://example.test/v1", apiKey: "test-only", model: "vision-test" };
async function observation(n: 3 | 4 = 3): Promise<GridObservation> {
  const pixels = Buffer.alloc(n * n * 3);
  for (let index = 0; index < n * n; index++) pixels[index * 3] = index * 10;
  const image = await sharp(pixels, { raw: { width: n, height: n, channels: 3 } }).png().toBuffer();
  return { id: "test", round: 0, capturedAt: new Date().toISOString(), gridSize: n, kind: n === 4 ? "squares" : "selection", target: "bicycles", image: { mimeType: "image/png", dataBase64: image.toString("base64") } };
}
function response(decision: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] })); }
function assigned(init: RequestInit) { return JSON.parse(JSON.parse(String(init.body)).messages[1].content[0].text).assignedIndex as number; }

test("one independent request per tile, exact numbered crops, bounded concurrency, negative decisions included", async () => {
  const seen: number[] = [];
  const timings: TileAgentTiming[] = [];
  let active = 0;
  let peak = 0;
  const backend = createTileAgentsBackend(config, { concurrency: 3, onTile: t => timings.push(t), fetcher: async (url, init) => {
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(init.redirect).toBe("error");
    const index = assigned(init);
    seen.push(index);
    peak = Math.max(peak, ++active);
    const body = JSON.parse(String(init.body));
    const cropUrl = body.messages[1].content[2].image_url.url;
    const crop = sharp(Buffer.from(cropUrl.split(",")[1], "base64"));
    expect((await crop.metadata()).width).toBe(512);
    expect((await crop.raw().toBuffer())[0]).toBe(index * 10);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return response({ match: [1, 5].includes(index), confidence: index === 8 ? 0.9 : 0.97 });
  } });
  const result = await backend.recognize(await observation(), new AbortController().signal);
  expect(result).toEqual({ selectedIndices: [1, 5], confidence: 0.9, abstain: false });
  expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(peak).toBe(3);
  expect(timings).toHaveLength(9);
  expect(timings.every(t => t.latencyMs >= 0)).toBe(true);
});

test("replacement only dispatches changed tiles and preserves original grid indices", async () => {
  const seen: number[] = [];
  const backend = createTileAgentsBackend(config, { fetcher: async (_, init) => { seen.push(assigned(init)); return response({ match: true, confidence: 0.99 }); } });
  const grid = await observation();
  const result = await backend.recognize({ ...grid, kind: "replacement", changedIndices: [8, 2] }, new AbortController().signal);
  expect(seen.sort()).toEqual([2, 8]);
  expect(result).toEqual({ selectedIndices: [2, 8], confidence: 0.99, abstain: false });
});

test("uncertain or low-confidence exclusions abstain the complete set", async () => {
  for (const decision of [{ match: false, confidence: 0.6 }, { match: false, confidence: 0.99, uncertain: true }]) {
    const backend = createTileAgentsBackend(config, { fetcher: async (_, init) => response(assigned(init) === 8 ? decision : { match: true, confidence: 0.99 }) });
    const result = await backend.recognize(await observation(), new AbortController().signal) as any;
    expect(result.abstain).toBe(true);
    expect(result.selectedIndices).toEqual([]);
    expect(result.reason).toBe("low-confidence");
  }
});

test("invalid decisions reject rather than silently treating missing or malformed tiles as exclusions", async () => {
  for (const invalid of [{ match: "yes", confidence: 0.99 }, { selectedIndices: [1], confidence: 0.99 }, { match: true, confidence: 1.2 }, { match: true, confidence: 0.99, unexpected: true }]) {
    const backend = createTileAgentsBackend(config, { fetcher: async () => response(invalid) });
    await expect(backend.recognize(await observation(), new AbortController().signal)).rejects.toMatchObject({ reason: "invalid-response" });
  }
});

test("deadline returns even if provider ignores abort, cancels in-flight calls, never starts queued calls", async () => {
  const signals: AbortSignal[] = [];
  const backend = createTileAgentsBackend(config, { concurrency: 2, timeoutMs: 100, fetcher: async (_, init) => { signals.push(init.signal!); return new Promise<Response>(() => {}); } });
  await expect(backend.recognize(await observation(), new AbortController().signal)).rejects.toMatchObject({ reason: "timeout" });
  expect(signals).toHaveLength(2);
  expect(signals.every(s => s.aborted)).toBe(true);
});

test("parent cancellation cancels active tile requests", async () => {
  const parent = new AbortController();
  const signals: AbortSignal[] = [];
  const backend = createTileAgentsBackend(config, { concurrency: 1, fetcher: async (_, init) => { signals.push(init.signal!); parent.abort(); return new Promise<Response>(() => {}); } });
  await expect(backend.recognize(await observation(), parent.signal)).rejects.toMatchObject({ reason: "timeout" });
  expect(signals).toHaveLength(1);
  expect(signals[0]!.aborted).toBe(true);
});

test("already canceled requests make no provider calls", async () => {
  let calls = 0;
  const backend = createTileAgentsBackend(config, { fetcher: async () => { calls++; return response({ match: false, confidence: 1 }); } });
  await expect(backend.recognize(await observation(), AbortSignal.abort())).rejects.toMatchObject({ reason: "timeout" });
  expect(calls).toBe(0);
});

test("truncated responses never count as valid decisions even with parseable JSON", async () => {
  const backend = createTileAgentsBackend(config, { fetcher: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: JSON.stringify({ match: true, confidence: 0.99 }) } }] })) });
  await expect(backend.recognize(await observation(), new AbortController().signal)).rejects.toMatchObject({ reason: "invalid-response" });
});

test("4x4 grid dispatches 16 independent decisions", async () => {
  const seen = new Set<number>();
  const backend = createTileAgentsBackend(config, { fetcher: async (_, init) => { seen.add(assigned(init)); return response({ match: false, confidence: 1 }); } });
  expect(await backend.recognize(await observation(4), new AbortController().signal)).toEqual({ selectedIndices: [], confidence: 1, abstain: false });
  expect(seen.size).toBe(16);
});

test("Qwen disables thinking for quick decisions; other providers receive no Qwen-only option", async () => {
  for (const model of ["qwen3.8-max", "vision-test"]) {
    const backend = createTileAgentsBackend({ ...config, model }, { fetcher: async (_, init) => {
      const body = JSON.parse(String(init.body));
      if (model.startsWith("qwen")) {
        expect(body.enable_thinking).toBe(false);
        expect(body.response_format).toEqual({ type: "json_object" });
      } else {
        expect(body).not.toHaveProperty("enable_thinking");
        expect(body).not.toHaveProperty("response_format");
      }
      expect(body.max_tokens).toBe(256);
      return response({ match: false, confidence: 1 });
    } });
    await backend.recognize(await observation(), new AbortController().signal);
  }
});
