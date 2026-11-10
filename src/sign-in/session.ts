import type { Account } from "./accounts.js";
import {
  createStagehand,
  resolveChromeProfileDir,
  sessionIdOf,
  sessionLiveUrl,
} from "../browser/stagehand.js";
import { runLoginInSession, safePageUrl } from "./login.js";
import { assertAuthenticated, isAuthError } from "./auth-check.js";

export type SessionCheckResult = {
  sessionId: string;
  liveUrl: string;
  profileDir: string;
  loggedIn: boolean;
  detail: string;
  didLogin: boolean;
};

/**
 * Open a local Chrome session with the persisted profile and verify Instagram auth.
 * If not logged in, runs the full login flow first.
 * Warm path proves authentication from page evidence without submitting credentials.
 */
export async function openAuthenticatedSession(
  account: Account,
  options: { loginIfNeeded?: boolean } = {},
  dependencies = { createStagehand, runLoginInSession, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) },
): Promise<SessionCheckResult> {
  const loginIfNeeded = options.loginIfNeeded ?? true;
  const profileDir = resolveChromeProfileDir();

  const stagehand = dependencies.createStagehand();
  const started = Date.now();
  try {
    console.log("[session] phase=browser outcome=started");
    await stagehand.init();
    console.log(`[session] phase=browser outcome=ready elapsedMs=${Date.now() - started}`);
    const liveUrl = sessionLiveUrl(stagehand);
    const sessionId = sessionIdOf(stagehand);

    console.log(`[session] local profile: ${profileDir}`);

    const page = stagehand.context.pages()[0]!;
    console.log("[session] phase=navigate outcome=started");
    try {
      await page.goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
        timeoutMs: 45_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[session] navigation wait: ${msg} (url=${safePageUrl(page.url())})`,
      );
      if (!page.url() || page.url() === "about:blank") {
        throw err;
      }
    }

    console.log(`[session] phase=navigate outcome=loaded elapsedMs=${Date.now() - started} url=${safePageUrl(page.url())}`);
    await dependencies.wait(2000);

    let loggedIn = false;
    let detail = "";
    let didLogin = false;
    try {
      const evidence = await assertAuthenticated(page, { expectedUser: account.user });
      loggedIn = true;
      detail = evidence.reason ?? "Authenticated";
      console.log(`[session] phase=verify outcome=authenticated didLogin=false`);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      detail = err.message;
      console.log(`[session] phase=verify outcome=unauthenticated state=${err.state}`);
      if (loginIfNeeded) {
        console.log("[session] phase=login outcome=started");
        await dependencies.runLoginInSession(stagehand, account);
        await assertAuthenticated(page, { expectedUser: account.user });
        loggedIn = true;
        didLogin = true;
        detail = "Authenticated after login";
      }
    }

    console.log(
      loggedIn
        ? `[session] authenticated — ${detail}`
        : `[session] NOT authenticated — ${detail}`,
    );

    return {
      sessionId,
      liveUrl,
      profileDir,
      loggedIn,
      detail,
      didLogin,
    };
  } finally {
    await stagehand.close();
    console.log(`[session] phase=browser outcome=closed elapsedMs=${Date.now() - started}`);
  }
}
