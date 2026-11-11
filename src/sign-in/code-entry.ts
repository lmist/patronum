/**
 * Enter a one-time code on Instagram's two-factor page without asking the model.
 *
 * The page is simple and fixed: one code input and one Continue button. The
 * model-driven version typed each retry after the last code, so the field
 * read 504284504284504284, and it submitted twice (Enter, then a click).
 * Instagram accepts a code once, so the rules here are:
 *
 *   - the field is emptied before the code goes in, and checked afterwards
 *   - one submission per code
 *   - wait for the page to answer before deciding what happened
 *
 * The caller decides whether to try again, with a different code.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { ACT_TYPE_TOTP, totpVariables } from "./prompts.js";

/** advanced: the page moved on. rejected: Instagram refused the code. stuck: no answer in time. no-field: no code input here. */
export type CodeEntryOutcome = "advanced" | "rejected" | "stuck" | "no-field";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs in the page: a selector for the one visible code input, or null. */
const FIND_CODE_INPUT = `(() => {
  const visible = (el) => el.getClientRects().length > 0 && !el.disabled && !el.readOnly;
  const known = ['input[name="verificationCode"]', 'input[autocomplete="one-time-code"]', 'input[name="code"]',
    'input[name="security_code"]', 'input[inputmode="numeric"]', 'input[type="tel"]', 'input[type="number"]'];
  for (const selector of known) {
    const el = document.querySelector(selector);
    if (el && visible(el)) return selector;
  }
  const text = [...document.querySelectorAll('input:not([type]), input[type="text"]')].filter(visible);
  if (text.length !== 1) return null;
  text[0].setAttribute("data-patronum-code-input", "1");
  return 'input[data-patronum-code-input="1"]';
})()`;

/** Runs in the page: empty the input the way React notices. */
const clearInput = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return;
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
})()`;

const inputValue = (selector: string) => `(document.querySelector(${JSON.stringify(selector)})?.value ?? null)`;

/** Runs in the page: index of the enabled submit button among all buttons, or -1. */
const BUTTONS = 'button, [role="button"], input[type="submit"]';
const FIND_SUBMIT = `(() => [...document.querySelectorAll(${JSON.stringify(BUTTONS)})].findIndex((el) =>
  el.getClientRects().length > 0 && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true" &&
  /^(continue|confirm|submit|next|verify|done)$/i.test((el.textContent || el.getAttribute("aria-label") || el.value || "").trim())))()`;

/** Runs in the page: true when a code input is showing next to a refusal message. */
const REJECTED = `(() => /check the security code|code (you entered )?(is|was|isn't|is not)? ?(incorrect|invalid|wrong|expired|not valid|right)|please try again/i.test(document.body?.innerText ?? ""))()`;

type Page = ReturnType<Stagehand["context"]["pages"]>[number];

/** What the page shows, digits masked, for the log. */
async function visibleText(page: Page): Promise<string> {
  try {
    const text = String(await page.evaluate(`(document.body?.innerText ?? "")`));
    return text.replace(/\s+/g, " ").replace(/\d{4,}/g, "<digits>").trim().slice(0, 400) || "(nothing)";
  } catch { return "(unreadable)"; }
}

async function refused(page: Page): Promise<CodeEntryOutcome> {
  console.log(`[code] refused; the page says: ${await visibleText(page)}`);
  return "rejected";
}

/**
 * Put `code` in the code input, submit it once, and report what the page did.
 * `settleMs` is how long to wait for an answer.
 */
export async function enterCodeOnce(stagehand: Stagehand, code: string, settleMs = 15_000): Promise<CodeEntryOutcome> {
  const page = stagehand.context.pages()[0]!;
  const startUrl = page.url();
  // The two-factor page draws its form a moment after the address changes.
  let selector: string | null = null;
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(250)) {
    selector = (await page.evaluate(FIND_CODE_INPUT)) as string | null;
    if (selector) break;
  }
  if (!selector) return "no-field";

  // A refusal left on screen from an earlier code says nothing about this one.
  const staleRefusal = Boolean(await page.evaluate(REJECTED));
  await page.evaluate(clearInput(selector));
  const filled = await stagehand.act(
    { selector, description: ACT_TYPE_TOTP, method: "fill", arguments: ["%totp_code%"] },
    { ...totpVariables(code), timeout: 10_000 },
  );
  if (!filled.success || (await page.evaluate(inputValue(selector))) !== code) {
    // Never submit a field that does not hold exactly this code.
    await page.evaluate(clearInput(selector));
    return "stuck";
  }

  let submit = -1;
  for (const deadline = Date.now() + 3_000; Date.now() < deadline; await sleep(100)) {
    submit = (await page.evaluate(FIND_SUBMIT)) as number;
    if (submit >= 0) break;
  }
  if (submit >= 0) await page.locator(BUTTONS).nth(submit).click();
  else await page.keyPress("Enter");
  console.log(`[code] field ${selector} holds the code; submitted with ${submit >= 0 ? "the Continue button" : "Enter (no enabled button found)"}`);

  for (const deadline = Date.now() + settleMs; Date.now() < deadline; await sleep(300)) {
    // Only a new address means the code was taken: while Instagram checks a
    // code it disables the field, which is not the same as moving on.
    if (new URL(page.url()).pathname !== new URL(startUrl).pathname) return "advanced";
    try {
      if (!staleRefusal && (await page.evaluate(REJECTED))) return refused(page);
    } catch {
      // The page is navigating; the next pass reads the new one.
    }
  }
  try { if (await page.evaluate(REJECTED)) return refused(page); } catch { /* fall through */ }
  console.log(`[code] no answer after ${Math.round(settleMs / 1000)}s; the page says: ${await visibleText(page)}`);
  return "stuck";
}
