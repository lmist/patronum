import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Stagehand } from "@browserbasehq/stagehand";
import { openAuthenticatedSession } from "./session.js";

function fixture(initial: "warm" | "wall" | "unknown" | "checkpoint", loginSucceeds = true) {
  let state = initial;
  let submits = 0;
  let closes = 0;
  const page = {
    url: () => state === "checkpoint" ? "https://www.instagram.com/challenge/?token=secret" : "https://www.instagram.com/",
    goto: async () => {},
    evaluate: async () => ({ loginWall: state === "wall", loggedInShell: state === "warm", user: null }),
  };
  const browser = { init: async () => {}, close: async () => { closes++; }, context: { pages: () => [page] } };
  return {
    dependencies: {
      createStagehand: () => browser as unknown as Stagehand,
      wait: async () => {},
      runLoginInSession: async () => { submits++; if (loginSucceeds) state = "warm"; return "account"; },
    },
    counts: () => ({ submits, closes }),
  };
}
const account = { user: "account", pass: "unused" };

describe("saved-session scenarios", () => {
  it("warm session proves auth without submitting credentials and reports didLogin false", async () => {
    const f = fixture("warm");
    const result = await openAuthenticatedSession(account, {}, f.dependencies);
    assert.equal(result.loggedIn, true);
    assert.equal(result.didLogin, false);
    assert.deepEqual(f.counts(), { submits: 0, closes: 1 });
  });
  for (const state of ["wall", "unknown", "checkpoint"] as const) {
    it(`check-only fails closed for ${state} without credential submission`, async () => {
      const f = fixture(state);
      const result = await openAuthenticatedSession(account, { loginIfNeeded: false }, f.dependencies);
      assert.equal(result.loggedIn, false);
      assert.equal(result.didLogin, false);
      assert.doesNotMatch(result.detail, /token=secret/);
      assert.deepEqual(f.counts(), { submits: 0, closes: 1 });
    });
  }
  it("cold session logs in once, verifies the result, and closes once", async () => {
    const f = fixture("wall");
    const result = await openAuthenticatedSession(account, {}, f.dependencies);
    assert.equal(result.loggedIn, true);
    assert.equal(result.didLogin, true);
    assert.deepEqual(f.counts(), { submits: 1, closes: 1 });
  });
  it("login returning without authenticated evidence cannot report success", async () => {
    const f = fixture("wall", false);
    await assert.rejects(openAuthenticatedSession(account, {}, f.dependencies), /login wall/);
    assert.deepEqual(f.counts(), { submits: 1, closes: 1 });
  });
});
