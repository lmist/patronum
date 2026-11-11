import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import type { Account } from "./accounts.js";
import { fetchLatestInstagramCode } from "./agentmail.js";
import { generateTOTP, totpSecondsLeft } from "./totp.js";
import {
  createStagehand,
  sessionIdOf,
  sessionLiveUrl,
} from "../browser/stagehand.js";
import { assertAuthenticated, AuthError } from "./auth-check.js";
import { clearChromeProfile } from "../browser/chrome-profile.js";
import { solveBrowserChallenge } from "./captcha/browser.js";
import {
  ACT_CLICK_AUTH_APP,
  ACT_CLICK_LOGIN,
  ACT_CLICK_TOTP_SUBMIT,
  ACT_TYPE_EMAIL_CODE,
  ACT_TYPE_PASSWORD,
  ACT_TYPE_TOTP,
  ACT_TYPE_USERNAME,
  OBSERVE_COOKIE_ACCEPT,
  OBSERVE_LOGIN_FORM,
  OBSERVE_POST_LOGIN_DISMISS,
  OBSERVE_TOTP_CODE_FIELD,
  OBSERVE_TOTP_SUBMIT,
  emailCodeVariables,
  passwordVariables,
  totpVariables,
  usernameVariables,
} from "./prompts.js";

const IG_LOGIN = "https://www.instagram.com/accounts/login/";
const IG_HOME = "https://www.instagram.com/";

export type LoginResult = {
  sessionId: string;
  liveUrl: string;
  loggedInAs: string;
  profileDir: string;
};

