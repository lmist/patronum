import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Stagehand } from "@browserbasehq/stagehand";
import { classifyPage, dismissCookieBanner, dismissPostLoginModals, fillLoginForm, runLoginInSession, safePageUrl, submitEmailCheckpoint, waitForCheckpointFrames } from "./login.js";

describe("login fast path", () => {
  it("omits checkpoint tokens from diagnostic URLs", () => {
    assert.equal(safePageUrl("https://www.instagram.com/challenge/?token=private#secret"), "https://www.instagram.com/challenge/");
  });
  it("probes ready checkpoint controls without waiting for another lifecycle event", async () => {
    let lifecycleWaits = 0;
    const frame = { evaluate: async () => true, waitForLoadState: async () => { lifecycleWaits++; } };
    const page = {
      frames: () => [frame],
      waitForLoadState: async () => { lifecycleWaits++; },
    } as unknown as Parameters<typeof waitForCheckpointFrames>[0];
    await waitForCheckpointFrames(page);
    assert.equal(lifecycleWaits, 0);
  });
  it("does not ask the model about absent optional banners", async () => {
    const stagehand = {
      context: { pages: () => [{ evaluate: async () => false }] },
      observe: async () => { throw new Error("optional UI must not trigger inference"); },
      act: async () => { throw new Error("nothing to dismiss"); },
    } as unknown as Stagehand;
    // Record calls because optional handlers deliberately tolerate UI failures.
    let observations = 0;
    stagehand.observe = (async () => { observations++; return []; }) as Stagehand["observe"];
    await dismissCookieBanner(stagehand);
    await dismissPostLoginModals(stagehand);
    assert.equal(observations, 0);
  });

  it("fills known inputs with variables and submits exactly once without inference", async () => {
    const actions: unknown[] = [];
    let clicks = 0;
    const stagehand = {
      context: { pages: () => [{
        waitForSelector: async () => {},
        evaluate: async () => actions.length === 0
          ? { username: 'input[name="email"]', password: 'input[name="pass"]', submit: 2 }
          : 3,
        // Typing inserts a Show password button before Log in.
        locator: () => ({ nth: (index: number) => ({ click: async () => { assert.equal(index, 3); clicks++; } }) }),
        keyPress: async () => { throw new Error("must not submit twice"); },
      }] },
      observe: async () => { throw new Error("known form must not trigger inference"); },
      act: async (action: unknown, options: unknown) => { actions.push({ action, options }); return { success: true }; },
    } as unknown as Stagehand;
    await fillLoginForm(stagehand, { user: "fixture-user", pass: "fixture-pass" });
    assert.equal(actions.length, 2);
    assert.equal(clicks, 1);
    for (const entry of actions as Array<{ action: { method: string; arguments: string[] }; options: { variables: object } }>) {
      assert.equal(entry.action.method, "fill");
      assert.match(entry.action.arguments[0]!, /^%\w+%$/);
      assert.doesNotMatch(JSON.stringify(entry.action), /fixture-user|fixture-pass/);
    }
  });
});

