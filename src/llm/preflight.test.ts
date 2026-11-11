import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  LlmError,
  apiModelId,
  isLlmError,
  isProviderError,
  pingLlm,
  pingToError,
} from "./preflight.js";

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ baseUrl: string; close: () => void }> {
  const server = Bun.serve({
    port: 0,
    fetch: handler,
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  };
}

async function findClosedPort(): Promise<number> {
  // Grab an ephemeral port from the OS, close it — nothing should be listening.
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("no addr"));
      }
    });
    srv.on("error", reject);
  });
}

describe("apiModelId", () => {
  for (const [input, expected] of [
    ["openai/qwen3.8-max", "qwen3.8-max"],
    ["qwen3.8-max", "qwen3.8-max"],
  ]) {
    it(`${input} → ${expected}`, () => {
      assert.equal(apiModelId(input), expected);
    });
  }
});

describe("pingLlm classification", () => {
  it("sends a bare API model id while reporting the Stagehand model name", async () => {
    const { baseUrl, close } = await withServer(async (req) => {
      const body = await req.json();
      assert.equal(body.model, "qwen3.8-max");
      assert.equal(body.max_tokens, 1);
      assert.equal(req.headers.get("authorization"), "Bearer sk-test");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    after(close);
    const res = await pingLlm({
      baseUrl,
      apiKey: "sk-test",
      model: "openai/qwen3.8-max",
    });
    assert.equal(res.ok, true);
    assert.equal(res.model, "openai/qwen3.8-max");
    assert.equal(res.status, 200);
    assert.equal(res.kind, undefined);
  });

  it("classifies 401 as bad-key without leaking the key", async () => {
    const { baseUrl, close } = await withServer(
      () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), {
          status: 401,
        }),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk-secret", model: "m" });
    assert.equal(res.ok, false);
    assert.equal(res.kind, "bad-key");
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.reason, /sk-secret/);
  });

  it("classifies 403 as bad-key", async () => {
    const { baseUrl, close } = await withServer(
      () => new Response("forbidden", { status: 403 }),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "m" });
    assert.equal(res.kind, "bad-key");
  });

  it("classifies 404 as bad-model", async () => {
    const { baseUrl, close } = await withServer(
      () =>
        new Response(
          JSON.stringify({ error: { code: "model_not_found" } }),
          { status: 404 },
        ),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "ghost" });
    assert.equal(res.kind, "bad-model");
  });

  it("classifies 429 as quota", async () => {
    const { baseUrl, close } = await withServer(
      () => new Response("rate limited", { status: 429 }),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "m" });
    assert.equal(res.kind, "quota");
  });

  it("classifies a 2056 Token Plan body as quota even on non-429 status", async () => {
    const { baseUrl, close } = await withServer(
      () =>
        new Response(
          JSON.stringify({
            code: "2056",
            message: "Token Plan usage limit reached",
          }),
          { status: 400 },
        ),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "m" });
    assert.equal(res.ok, false);
    assert.equal(res.kind, "quota");
    assert.match(res.reason, /2056|Token Plan|usage limit/i);
  });

  it("classifies 403 AccessDenied.Unpurchased as a plan problem, not a bad key", async () => {
    const { baseUrl, close } = await withServer(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Access to model denied. Please make sure you are eligible for using the model.",
              type: "AccessDenied.Unpurchased",
              code: "AccessDenied.Unpurchased",
            },
          }),
          { status: 403 },
        ),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "openai/m" });
    assert.equal(res.kind, "quota");
    assert.match(res.reason, /plan does not cover model m\b/);
    assert.match(res.reason, /AccessDenied\.Unpurchased/);
    assert.equal(isProviderError(new Error("403 AccessDenied.Unpurchased: Access to model denied"))?.kind, "quota");
  });

  it("classifies a closed port as unreachable", async () => {
    const port = await findClosedPort();
    const res = await pingLlm({
      baseUrl: `http://localhost:${port}`,
      apiKey: "sk",
      model: "m",
      timeoutMs: 2_000,
    });
    assert.equal(res.ok, false);
    assert.equal(res.kind, "unreachable");
    assert.equal(res.status, null);
  });

  it("classifies missing key as missing-key without doing any request", async () => {
    const res = await pingLlm({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "",
      model: "m",
      timeoutMs: 100,
    });
    assert.equal(res.kind, "missing-key");
    assert.equal(res.status, null);
    assert.equal(res.latencyMs, 0);
  });

  it("classifies 5xx as unreachable", async () => {
    const { baseUrl, close } = await withServer(
      () => new Response("boom", { status: 502 }),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "m" });
    assert.equal(res.kind, "unreachable");
    assert.equal(res.status, 502);
  });

  it("pingToError produces an LlmError with the matching kind", async () => {
    const { baseUrl, close } = await withServer(
      () => new Response("nope", { status: 401 }),
    );
    after(close);
    const res = await pingLlm({ baseUrl, apiKey: "sk", model: "m" });
    const err = pingToError(res);
    assert.ok(err instanceof LlmError);
    assert.equal(err.code, "llm");
    assert.equal(err.kind, "bad-key");
    assert.equal(isLlmError(err), true);
  });
});

describe("isProviderError table", () => {
  const cases: Array<{ err: unknown; kind: string; label: string }> = [
    {
      label: "401 Unauthorized string",
      err: new Error("Request failed: 401 Unauthorized"),
      kind: "bad-key",
    },
    {
      label: "2056 Token Plan usage limit",
      err: new Error("provider returned code 2056: Token Plan usage limit reached"),
      kind: "quota",
    },
    {
      label: "insufficient_quota body",
      err: new Error("openai insufficient_quota"),
      kind: "quota",
    },
    {
      label: "getaddrinfo ENOTFOUND",
      err: Object.assign(new Error("getaddrinfo ENOTFOUND api.qwen"), {
        code: "ENOTFOUND",
      }),
      kind: "unreachable",
    },
    {
      label: "ECONNREFUSED",
      err: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
        code: "ECONNREFUSED",
      }),
      kind: "unreachable",
    },
    {
      label: "429 status property",
      err: Object.assign(new Error("Too Many Requests"), { status: 429 }),
      kind: "quota",
    },
    {
      label: "model_not_found",
      err: new Error("the model qwen-ghost does not exist"),
      kind: "bad-model",
    },
    {
      label: "wrapped cause 401",
      err: Object.assign(new Error("Stagehand act failed"), {
        cause: new Error("HTTP 401 invalid api key"),
      }),
      kind: "bad-key",
    },
    {
      label: "socket hang up 5xx",
      err: Object.assign(new Error("Server 502 Bad Gateway"), { status: 502 }),
      kind: "unreachable",
    },
  ];

  for (const c of cases) {
    it(`matches: ${c.label} → ${c.kind}`, () => {
      const hit = isProviderError(c.err);
      assert.ok(hit, `expected LlmError, got null for: ${c.label}`);
      assert.equal(hit!.kind, c.kind);
    });
  }

  it("returns null for content-shape errors", () => {
    assert.equal(isProviderError(new Error("schema validation failed")), null);
    assert.equal(isProviderError(new Error("extract returned empty")), null);
    assert.equal(isProviderError(null), null);
    assert.equal(isProviderError(undefined), null);
  });

  it("recognises an already-thrown LlmError as itself", () => {
    const err = new LlmError("quota", "hit");
    assert.equal(isProviderError(err), err);
  });
});
