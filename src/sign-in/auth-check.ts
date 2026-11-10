/**
 * Fail-closed Instagram auth assertion (no LLM).
 *
 * Called after the Stagehand session opens, after the target page loads,
 * and after detail navigation through the readiness wrapper. Explicit login
 * walls throw AuthError; an initially empty post is retried before declaring
 * an infrastructure failure. Existing profile checkpoints are preserved.
 */
import { classifyPageByUrl, safePageUrl } from "./login.js";

export type AuthEvidence = {
  ok: boolean;
  /** Best-guess account tag: viewer.username, ds_user_id:<n>, or expectedUser. */
  user?: string;
  /** Machine-readable reason for tests / logs. */
  reason?: string;
  /** classifyPageByUrl kind or "unknown". */
  state?: string;
};

export class AuthError extends Error {
  readonly code = "auth" as const;
  readonly state: string;
  readonly evidence: AuthEvidence;
  constructor(
    message: string,
    opts: { state: string; evidence: AuthEvidence },
  ) {
    super(message);
    this.name = "AuthError";
    this.state = opts.state;
    this.evidence = opts.evidence;
  }
}

/** Type-guard: is this err an AuthError we should exit 3 on? */
export function isAuthError(err: unknown): err is AuthError {
  return (
    err instanceof AuthError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "auth")
  );
}

type AuthCookie = {
  name: string;
  value: string;
  domain?: string;
};

export type AuthProbePage = {
  url: () => string;
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
  context?: () => {
    cookies?: (urls?: string | string[]) => Promise<AuthCookie[]>;
  };
};

type DomProbe = {
  loginWall: boolean;
  loggedInShell: boolean;
  user: string | null;
};

async function domProbe(page: AuthProbePage): Promise<DomProbe | null> {
  if (!page.evaluate) return null;
  try {
    return (await page.evaluate(`(() => {
      const q = (sel) => document.querySelector(sel);
      const anyLogInText = [...document.querySelectorAll('a, button, [role="button"]')]
        .some((el) => {
          const t = (el.textContent || el.getAttribute('aria-label') || '')
            .trim()
            .toLowerCase();
          return t === 'log in' || t === 'sign up';
        });
      const loginWall = !!(
        q('form#loginForm') ||
        q('input[name="username"]') ||
        q('input[type="password"]') ||
        q('input[name="password"]') ||
        q('a[href="/accounts/login/"]') ||
        anyLogInText
      );
      const loggedInShell = !!(
        q('nav a[href*="/direct/"]') ||
        q('a[href="/direct/inbox/"]') ||
        q('a[href*="/direct/inbox"]') ||
        q('svg[aria-label*="Direct" i]') ||
        q('svg[aria-label*="New post" i]') ||
        q('a[href*="/accounts/edit"]')
      );
      let user = null;
      try {
        const w = window;
        const sd = w && w._sharedData && w._sharedData.config && w._sharedData.config.viewer;
        if (sd && typeof sd.username === 'string') user = sd.username;
      } catch (_) { /* ignore */ }
      return { loginWall, loggedInShell, user };
    })()`)) as DomProbe;
  } catch {
    return null;
  }
}

async function cookieProbe(page: AuthProbePage): Promise<string | undefined> {
  const ctx = page.context?.();
  if (!ctx?.cookies) return undefined;
  try {
    const cookies = await ctx.cookies([
      "https://www.instagram.com",
      "https://instagram.com",
    ]);
    const hit = cookies.find(
      (c) =>
        c.name === "ds_user_id" &&
        (!c.domain || c.domain.includes("instagram.com")),
    );
    return hit?.value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assert the current page belongs to an authenticated Instagram session.
 *
 * Three cheap checks (no LLM):
 * 1. classifyPageByUrl(url) must not be login|totp|checkpoint.
 * 2. DOM login-wall markers absent.
 * 3. Logged-in shell present, or ds_user_id cookie on .instagram.com.
 *
 * Throws AuthError on failure. Returns AuthEvidence when ok.
 */
export async function assertAuthenticated(
  page: AuthProbePage,
  opts: { expectedUser?: string } = {},
): Promise<AuthEvidence> {
  const url = page.url();
  const kind = classifyPageByUrl(url);
  if (kind === "login" || kind === "totp" || kind === "checkpoint") {
    const evidence: AuthEvidence = {
      ok: false,
      reason: `url classified as ${kind}`,
      state: kind,
    };
    throw new AuthError(
      `auth failed: URL is ${kind} (${safePageUrl(url)})`,
      { state: kind, evidence },
    );
  }

  const dom = await domProbe(page);
  if (dom?.loginWall) {
    const evidence: AuthEvidence = {
      ok: false,
      reason: "login form / login-wall markers present in DOM",
      state: "login",
    };
    throw new AuthError(
      `auth failed: login wall visible (${safePageUrl(url)})`,
      { state: "login", evidence },
    );
  }

  const dsUserId = await cookieProbe(page);
  const loggedInByShell = !!dom?.loggedInShell;
  const loggedInByCookie = !!dsUserId;

  if (!loggedInByShell && !loggedInByCookie) {
    const evidence: AuthEvidence = {
      ok: false,
      reason:
        "no logged-in shell (nav/direct/edit) and no ds_user_id cookie on .instagram.com",
      state: kind ?? "unknown",
    };
    throw new AuthError(
      `auth failed: no logged-in evidence (${safePageUrl(url)})`,
      { state: kind ?? "unknown", evidence },
    );
  }

  const user =
    dom?.user ||
    opts.expectedUser ||
    (dsUserId ? `ds_user_id:${dsUserId}` : undefined);

  return {
    ok: true,
    user,
    reason: loggedInByShell
      ? "logged-in shell present"
      : "ds_user_id cookie present",
    state: kind ?? "home",
  };
}