function emailLoginFixture(initial: "login" | "checkpoint" = "login") {
  let state: "login" | "checkpoint" | "home" = initial;
  let filled = 0;
  let submittedAt = 0;
  let codeSubmits = 0;
  const url = () => `https://www.instagram.com/${state === "login" ? "accounts/login/" : state === "checkpoint" ? "auth_platform/codeentry/" : ""}`;
  const frame = {
    evaluate: async (_fn: unknown, selectors?: unknown) => selectors ? {
      controls: [{ index: 0, tag: "div", type: "", role: "button", text: "Continue" }],
      codeInputs: [{ selector: 'input[name="email"]', name: "email", type: "text", placeholder: "Code" }],
      mentionsEmail: true, mentionsAuthenticator: false, hasInteractivePuzzle: false,
    } : true,
    locator: () => ({ nth: () => ({ click: async () => { codeSubmits++; state = "home"; } }) }),
  };
  const page = {
    url, goto: async () => {}, waitForSelector: async () => {}, snapshot: async () => {},
    frames: () => [frame], frameForId: () => frame,
    getFullFrameTree: () => ({ frame: { id: "fixture", url: url() } }),
    evaluate: async (fn: unknown) => {
      if (typeof fn === "string") return { loginWall: false, loggedInShell: state === "home", user: "fixture-user" };
      if (state === "login") return filled === 0
        ? { username: 'input[name="username"]', password: 'input[name="password"]', submit: 0 }
        : 0;
      return false;
    },
    locator: () => ({ nth: () => ({ click: async () => { submittedAt = Date.now(); state = "checkpoint"; } }) }),
  };
  const stagehand = {
    context: { pages: () => [page] },
    act: async (action: { arguments: string[] }, options: { variables: Record<string, string> }) => {
      if (state === "checkpoint") {
        assert.deepEqual(action.arguments, ["%email_code%"]);
        assert.equal(options.variables.email_code, "123456");
      } else filled++;
      return { success: true };
    },
  } as unknown as Stagehand;
  return { stagehand, submittedAt: () => submittedAt, codeSubmits: () => codeSubmits };
}

describe("email checkpoint handoff", () => {
  it("recognizes navigation to the logged-in page during code-entry inspection", async () => {
    let url = "https://www.instagram.com/auth_platform/codeentry/";
    const frame = { evaluate: async (_fn: unknown, selectors?: unknown) => selectors ? {
      controls: [], codeInputs: [], mentionsEmail: false, mentionsAuthenticator: false, hasInteractivePuzzle: false,
    } : true };
    const page = {
      url: () => url,
      frames: () => [frame], frameForId: () => frame,
      snapshot: async () => { url = "https://www.instagram.com/accounts/onetap/"; },
      getFullFrameTree: () => ({ frame: { id: "fixture", url } }),
    };
    const stagehand = { context: { pages: () => [page] } } as unknown as Stagehand;
    assert.equal(await classifyPage(stagehand, url), "home");
  });

  it("uses the email sent by this login when code entry has no resend control", { timeout: 15_000 }, async () => {
    const f = emailLoginFixture();
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.AGENTMAIL_API_KEY;
    const previousAddress = process.env.AGENTMAIL_ADDRESS;
    let polls = 0;
    process.env.AGENTMAIL_API_KEY = "fixture-key";
    process.env.AGENTMAIL_ADDRESS = "fixture@example.test";
    globalThis.fetch = (async (input: string | URL | Request) => {
      polls++;
      const request = new URL(String(input));
      assert.equal(request.hostname, "api.agentmail.to");
      const since = Date.parse(request.searchParams.get("after")!);
      assert.ok(since <= f.submittedAt(), "email cutoff must precede the login submission");
      assert.ok(since >= f.submittedAt() - 5000, "must not search unrelated older emails");
      return Response.json({ messages: [{ message_id: "fixture", timestamp: new Date(f.submittedAt() + 1).toISOString(), from: "security@mail.instagram.com", subject: "Instagram security code 123456" }] });
    }) as typeof fetch;
    try {
      assert.equal(await runLoginInSession(f.stagehand, { user: "fixture-user", pass: "fixture-pass" }), "fixture-user");
      assert.equal(polls, 1);
      assert.equal(f.codeSubmits(), 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.AGENTMAIL_API_KEY; else process.env.AGENTMAIL_API_KEY = previousKey;
      if (previousAddress === undefined) delete process.env.AGENTMAIL_ADDRESS; else process.env.AGENTMAIL_ADDRESS = previousAddress;
    }
  });

  it("does not reuse an untracked email when opening an existing code-entry page", async () => {
    const f = emailLoginFixture("checkpoint");
    await assert.rejects(submitEmailCheckpoint(f.stagehand), /no fresh-code control/);
    assert.equal(f.codeSubmits(), 0);
  });
});