/** Auth URLs can carry checkpoint tokens in query parameters. */
export function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unknown";
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Best-effort cookie dismiss: DOM first (no LLM), then observe→act. */
export async function dismissCookieBanner(stagehand: Stagehand) {
  const page = stagehand.context.pages()[0]!;
  try {
    const clicked = await page.evaluate(() => {
      const labels = [
        "allow all cookies",
        "accept all",
        "accept all cookies",
        "allow all",
        "accept",
        "allow",
      ];
      const btns = [
        ...document.querySelectorAll("button, [role='button']"),
      ] as HTMLElement[];
      for (const b of btns) {
        const t = (b.textContent || b.getAttribute("aria-label") || "")
          .trim()
          .toLowerCase();
        if (labels.some((l) => t === l || t.includes(l))) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) await sleep(800);
    return;
  } catch {
    // optional
  }
  try {
    const actions = await stagehand.observe(OBSERVE_COOKIE_ACCEPT);
    if (actions.length > 0) {
      await stagehand.act(actions[0]!);
      await sleep(800);
    }
  } catch {
    // optional
  }
}

/** Dismiss Save login / notifications: DOM first, then observe→act. */
export async function dismissPostLoginModals(stagehand: Stagehand) {
  const page = stagehand.context.pages()[0]!;
  for (let round = 0; round < 4; round++) {
    try {
      const clicked = await page.evaluate(() => {
        const labels = ["not now", "skip", "later", "cancel"];
        const btns = [
          ...document.querySelectorAll("button, [role='button']"),
        ] as HTMLElement[];
        for (const b of btns) {
          const t = (b.textContent || b.getAttribute("aria-label") || "")
            .trim()
            .toLowerCase();
          if (labels.some((l) => t === l)) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        await sleep(800);
        continue;
      }
      break;
    } catch {
      // fall through to observe
    }
    try {
      const actions = await stagehand.observe(OBSERVE_POST_LOGIN_DISMISS);
      if (actions.length === 0) break;
      await stagehand.act(actions[0]!);
      await sleep(1000);
    } catch {
      break;
    }
  }
}

type PageKind = "login" | "totp" | "checkpoint" | "home" | "unknown";

/**
 * Classify page with URL heuristics first (no LLM).
 * LLM extract only when URL cannot decide.
 */
export function classifyPageByUrl(pageUrl: string): PageKind | null {
  const url = pageUrl.toLowerCase();
  // Instagram's unified auth_platform/codeentry is 2FA / email / WhatsApp code
  // entry — not a captcha. Check it before generic auth_platform/checkpoint.
  if (
    url.includes("two_factor") ||
    url.includes("two-factor") ||
    url.includes("two_step") ||
    url.includes("codeentry")
  ) {
    return "totp";
  }
  if (
    url.includes("/challenge") ||
    url.includes("checkpoint") ||
    url.includes("auth_platform")
  ) {
    return "checkpoint";
  }
  if (
    url.includes("/accounts/onetap") ||
    url.includes("/accounts/edit") ||
    url.includes("/direct/") ||
    url.includes("/reels") ||
    url === "https://www.instagram.com/" ||
    url.startsWith("https://www.instagram.com/?")
  ) {
    return "home";
  }
  if (url.includes("/accounts/login") && !url.includes("two")) {
    return "login";
  }
  return null;
}

export async function classifyPage(
  stagehand: Stagehand,
  pageUrl: string,
): Promise<PageKind> {
  if (pageUrl.includes("/auth_platform/codeentry/")) {
    const inspection = await inspectCheckpoint(stagehand);
    const currentUrl = stagehand.context.pages()[0]!.url();
    if (currentUrl !== pageUrl) return classifyPage(stagehand, currentUrl);
    if (inspection.step === "email_code") return "checkpoint";
    if (inspection.step === "authenticator_code") return "totp";
    throw new Error("Instagram code delivery method is unknown");
  }
  const fromUrl = classifyPageByUrl(pageUrl);
  if (fromUrl) return fromUrl;

  try {
    return await stagehand.extract(
      "Classify the Instagram page kind. Pick login if username/password form, totp if 2FA code or method picker, checkpoint if captcha or blocked, home if logged-in feed or app shell, unknown otherwise.",
      z
        .enum(["login", "totp", "checkpoint", "home", "unknown"])
        .describe("Instagram page kind from visible UI"),
    );
  } catch {
    return "unknown";
  }
}

/** Fill login form with Stagehand variables; raw credentials never enter prompts or logs. */
export async function fillLoginForm(
  stagehand: Stagehand,
  account: Account,
): Promise<number> {
  const page = stagehand.context.pages()[0]!;

  try {
    await page.waitForSelector(
      'input[name="username"], input[name="email"], input[type="password"], input[name="pass"]',
      { timeout: 12_000 },
    );
  } catch {
    // Let the targeted observe/act report the missing form.
  }

  const form = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
    const input = (selectors: string[]) => selectors.find(selector => {
      const el = document.querySelector(selector);
      return el && visible(el);
    });
    const username = input(['input[name="username"]', 'input[name="email"]']);
    const password = input(['input[name="password"]', 'input[name="pass"]', 'input[type="password"]']);
    const controls = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
    const submit = controls.findIndex(el => visible(el) && /^log\s*in$/i.test(
      (el.textContent || el.getAttribute('aria-label') || (el as HTMLInputElement).value || '').trim(),
    ));
    return { username, password, submit };
  });
  if (form.username && form.password && form.submit >= 0) {
    for (const [selector, description, variable, variables] of [
      [form.username, ACT_TYPE_USERNAME, "%username%", usernameVariables(account.user)],
      [form.password, ACT_TYPE_PASSWORD, "%password%", passwordVariables(account.pass)],
    ] as const) {
      const result = await stagehand.act(
        { selector, description, method: "fill", arguments: [variable] },
        { ...variables, timeout: 10_000 },
      );
      if (!result.success) throw new Error("Instagram credential field could not be filled");
    }
    await dismissCookieBanner(stagehand);
    const readyDeadline = Date.now() + 3_000;
    let submitIndex = -1;
    while (Date.now() < readyDeadline) {
      submitIndex = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
        return controls.findIndex(button =>
          (button as HTMLElement).getClientRects().length > 0 &&
          !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true" &&
          /^log\s*in$/i.test((button.textContent || button.getAttribute("aria-label") || (button as HTMLInputElement).value || '').trim()),
        );
      });
      if (submitIndex >= 0) break;
      await sleep(100);
    }
    if (submitIndex < 0) throw new Error("Instagram login submit stayed disabled after filling credentials");
    console.log("[login] submitting login form (DOM)");
    const submittedAfter = Date.now();
    await page.locator('button, [role="button"], input[type="submit"]').nth(submitIndex).click();
    return submittedAfter;
  }

  try {
    await stagehand.observe(OBSERVE_LOGIN_FORM);
  } catch {
    // continue with direct acts
  }

  console.log("[login] act: type username (variables)");
  await stagehand.act(ACT_TYPE_USERNAME, {
    ...usernameVariables(account.user),
    timeout: 10_000,
  });
  await sleep(400);

  console.log("[login] act: type password (variables)");
  await stagehand.act(ACT_TYPE_PASSWORD, {
    ...passwordVariables(account.pass),
    timeout: 10_000,
  });
  await sleep(400);

  console.log("[login] act: click Log in");
  const submittedAfter = Date.now();
  await stagehand.act(ACT_CLICK_LOGIN, { timeout: 8_000 });
  return submittedAfter;
}

