/**
 * Shared helper: open local Stagehand, verify Instagram auth, login if needed.
 * Used by map / map-deep / notifications scrape scripts.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import type { Account } from "./accounts.js";
import { getAccount } from "./accounts.js";
import {
  createStagehand,
  resolveChromeProfileDir,
  sessionIdOf,
  sessionLiveUrl,
} from "../browser/stagehand.js";
import { runLoginInSession, safePageUrl } from "./login.js";
import { assertAuthenticated, isAuthError } from "./auth-check.js";

export type EnsuredSession = {
  account: Account;
  stagehand: Stagehand;
  sessionId: string;
  liveUrl: string;
  profileDir: string;
  didLogin: boolean;
  page: ReturnType<Stagehand["context"]["pages"]>[number];
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export type EnsureSessionOptions = {
  /** Label for log banners, e.g. "map", "notif", "deep" */
  label?: string;
  keepAlive?: boolean;
  headless?: boolean;
};

/**
 * Open a local authenticated Instagram session.
 * Caller owns stagehand.close().
 */
export async function ensureAuthenticatedSession(
  options: EnsureSessionOptions = {},
): Promise<EnsuredSession> {
  const label = options.label ?? "session";
  const account = getAccount();
  const profileDir = resolveChromeProfileDir();
  let didLogin = false;

  let stagehand = createStagehand({
    keepAlive: options.keepAlive,
    headless: options.headless,
  });
  await stagehand.init();
  let liveUrl = sessionLiveUrl(stagehand);
  let sessionId = sessionIdOf(stagehand);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ${label.toUpperCase()}  ·  @${account.user}`);
  console.log(`  local profile: ${profileDir}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  let page = stagehand.context.pages()[0]!;
  try {
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeoutMs: 45_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[${label}] nav wait: ${msg} (url=${safePageUrl(page.url())})`);
    if (!page.url() || page.url() === "about:blank") {
      await stagehand.close();
      throw err;
    }
  }
  await sleep(2500);

  try {
    await assertAuthenticated(page, { expectedUser: account.user });
    console.log(`[${label}] phase=verify outcome=authenticated didLogin=false`);
  } catch (err) {
    if (!isAuthError(err)) {
      await stagehand.close();
      throw err;
    }
    console.log(`[${label}] phase=verify outcome=unauthenticated state=${err.state}`);
    try {
      await runLoginInSession(stagehand, account);
      await assertAuthenticated(page, { expectedUser: account.user });
      didLogin = true;
    } catch (loginError) {
      await stagehand.close();
      throw loginError;
    }
  }

  return {
    account,
    stagehand,
    sessionId,
    liveUrl,
    profileDir,
    didLogin,
    page,
  };
}
