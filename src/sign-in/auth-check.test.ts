import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertAuthenticated,
  AuthError,
  isAuthError,
  type AuthProbePage,
} from "./auth-check.js";

type FakeShape = {
  url: string;
  dom?: { loginWall: boolean; loggedInShell: boolean; user?: string | null } | null;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
};

function makeFakePage(shape: FakeShape): AuthProbePage {
  const evalFn = shape.dom === null
    ? undefined
    : (async <R = unknown>(_fn: unknown): Promise<R> =>
        (shape.dom ?? {
          loginWall: false,
          loggedInShell: false,
          user: null,
        }) as unknown as R);
  return {
    url: () => shape.url,
    evaluate: evalFn,
    context: shape.cookies
      ? () => ({
          cookies: async () => shape.cookies!,
        })
      : undefined,
  };
}

describe("assertAuthenticated", () => {
  it("throws AuthError when URL is the login page", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/accounts/login/",
      dom: { loginWall: true, loggedInShell: false, user: null },
    });
    await assert.rejects(
      () => assertAuthenticated(page),
      (err: unknown) => {
        assert.ok(isAuthError(err));
        assert.equal((err as AuthError).code, "auth");
        assert.equal((err as AuthError).state, "login");
        return true;
      },
    );
  });

  it("throws AuthError when URL is a 2FA / TOTP page", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/accounts/login/two_factor/",
      dom: { loginWall: false, loggedInShell: false, user: null },
    });
    await assert.rejects(
      () => assertAuthenticated(page),
      (err: unknown) => {
        assert.ok(isAuthError(err));
        assert.equal((err as AuthError).state, "totp");
        return true;
      },
    );
  });

  it("throws AuthError when URL is a checkpoint / challenge", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/challenge/",
      dom: { loginWall: false, loggedInShell: false, user: null },
    });
    await assert.rejects(
      () => assertAuthenticated(page),
      (err: unknown) => {
        assert.ok(isAuthError(err));
        assert.equal((err as AuthError).state, "checkpoint");
        return true;
      },
    );
  });

  it("throws AuthError when URL is home but login-wall markers are present", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/",
      dom: { loginWall: true, loggedInShell: false, user: null },
    });
    await assert.rejects(
      () => assertAuthenticated(page),
      (err: unknown) => {
        assert.ok(isAuthError(err));
        assert.equal((err as AuthError).state, "login");
        assert.match((err as AuthError).evidence.reason ?? "", /login wall|login form/i);
        return true;
      },
    );
  });

  it("throws AuthError when URL is home but no logged-in evidence at all", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/",
      dom: { loginWall: false, loggedInShell: false, user: null },
    });
    await assert.rejects(
      () => assertAuthenticated(page),
      (err: unknown) => {
        assert.ok(isAuthError(err));
        assert.match((err as AuthError).evidence.reason ?? "", /no logged-in/i);
        return true;
      },
    );
  });

  it("returns ok when URL is home + a direct-inbox link is present", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/",
      dom: { loginWall: false, loggedInShell: true, user: "me" },
    });
    const ev = await assertAuthenticated(page);
    assert.equal(ev.ok, true);
    assert.equal(ev.state, "home");
    assert.equal(ev.user, "me");
  });

  it("returns ok when logged-in shell missing but ds_user_id cookie is present", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/someprofile/",
      dom: { loginWall: false, loggedInShell: false, user: null },
      cookies: [
        { name: "ds_user_id", value: "12345", domain: ".instagram.com" },
      ],
    });
    const ev = await assertAuthenticated(page, { expectedUser: "me" });
    assert.equal(ev.ok, true);
    assert.match(ev.reason ?? "", /ds_user_id/);
  });

  it("prefers viewer.username from DOM over expectedUser", async () => {
    const page = makeFakePage({
      url: "https://www.instagram.com/",
      dom: { loginWall: false, loggedInShell: true, user: "domuser" },
    });
    const ev = await assertAuthenticated(page, { expectedUser: "envuser" });
    assert.equal(ev.user, "domuser");
  });
});

describe("AuthError shape", () => {
  it("code is 'auth' and isAuthError recognises it", () => {
    const err = new AuthError("boom", {
      state: "login",
      evidence: { ok: false, reason: "x", state: "login" },
    });
    assert.equal(err.code, "auth");
    assert.equal(isAuthError(err), true);
    assert.equal(isAuthError(new Error("nope")), false);
    // Duck-typed
    assert.equal(isAuthError({ code: "auth" }), true);
  });
});