async function submitTotp(
  stagehand: Stagehand,
  secret: string,
): Promise<PageKind> {
  const page = stagehand.context.pages()[0]!;

  let step: "method_picker" | "code_entry" | "other" = "code_entry";
  try {
    const codeFields = await stagehand.observe(OBSERVE_TOTP_CODE_FIELD);
    if (codeFields.length === 0) {
      const methods = await stagehand.observe(
        "Find Authentication app or text message options for two-factor",
      );
      step = methods.length > 0 ? "method_picker" : "other";
    }
  } catch {
    step = "code_entry";
  }
  console.log(`[totp] step: ${step}`);

  if (step === "method_picker") {
    console.log("[totp] selecting authentication app…");
    try {
      await stagehand.act(ACT_CLICK_AUTH_APP, { timeout: 8_000 });
      await sleep(2000);
    } catch {
      // continue
    }
  }

  if (totpSecondsLeft() < 8) {
    console.log("[totp] waiting for next time window…");
    await sleep(totpSecondsLeft() * 1000 + 400);
  }

  async function enterAndSubmitCode(code: string) {
    console.log(`[totp] entering code (valid ~${totpSecondsLeft()}s)`);
    await stagehand.act(ACT_TYPE_TOTP, {
      ...totpVariables(code),
      timeout: 10_000,
    });
    try {
      await page.keyPress("Enter");
    } catch {
      // ignore
    }
    await sleep(400);
    try {
      const submits = await stagehand.observe(OBSERVE_TOTP_SUBMIT);
      if (submits.length > 0) {
        await stagehand.act(submits[0]!);
      } else {
        await stagehand.act(ACT_CLICK_TOTP_SUBMIT, { timeout: 8_000 });
      }
    } catch {
      await stagehand.act(ACT_CLICK_TOTP_SUBMIT, { timeout: 8_000 });
    }
  }

  await enterAndSubmitCode(generateTOTP(secret));
  await sleep(4500);

  let kind = await classifyPage(stagehand, page.url());
  if (kind === "totp") {
    console.log("[totp] still on 2FA — retrying with fresh code");
    if (totpSecondsLeft() < 5) {
      await sleep(totpSecondsLeft() * 1000 + 400);
    }
    await enterAndSubmitCode(generateTOTP(secret));
    await sleep(4500);
    kind = await classifyPage(stagehand, page.url());
  }

  return kind;
}

type CheckpointStep =
  | "email_choice"
  | "send_email"
  | "email_code"
  | "authenticator_code"
  | "puzzle"
  | "other";

type CheckpointControl = {
  index: number;
  tag: string;
  type: string;
  role: string;
  text: string;
};

type CheckpointInput = {
  selector: string;
  name: string;
  type: string;
  placeholder: string;
};

type CheckpointFrameProbe = {
  frameId: string;
  url: string;
  deepPrefix: string;
  controls: CheckpointControl[];
  codeInputs: CheckpointInput[];
  mentionsEmail: boolean;
  mentionsAuthenticator: boolean;
  hasInteractivePuzzle: boolean;
};

type CheckpointInspection = {
  step: CheckpointStep;
  frames: CheckpointFrameProbe[];
  probe?: CheckpointFrameProbe;
  control?: CheckpointControl;
  input?: CheckpointInput;
};

const CHECKPOINT_ACTIONABLE_SELECTOR =
  'button, input[type="button"], input[type="submit"], input[type="radio"], input[type="checkbox"], [role="button"], [role="radio"], [role="checkbox"], label';
const CHECKPOINT_CODE_SELECTORS = [
  'input[name="security_code"]',
  'input[name="code"]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[name="email"]',
] as const;

function redactControlText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{6}\b/g, "[code]")
    .slice(0, 160);
}

