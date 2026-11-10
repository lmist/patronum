/**
 * Step 1: open the profile and confirm we are allowed in.
 *
 * Prove the session is still signed in, close cookie banners and other
 * pop-ups, and click known profile controls.
 * Hands the next step a profile page that is ready to read.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { assertAuthenticated, AuthError, isAuthError, type AuthProbePage } from "../sign-in/auth-check.js";
import {
  clickMappedProfileAction,
  clickOptionalProfileControl,
  InstagramUiMap,
  type MappedPage,
  type ProfileAction,
} from "../api-map/ui-map.js";
import { ACT_DISMISS_OVERLAY, OBSERVE_COOKIE_OR_LOGIN_WALL } from "./prompts.js";
import { sleep, noteLlmError, optionalModel, timedPhase } from "./pacing.js";
import type { DetailPage } from "./browser-page.js";

/** Preserve transport failures as retryable errors; only login-state evidence is auth. */
import { assertProfileNavigationResponse, httpRejection } from "./rejections.js";
import type { CollectRun } from "./run.js";

export function classifyEnsureSessionError(err: unknown): Error {
  if (isAuthError(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const state = /state=(totp|checkpoint|login|home|unknown)/i.exec(msg)?.[1]?.toLowerCase();
  if (!state) return err instanceof Error ? err : new Error(msg);
  return new AuthError(`ensure-session failed: ${msg}`, {
    state,
    evidence: { ok: false, reason: `ensure-session failed: ${msg}`, state },
  });
}

/** Stagehand Page has no context() method; give every auth probe the browser
 * context cookie source used by the already-verified session. */
export function stagehandAuthProbe(
  stagehand: Stagehand,
  page: { url: () => string; evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R> },
): AuthProbePage {
  return {
    url: () => page.url(),
    evaluate: page.evaluate?.bind(page),
    context: () => ({ cookies: (urls) => stagehand.context.cookies(urls) }),
  };
}

/** A newly navigated page may have an empty body before its auth shell mounts.
 * Retry only the evidence-free unknown state; explicit walls fail immediately. */
export async function assertDetailAuthenticated(
  page: AuthProbePage,
  timeoutMs = 25_000,
  pollMs = 500,
  expectedUser?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertAuthenticated(page, { expectedUser });
      return;
    } catch (err) {
      if (!isAuthError(err) || err.state !== "unknown" ||
          !err.evidence?.reason?.includes("no logged-in shell")) throw err;
      if (Date.now() >= deadline) {
        throw new Error(`auth evidence did not hydrate within ${timeoutMs}ms (${page.url()})`);
      }
      await sleep(pollMs);
    }
  }
}

export type OptionalControls = { blocker: boolean; bioMore: boolean };

/** Check the visible page first: absent optional UI requires zero model calls. */
export async function inspectOptionalControls(page: {
  evaluate?: <R = unknown>(expression: string) => Promise<R>;
}): Promise<OptionalControls> {
  if (!page.evaluate) return { blocker: false, bioMore: false };
  try {
    return await page.evaluate(`(() => {
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 4 && box.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')];
      const blocker = dialogs.some(visible) || [...document.querySelectorAll('button, [role="button"]')].some((el) => {
        if (!visible(el)) return false;
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return /^(accept all cookies|allow all cookies|accept cookies)$/.test(label);
      });
      const bioMore = [...document.querySelectorAll('header button, header [role="button"]')].some((el) => {
        if (!visible(el)) return false;
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return /^(more|see more|read more)$/.test(label);
      });
      return { blocker, bioMore };
    })()`);
  } catch {
    return { blocker: false, bioMore: false };
  }
}

export async function observeActFirst(
  stagehand: Stagehand,
  observeInstruction: string,
  actFallback?: string,
  page?: DetailPage,
  cached?: { map: InstagramUiMap; action: ProfileAction; handle: string },
): Promise<boolean> {
  const pageOpt = page ? { page: page as never } : undefined;
  const target = (page ?? stagehand.context.pages()[0]) as MappedPage;
  if (cached && await clickMappedProfileAction(target, cached.map, cached.action, cached.handle)) {
    console.log(`[scrape] control ${cached.action}: cached locator`);
    return true;
  }
  try {
    const found = await optionalModel(`observe:${cached?.action ?? "control"}`, () => stagehand.observe(observeInstruction, pageOpt));
    if (found.length > 0) {
      if (cached) {
        for (const action of found) {
          cached.map.remember(cached.action, action.selector, cached.handle);
          if (await clickMappedProfileAction(target, cached.map, cached.action, cached.handle)) {
            console.log(`[scrape] control ${cached.action}: learned locator`);
            return true;
          }
        }
        console.log(`[scrape] control ${cached.action}: observed targets failed semantic validation`);
        return false;
      }
      console.log(
        `[scrape] observe hit (${found.length}): acting first match`,
      );
      await stagehand.act(found[0]!, pageOpt);
      await sleep(1800);
      return true;
    }
  } catch (err) {
    // noteLlmError() rethrows provider errors → top-level exit 4.
    console.log(`[scrape] observe failed: ${noteLlmError(err)}`);
  }
  if (actFallback && !cached) {
    try {
      await stagehand.act(actFallback, pageOpt);
      await sleep(1800);
      return true;
    } catch (err) {
      console.log(`[scrape] act fallback failed: ${noteLlmError(err)}`);
    }
  }
  return false;
}

export async function dismissBlockingUi(stagehand: Stagehand, map: InstagramUiMap, handle: string): Promise<void> {
  const page = stagehand.context.pages()[0];
  const controls = await inspectOptionalControls(page);
  if (!controls.blocker) {
    console.log("[scrape] optional blocker absent; skip observe");
    return;
  }
  if (await clickOptionalProfileControl(page as MappedPage, map, "dismiss", handle)) {
    console.log("[scrape] optional blocker dismissed via locator");
    return;
  }
  await observeActFirst(
    stagehand,
    OBSERVE_COOKIE_OR_LOGIN_WALL,
    ACT_DISMISS_OVERLAY,
    undefined,
    { map, action: "dismiss", handle },
  );
}

/** Go to the profile, close anything in the way, and check twice that we are signed in. */
export async function openProfile(run: CollectRun): Promise<void> {
  const { stagehand, page, session, url, handle, uiMap } = run;
  // Fail-closed auth check #1: session opened, no target page yet.
  await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page), 25_000, 500, session.account.user);
  console.log(`[scrape] navigating to ${url}`);
  try {
    const response = await timedPhase("navigate:profile", () => page.goto(url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 60_000,
    }));
    assertProfileNavigationResponse(response, url);
  } catch (err) {
    const rejection = httpRejection(url, err, page);
    if (rejection) throw rejection;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[scrape] nav wait: ${msg} (url=${page.url()})`);
    if (!page.url() || page.url() === "about:blank") throw err;
  }
  await sleep(3000);
  await timedPhase("optional:overlay", () => dismissBlockingUi(stagehand, uiMap, handle));

  // Fail-closed auth check #2: Instagram often only shows the wall on
  // the target profile URL, not the app shell.
  await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page), 25_000, 500, session.account.user);
}
