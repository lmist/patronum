import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import { Stagehand, type LLMClient } from "@browserbasehq/stagehand";
import {
  createStagehand,
  resolveAuthCacheDir,
  resolveChromeProfileDir,
  browserInferenceFetch,
} from "./stagehand.js";
import {
  resolveQwenApiKey,
  resolveQwenBaseUrl,
  resolveQwenModelName,
  QWEN_BASE_URL_DEFAULT,
  QWEN_MODEL_DEFAULT,
} from "../llm/qwen.js";

import { DATA_HOME, REPO_ROOT } from "../paths.js";
const root = REPO_ROOT;
const factorySrc = ["src/browser/stagehand.ts", "src/llm/qwen.ts"].map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void,
): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("Stagehand Qwen factory", () => {
  it("aborts a browser inference response that stalls mid-stream", async () => {
    const server=Bun.serve({port:0,fetch:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("partial"));}}))});
    try {
      await assert.rejects(async()=>{
        const response=await browserInferenceFetch(`http://127.0.0.1:${server.port}`,undefined,50);
        await response.text();
      });
    } finally {await server.stop(true);}
  });
  it("closes a failed local init and preserves its transport error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patronum-stagehand-init-"));
    const failure = new Error("CDP transport unavailable");
    const originalInit = Stagehand.prototype.init;
    const originalClose = Stagehand.prototype.close;
    let closes = 0;
    let stagehand!: Stagehand;
    try {
      Stagehand.prototype.init = async () => { throw failure; };
      Stagehand.prototype.close = async () => { closes++; };
      withEnv({ QWEN_API_KEY: "fixture-key" }, () => {
        stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache") });
      });
    } finally {
      Stagehand.prototype.init = originalInit;
      Stagehand.prototype.close = originalClose;
    }
    try {
      assert.equal(
        (stagehand as unknown as { opts: { localBrowserLaunchOptions: { connectTimeoutMs: number } } })
          .opts.localBrowserLaunchOptions.connectTimeoutMs,
        60_000,
      );
      await assert.rejects(stagehand.init(), (error) => error === failure);
      assert.equal(closes, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends structured browser inference to chat/completions, like preflight", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        paths.push(new URL(request.url).pathname);
        const body = await request.json() as { model: string; messages: Array<{ role: string }> };
        assert.equal(body.model, "qwen3.8-max");
        assert.equal(body.messages[0]?.role, "system");
        // Reproduce the observed Responses endpoint schema failure.
        if (!request.url.endsWith("/chat/completions")) {
          return Response.json({ error: { message: "Wrong inference endpoint" } }, { status: 400 });
        }
        return Response.json({
          id: "fixture", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: '{"elements":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    let client!: LLMClient;
    withEnv({ QWEN_API_KEY: "fixture-key", QWEN_MODEL: "qwen3.8-max", QWEN_BASE_URL: `http://localhost:${server.port}/v1` }, () => {
      client = (createStagehand() as unknown as { llmClient: LLMClient }).llmClient;
    });
    try {
      const result = await client.createChatCompletion({
        options: {
          messages: [
            { role: "system", content: "Find elements and follow the response schema." },
            { role: "user", content: "Find cookie buttons. Return an empty array when absent." },
          ],
          response_model: { name: "buttons", schema: z.object({ elements: z.array(z.string()) }) },
        },
        logger: () => {},
      });
      assert.deepEqual(result.data, { elements: [] });
    } finally {
      server.stop(true);
      assert.deepEqual(paths, ["/v1/chat/completions"]);
    }
  });
  it("resolveQwenApiKey reads QWEN_API_KEY and ignores MiniMax/DeepSeek", () => {
    const key = resolveQwenApiKey({
      QWEN_API_KEY: "qwen-from-env",
      MINIMAX_API_KEY: "mmx-ignored",
      DEEPSEEK_API_KEY: "ds-ignored",
    });
    assert.equal(key, "qwen-from-env");
  });

  it("resolveQwenApiKey falls back to DASHSCOPE_API_KEY", () => {
    const key = resolveQwenApiKey({
      DASHSCOPE_API_KEY: "dash-from-env",
      MINIMAX_API_KEY: "mmx-ignored",
    });
    assert.equal(key, "dash-from-env");
  });

  it("resolveQwenApiKey throws when Qwen creds are absent", () => {
    assert.throws(
      () =>
        resolveQwenApiKey({
          MINIMAX_API_KEY: "mmx-only",
          DEEPSEEK_API_KEY: "ds-only",
        }),
      /QWEN_API_KEY/,
    );
  });

  it("resolveQwenModelName prefixes openai/ and honors QWEN_MODEL", () => {
    assert.equal(resolveQwenModelName({}), `openai/${QWEN_MODEL_DEFAULT}`);
    assert.equal(
      resolveQwenModelName({ QWEN_MODEL: "qwen3.8-max" }),
      "openai/qwen3.8-max",
    );
    assert.equal(
      resolveQwenModelName({ QWEN_MODEL: "openai/qwen-plus" }),
      "openai/qwen-plus",
    );
  });

  it("resolveQwenBaseUrl defaults to Alibaba Token Plan", () => {
    assert.equal(resolveQwenBaseUrl({}), QWEN_BASE_URL_DEFAULT);
    assert.equal(
      resolveQwenBaseUrl({ QWEN_BASE_URL: "https://example.test/v1" }),
      "https://example.test/v1",
    );
  });

  it("createStagehand constructs with Qwen creds only (no MINIMAX_API_KEY)", () => {
    withEnv(
      {
        QWEN_API_KEY: "test-qwen-not-real",
        MINIMAX_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        MODEL_API_KEY: undefined,
        MMX_API_KEY: undefined,
      },
      () => {
        const sh = createStagehand();
        assert.equal(typeof sh.init, "function");
      },
    );
  });

  it("createStagehand throws when Qwen creds are absent", () => {
    withEnv(
      {
        QWEN_API_KEY: undefined,
        DASHSCOPE_API_KEY: undefined,
        ALIBABA_API_KEY: undefined,
        MINIMAX_API_KEY: "mmx-should-not-count",
        MMX_API_KEY: undefined,
        DEEPSEEK_API_KEY: "ds-should-not-count",
        MODEL_API_KEY: undefined,
      },
      () => {
        assert.throws(() => createStagehand(), /QWEN_API_KEY/);
      },
    );
  });

  it("factory source pins Qwen Token Plan, not MiniMax or deepseek", () => {
    assert.match(factorySrc, /QWEN_API_KEY/);
    assert.match(factorySrc, /qwen3\.8-max|token-plan\.ap-southeast-1/);
    assert.doesNotMatch(factorySrc, /MiniMax-M3/);
    assert.doesNotMatch(factorySrc, /api\.minimax\.io/);
    assert.doesNotMatch(factorySrc, /deepseek\/deepseek-v4-pro/);
    assert.doesNotMatch(factorySrc, /env:\s*"DEEPSEEK/);
  });
});

describe("isolated auth paths", () => {
  it("uses dedicated profile and cache without changing explicit paths", () => {
    withEnv({ PATRONUM_CHROME_PROFILE_DIR: "data/e2e/profile", PATRONUM_AUTH_CACHE_DIR: "cache/e2e/auth" }, () => {
      assert.equal(resolveChromeProfileDir(), resolve(DATA_HOME, "data/e2e/profile"));
      assert.equal(resolveAuthCacheDir(), resolve(DATA_HOME, "cache/e2e/auth"));
      assert.equal(resolveChromeProfileDir("data/explicit"), resolve(DATA_HOME, "data/explicit"));
    });
  });
});