function describeControls(inspection: CheckpointInspection): string {
  const controls = inspection.frames.flatMap((frame) =>
    frame.controls.map(
      (control) =>
        `${frame.frameId}:${control.tag}${control.type ? `[${control.type}]` : ""}${
          control.role ? `[role=${control.role}]` : ""
        }=${JSON.stringify(redactControlText(control.text))}`,
    ),
  );
  return controls.length > 0 ? controls.join(", ") : "none";
}

type ProtocolFrameNode = {
  frame: { id: string; url: string };
  childFrames?: ProtocolFrameNode[];
};

function flattenFrameTree(
  node: ProtocolFrameNode,
  parentId: string | null = null,
  result: Array<{ id: string; url: string; parentId: string | null }> = [],
): Array<{ id: string; url: string; parentId: string | null }> {
  result.push({ id: node.frame.id, url: node.frame.url, parentId });
  for (const child of node.childFrames ?? []) {
    flattenFrameTree(child, node.frame.id, result);
  }
  return result;
}

async function deepPrefixForFrame(
  page: ReturnType<Stagehand["context"]["pages"]>[number],
  frames: Array<{ id: string; url: string; parentId: string | null }>,
  targetId: string,
): Promise<string> {
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const lineage: Array<{ id: string; url: string; parentId: string | null }> = [];
  let current = byId.get(targetId);
  while (current?.parentId) {
    lineage.unshift(current);
    current = byId.get(current.parentId);
  }

  const hops: string[] = [];
  for (const child of lineage) {
    const parent = byId.get(child.parentId!);
    if (!parent) return "";
    let sources: string[] = [];
    try {
      sources = await page
        .frameForId(parent.id)
        .evaluate(() =>
          [...document.querySelectorAll("iframe")].map((iframe) => iframe.src),
        );
    } catch {
      return "";
    }
    let index = sources.findIndex((source) => source === child.url);
    if (index < 0) {
      try {
        const childUrl = new URL(child.url);
        index = sources.findIndex((source) => {
          try {
            const sourceUrl = new URL(source);
            return (
              sourceUrl.origin === childUrl.origin &&
              sourceUrl.pathname === childUrl.pathname
            );
          } catch {
            return false;
          }
        });
      } catch {
        // Keep looking by the only-frame fallback below.
      }
    }
    if (index < 0 && sources.length === 1) index = 0;
    if (index < 0) return "";
    hops.push(`iframe:nth-of-type(${index + 1})`);
  }
  return hops.join(" >> ");
}

export async function waitForCheckpointFrames(
  page: ReturnType<Stagehand["context"]["pages"]>[number],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const actionable = await frame.evaluate(() =>
          [...document.querySelectorAll('input, button, [role="button"], [role="checkbox"], [role="radio"]')]
            .some(element => (element as HTMLElement).getClientRects().length > 0),
        );
        if (actionable) return;
      } catch {
        // A newly attached cross-origin frame may not have an execution context yet.
      }
    }
    await sleep(200);
  }
}

async function probeCheckpointFrames(
  stagehand: Stagehand,
): Promise<CheckpointFrameProbe[]> {
  const page = stagehand.context.pages()[0]!;
  await waitForCheckpointFrames(page);
  // Explicitly request the iframe-inclusive v3 snapshot before any targeted act.
  // This also refreshes Stagehand's OOPIF/frame registry after auth_platform loads.
  try {
    await page.snapshot({ includeIframes: true });
  } catch {
    // DOM frame-scoped probes below are the deterministic source of truth.
  }

  const protocolTree = page.getFullFrameTree() as ProtocolFrameNode;
  const frameMetadata = flattenFrameTree(protocolTree);
  console.log("[checkpoint] frame tree (URLs only):");
  for (const frame of frameMetadata) {
    console.log(
      `[checkpoint] frame id=${frame.id} parent=${frame.parentId ?? "root"} url=${safePageUrl(frame.url)}`,
    );
  }

  const probes: CheckpointFrameProbe[] = [];
  for (const metadata of frameMetadata) {
    const frame = page.frameForId(metadata.id);
    try {
      const dom = await frame.evaluate(
        (selectors: { actionable: string; codes: string[] }) => {
          const visible = (element: Element): boolean => {
            const html = element as HTMLElement;
            const style = getComputedStyle(html);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              html.getClientRects().length > 0
            );
          };
          const textOf = (element: Element): string => {
            const input = element as HTMLInputElement;
            const label = input.id
              ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
              : null;
            return (
              element.getAttribute("aria-label") ||
              label?.textContent ||
              element.closest("label")?.textContent ||
              ((input.type === "button" || input.type === "submit")
                ? input.value
                : "") ||
              element.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160);
          };
          const controls = [...document.querySelectorAll(selectors.actionable)]
            .map((element, index) => ({ element, index }))
            .filter(({ element }) => visible(element))
            .map(({ element, index }) => ({
              index,
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") || "",
              role: element.getAttribute("role") || "",
              text: textOf(element),
            }));
          const codeInputs = selectors.codes.flatMap((selector) => {
            if (selector === 'input[name="email"]' && !location.pathname.includes("/auth_platform/codeentry/")) return [];
            const element = document.querySelector(selector) as HTMLInputElement | null;
            if (!element || !visible(element)) return [];
            return [
              {
                selector,
                name: element.name || "",
                type: element.type || "",
                placeholder: element.placeholder || "",
              },
            ];
          });
          const visibleText = (document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .toLowerCase();
          const controlText = controls
            .map((control) => control.text)
            .join(" ")
            .toLowerCase();
          return {
            controls,
            codeInputs,
            mentionsEmail:
              /\bemail\b|e-mail|mail address|@/.test(visibleText),
            mentionsAuthenticator:
              /authenticator|authentication app|two-factor|2fa/.test(visibleText),
            hasInteractivePuzzle:
              /i(?:'|’)m not a robot|select all (?:images|squares)|verify (?:you are|that you are) human|captcha challenge/.test(
                `${visibleText} ${controlText}`,
              ) ||
              controls.some(
                (control) =>
                  control.role === "checkbox" &&
                  /robot|captcha|human/.test(control.text.toLowerCase()),
              ),
          };
        },
        {
          actionable: CHECKPOINT_ACTIONABLE_SELECTOR,
          codes: [...CHECKPOINT_CODE_SELECTORS],
        },
      );
      probes.push({
        frameId: metadata.id,
        url: metadata.url,
        deepPrefix: await deepPrefixForFrame(page, frameMetadata, metadata.id),
        ...dom,
      });
    } catch (error) {
      console.log(
        `[checkpoint] frame probe unavailable id=${metadata.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return probes;
}

function inspectCheckpointProbes(
  frames: CheckpointFrameProbe[],
): CheckpointInspection {
  for (const probe of frames) {
    if (probe.codeInputs.length > 0) {
      return {
        step:
          probe.mentionsAuthenticator && !probe.mentionsEmail
            ? "authenticator_code"
            : "email_code",
        frames,
        probe,
        input: probe.codeInputs[0],
      };
    }
  }

  for (const probe of frames) {
    const emailControl = probe.controls.find((control) =>
      /\bemail\b|e-mail|mail address|@/.test(control.text.toLowerCase()),
    );
    if (emailControl) {
      return {
        step: "email_choice",
        frames,
        probe,
        control: emailControl,
      };
    }
  }

  for (const probe of frames) {
    const sendControl = probe.controls.find((control) =>
      /send(?: security)? code|continue|next/.test(control.text.toLowerCase()),
    );
    if (probe.mentionsEmail && sendControl) {
      return {
        step: "send_email",
        frames,
        probe,
        control: sendControl,
      };
    }
  }

  const puzzleProbe = frames.find((probe) => probe.hasInteractivePuzzle);
  if (puzzleProbe) return { step: "puzzle", frames, probe: puzzleProbe };
  return { step: "other", frames };
}

async function inspectCheckpoint(
  stagehand: Stagehand,
): Promise<CheckpointInspection> {
  return inspectCheckpointProbes(await probeCheckpointFrames(stagehand));
}

async function clickCheckpointControl(
  stagehand: Stagehand,
  inspection: CheckpointInspection,
  purpose: string,
): Promise<void> {
  if (!inspection.probe || !inspection.control) {
    throw new Error(
      `Instagram checkpoint has no deterministic ${purpose} control. Visible controls: ${describeControls(
        inspection,
      )}`,
    );
  }
  const page = stagehand.context.pages()[0]!;
  await page
    .frameForId(inspection.probe.frameId)
    .locator(CHECKPOINT_ACTIONABLE_SELECTOR)
    .nth(inspection.control.index)
    .click();
}

function findCheckpointControl(
  inspection: CheckpointInspection,
  pattern: RegExp,
): CheckpointInspection | null {
  for (const probe of inspection.frames) {
    const control = probe.controls.find((candidate) =>
      pattern.test(candidate.text.toLowerCase()),
    );
    if (control) return { ...inspection, probe, control };
  }
  return null;
}

type EmailCheckpointContext = { requestedAfter?: number };

export async function completeCaptchaCheckpoint(stagehand: Stagehand, email: EmailCheckpointContext = {}): Promise<PageKind> {
  const page = stagehand.context.pages()[0]!;
  // Completing verification can send an email before the code-entry page loads.
  email.requestedAfter ??= Date.now();
  await solveBrowserChallenge(page);
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(1000);
    const kind = await classifyPage(stagehand, page.url());
    if (kind !== "checkpoint") return kind;
    const inspection = await inspectCheckpoint(stagehand);
    if (["email_choice", "email_code", "send_email"].includes(inspection.step)) return "checkpoint";
    if (inspection.step === "authenticator_code") return "totp";
    const next = findCheckpointControl(inspection, /^(continue|next|submit)$/);
    if (next) await clickCheckpointControl(stagehand, next, "verified checkpoint continue");
  }
  throw new Error("CAPTCHA completed but Instagram checkpoint did not advance");
}

async function requestEmailCode(stagehand: Stagehand, email: EmailCheckpointContext): Promise<number | { kind: PageKind }> {
  let inspection = await inspectCheckpoint(stagehand);
  console.log(`[checkpoint] deterministic step: ${inspection.step}`);
  if (inspection.step === "puzzle") {
    return { kind: await completeCaptchaCheckpoint(stagehand, email) };
  }
  if (inspection.step === "authenticator_code") {
    throw new Error("Instagram checkpoint changed to authenticator 2FA");
  }
  if (inspection.step === "other") {
    throw new Error(
      `Instagram checkpoint is not the email-code flow. Visible controls: ${describeControls(
        inspection,
      )}`,
    );
  }

  // Record before the action because choosing email can send immediately.
  const requestedAfter = Date.now();
  if (inspection.step === "email_code") {
    if (email.requestedAfter !== undefined) {
      console.log("[checkpoint] using email requested by the current login flow…");
      return email.requestedAfter;
    }
    const resend = findCheckpointControl(
      inspection,
      /resend|send another|new code|get another/,
    );
    if (!resend) {
      throw new Error(
        `Instagram opened on code entry but no fresh-code control is visible. Visible controls: ${describeControls(
          inspection,
        )}`,
      );
    }
    console.log("[checkpoint] requesting one fresh email code…");
    email.requestedAfter = requestedAfter;
    await clickCheckpointControl(stagehand, resend, "resend-code");
    await sleep(1000);
    return requestedAfter;
  }

  if (inspection.step === "email_choice") {
    console.log("[checkpoint] selecting email delivery…");
    email.requestedAfter = requestedAfter;
    await clickCheckpointControl(stagehand, inspection, "email option");
    await sleep(1800);
    inspection = await inspectCheckpoint(stagehand);
    console.log(`[checkpoint] after email selection: ${inspection.step}`);
    if (inspection.step === "puzzle") {
      return { kind: await completeCaptchaCheckpoint(stagehand, email) };
    }
    if (inspection.step === "authenticator_code") {
      throw new Error("Instagram checkpoint changed to authenticator 2FA");
    }
    if (inspection.step === "email_code") return requestedAfter;
  }

  const send =
    findCheckpointControl(
      inspection,
      /send(?: security)? code|continue|next/,
    ) ?? (inspection.step === "send_email" ? inspection : null);
  if (!send) {
    throw new Error(
      `Instagram checkpoint did not expose a deterministic send-code control. Visible controls: ${describeControls(
        inspection,
      )}`,
    );
  }
  console.log("[checkpoint] requesting email code…");
  email.requestedAfter = requestedAfter;
  await clickCheckpointControl(stagehand, send, "send-code");
  await sleep(1500);
  return requestedAfter;
}

async function resendEmailCode(stagehand: Stagehand): Promise<number> {
  console.log("[checkpoint] first email did not arrive; requesting one new code…");
  const inspection = await inspectCheckpoint(stagehand);
  const resend = findCheckpointControl(
    inspection,
    /resend|send another|new code|get another/,
  );
  if (!resend) {
    throw new Error(
      `Instagram email timed out and no deterministic resend control is visible. Visible controls: ${describeControls(
        inspection,
      )}`,
    );
  }
  const requestedAfter = Date.now();
  await clickCheckpointControl(stagehand, resend, "resend-code");
  await sleep(1000);
  return requestedAfter;
}

export async function submitEmailCheckpoint(stagehand: Stagehand, email: EmailCheckpointContext = {}): Promise<PageKind> {
  const page = stagehand.context.pages()[0]!;
  const requested = await requestEmailCode(stagehand, email);
  if (typeof requested !== "number") return requested.kind;
  let since = requested;
  console.log("[checkpoint] waiting for a new Instagram email…");

  let code: string;
  try {
    code = await fetchLatestInstagramCode(since);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Timed out")) {
      throw error;
    }
    since = await resendEmailCode(stagehand);
    code = await fetchLatestInstagramCode(since);
  }

  console.log("[checkpoint] new email code received; entering via variables…");
  // A later checkpoint needs a new request, not the code consumed here.
  email.requestedAfter = undefined;
  const inspection = await inspectCheckpoint(stagehand);
  if (inspection.step !== "email_code" || !inspection.probe || !inspection.input) {
    throw new Error(
      `Instagram did not expose the emailed-code input. Visible controls: ${describeControls(
        inspection,
      )}`,
    );
  }
  const deepSelector = inspection.probe.deepPrefix
    ? `${inspection.probe.deepPrefix} >> ${inspection.input.selector}`
    : inspection.input.selector;
  const typed = await stagehand.act(
    {
      selector: deepSelector,
      description: ACT_TYPE_EMAIL_CODE,
      method: "fill",
      arguments: ["%email_code%"],
    },
    {
      ...emailCodeVariables(code),
      timeout: 10_000,
    },
  );
  if (!typed.success) {
    throw new Error(`Instagram email-code input failed: ${typed.message}`);
  }
  await sleep(300);

  const afterTyping = await inspectCheckpoint(stagehand);
  const submit = findCheckpointControl(
    afterTyping,
    /continue|confirm|submit|verify|next/,
  );
  if (!submit) {
    throw new Error(
      `Instagram did not expose the emailed-code submit control. Visible controls: ${describeControls(
        afterTyping,
      )}`,
    );
  }
  await clickCheckpointControl(stagehand, submit, "email-code submit");

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const fromUrl = classifyPageByUrl(page.url());
    if (fromUrl === "home") return "home";
    if (fromUrl === "totp" && await classifyPage(stagehand, page.url()) === "totp") return "totp";
    if (fromUrl === null) return classifyPage(stagehand, page.url());
    if (fromUrl === "checkpoint" || page.url().includes("/auth_platform/codeentry/")) {
      const current = await inspectCheckpoint(stagehand);
      if (current.step === "authenticator_code") return "totp";
      if (current.step === "puzzle") {
        return completeCaptchaCheckpoint(stagehand, email);
      }
    }
  }

  const current = await inspectCheckpoint(stagehand);
  if (current.step === "authenticator_code") return "totp";
  if (current.step === "email_code") {
    throw new Error("Instagram did not accept the emailed security code");
  }
  throw new Error(
    `Instagram checkpoint did not reach home. Visible controls: ${describeControls(
      current,
    )}`,
  );
}

export async function runLoginInSession(
  stagehand: Stagehand,
  account: Account,
): Promise<string> {
  const page = stagehand.context.pages()[0]!;
  const liveUrl = sessionLiveUrl(stagehand);
  console.log(`[login] local profile: ${liveUrl}`);

  console.log("[login] navigating to Instagram login…");
  try {
    await page.goto(IG_LOGIN, {
      waitUntil: "domcontentloaded",
      timeoutMs: 60_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[login] navigation wait: ${msg} (url=${safePageUrl(page.url())})`);
    if (!page.url() || page.url() === "about:blank") throw err;
  }
  console.log(`[login] phase=navigate outcome=loaded url=${safePageUrl(page.url())}`);
  await sleep(2500);
  await dismissCookieBanner(stagehand);

  // Profile may already be authenticated — skip form if so
  const kindEarly = await classifyPage(stagehand, page.url());
  if (kindEarly === "home") {
    console.log("[login] already authenticated via local profile");
    await dismissPostLoginModals(stagehand);
    await assertAuthenticated(page, { expectedUser: account.user });
    return account.user;
  }

  let kind: PageKind = kindEarly;
  const email: EmailCheckpointContext = {};
  if (kind === "login" || kind === "unknown") {
    console.log(`[login] signing in as ${account.user}…`);
    email.requestedAfter = await fillLoginForm(stagehand, account);

    for (let i = 0; i < 15; i++) {
      await sleep(1200);
      const url = page.url();
      if (
        !url.includes("/accounts/login") ||
        url.includes("two") ||
        url.includes("challenge") ||
        url.includes("codeentry") ||
        url.includes("auth_platform")
      ) {
        break;
      }
    }

    kind = await classifyPage(stagehand, page.url());
    console.log(`[login] page state: ${kind} (${safePageUrl(page.url())})`);

    if (kind === "login" || kind === "unknown") {
      throw new AuthError("Instagram did not accept the login or has not finished responding. Review the account credentials, then use Open login browser to inspect the page before trying again.", {
        state: kind,
        evidence: { ok: false, state: kind, reason: "login did not advance after one submission" },
      });
    }
  }

  for (let authStep = 0; authStep < 3; authStep++) {
    if (kind === "totp") {
      if (!account.totp_secret) {
        throw new Error(
          `Instagram asked for 2FA but IG_TOTP_SECRET is not set. Live: ${liveUrl}`,
        );
      }
      kind = await submitTotp(stagehand, account.totp_secret);
      console.log(`[login] after TOTP: ${kind} (${safePageUrl(page.url())})`);
      continue;
    }
    if (kind === "checkpoint") {
      kind = await submitEmailCheckpoint(stagehand, email);
      console.log(`[login] after email checkpoint: ${kind} (${safePageUrl(page.url())})`);
      continue;
    }
    break;
  }

  if (kind === "login" || kind === "totp") {
    throw new Error(`Login stuck (state=${kind}). Profile: ${liveUrl}`);
  }

  await dismissPostLoginModals(stagehand);

  try {
    await page.goto(IG_HOME, {
      waitUntil: "domcontentloaded",
      timeoutMs: 60_000,
    });
    await sleep(2000);
    await dismissPostLoginModals(stagehand);
  } catch {
    // stay
  }

  kind = await classifyPage(stagehand, page.url());
  if (kind === "login" || kind === "totp" || kind === "checkpoint") {
    throw new Error(
      `Login did not complete (state=${kind}). Profile: ${liveUrl}`,
    );
  }

  await assertAuthenticated(page, { expectedUser: account.user });
  console.log("[login] phase=verify outcome=authenticated");
  const loggedInAs = account.user;
  console.log(`[login] success — ${loggedInAs} (${safePageUrl(page.url())})`);
  return loggedInAs;
}

export async function loginInstagram(
  account: Account,
  options: { forceFreshProfile?: boolean; keepOpen?: boolean } = {},
): Promise<LoginResult> {
  if (options.forceFreshProfile) {
    clearChromeProfile();
  }

  const stagehand = createStagehand({
    keepAlive: options.keepOpen,
    ...(options.keepOpen ? { headless: false } : {}),
  });

  const started = Date.now();
  try {
    console.log("[login] phase=browser outcome=started");
    await stagehand.init();
    console.log(`[login] phase=browser outcome=ready elapsedMs=${Date.now() - started}`);
    const liveUrl = sessionLiveUrl(stagehand);
    const sessionId = sessionIdOf(stagehand);
    const profileDir = liveUrl.replace(/^local:\/\//, "");

    const loggedInAs = await runLoginInSession(stagehand, account);

    return { sessionId, liveUrl, loggedInAs, profileDir };
  } finally {
    try {
      await stagehand.close();
    } catch (err) {
      console.log(
        `[login] close: ${err instanceof Error ? err.message : err}`,
      );
    }
    console.log(options.keepOpen
      ? "[login] Chrome left open. Complete verification, then close this window before running patronum session."
      : "[login] browser closed; cookies remain in local Chrome profile");
  }
}
