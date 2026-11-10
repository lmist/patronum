import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { inHome, layout } from "../paths.js";

export type ProfileAction = "posts" | "reels" | "saved" | "bio-more" | "dismiss";
type SavedMap = { version: 1; selectors: Partial<Record<ProfileAction, string>> };

const DEFAULT_PATH = inHome(layout.uiMap);
const ACTIONS: Record<string, true> = { posts: true, reels: true, saved: true, "bio-more": true, dismiss: true };
const HANDLE = "{handle}";

function validHandle(handle: string): boolean {
  return /^[A-Za-z0-9._]+$/.test(handle);
}

function selectorTemplate(selector: string, handle: string): string | null {
  if (!validHandle(handle) || !selector || selector.length > 500 || /[\r\n]/.test(selector)) return null;
  return selector.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), HANDLE);
}

export class InstagramUiMap {
  private selectors: SavedMap["selectors"] = {};

  constructor(private readonly path = DEFAULT_PATH) {
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as SavedMap;
      if (saved.version === 1 && saved.selectors && typeof saved.selectors === "object") {
        for (const [action, selector] of Object.entries(saved.selectors)) {
          if (Object.hasOwn(ACTIONS, action) && typeof selector === "string" && selector.length <= 500) {
            this.selectors[action as ProfileAction] = selector;
          }
        }
      }
    } catch {
      // A missing or malformed local cache only costs a fresh DOM discovery.
    }
  }

  get(action: ProfileAction, handle: string): string | null {
    if (!validHandle(handle)) return null;
    return this.selectors[action]?.replaceAll(HANDLE, handle) ?? null;
  }

  remember(action: ProfileAction, selector: string, handle: string): void {
    const template = selectorTemplate(selector, handle);
    if (!template || this.selectors[action] === template) return;
    this.selectors[action] = template;
    this.save();
  }

  forget(action: ProfileAction): void {
    if (!this.selectors[action]) return;
    delete this.selectors[action];
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, selectors: this.selectors }, null, 2));
      renameSync(tmp, this.path);
    } catch {
      // Cache persistence must never fail the scrape.
    }
  }
}

export type MappedPage = {
  evaluate?: <R = unknown>(expression: string) => Promise<R>;
  locator?: (selector: string) => { click: () => Promise<unknown> };
};

/** Validate the current visible target before a Stagehand locator click. */
export async function clickMappedProfileAction(
  page: MappedPage,
  map: InstagramUiMap,
  action: ProfileAction,
  handle: string,
): Promise<boolean> {
  const selector = map.get(action, handle);
  if (!selector || !page.evaluate || !page.locator) return false;
  let valid = false;
  try {
    valid = !!await page.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const action = ${JSON.stringify(action)};
      const handle = ${JSON.stringify(handle.toLowerCase())};
      const el = selector.startsWith('xpath=') || selector.startsWith('/')
        ? document.evaluate(selector.replace(/^xpath=/, ''), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : document.querySelector(selector);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width < 4 || box.height < 4 || style.display === 'none' || style.visibility === 'hidden') return false;
      if (action === 'posts' || action === 'reels') {
        const link = el.closest('a[href]');
        if (!link) return false;
        const path = new URL(link.href, location.href).pathname.toLowerCase();
        return path === (action === 'posts' ? '/' + handle + '/' : '/' + handle + '/reels/');
      }
      if (action === 'saved') {
        const link = el.closest('a[href]');
        if (!link) return false;
        const path = new URL(link.href, location.href).pathname.toLowerCase();
        // Instagram may render the owner-only tab as /<handle>/saved/ or
        // /<handle>/saved/all-posts/, so accept either.
        return path.startsWith('/' + handle + '/saved');
      }
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      if (action === 'bio-more') return !!el.closest('header') && /^(more|see more|read more)$/.test(label);
      if (action === 'dismiss') return /^(accept all cookies|allow all cookies|accept cookies)$/.test(label) ||
        (!!el.closest('[role="dialog"],dialog,[aria-modal="true"]') && /^(close|not now|accept|allow all cookies)$/.test(label));
      return false;
    })()`);
  } catch {
    valid = false;
  }
  if (!valid) {
    map.forget(action);
    return false;
  }
  try {
    await page.locator(selector).click();
    return true;
  } catch {
    map.forget(action);
    return false;
  }
}

/** Discover a profile-owned tab without model inference, then validate it. */
export async function clickProfileTab(
  page: MappedPage,
  map: InstagramUiMap,
  action: "posts" | "reels" | "saved",
  handle: string,
): Promise<boolean> {
  if (await clickMappedProfileAction(page, map, action, handle)) return true;
  if (!validHandle(handle)) return false;
  // The Saved tab's href is not a fixed path (Instagram may append the active
  // collection), so match the owner-only prefix instead of an exact href.
  const selector = action === "saved"
    ? `a[href*=${JSON.stringify(`/${handle}/saved`)}]`
    : `a[href=${JSON.stringify(action === "posts" ? `/${handle}/` : `/${handle}/reels/`)}]`;
  map.remember(action, selector, handle);
  return clickMappedProfileAction(page, map, action, handle);
}

/** DOM discovery for optional controls; Stagehand's locator performs the click. */
export async function clickOptionalProfileControl(
  page: MappedPage,
  map: InstagramUiMap,
  action: "bio-more" | "dismiss",
  handle: string,
): Promise<boolean> {
  if (await clickMappedProfileAction(page, map, action, handle)) return true;
  if (!page.evaluate || !page.locator) return false;
  const marker = `data-patronum-ui-${action}`;
  let stable: string | null = null;
  try {
    stable = await page.evaluate(`(() => {
      const action = ${JSON.stringify(action)};
      const marker = ${JSON.stringify(marker)};
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 4 && box.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const el = [...document.querySelectorAll('button, [role="button"]')].find((node) => {
        if (!visible(node)) return false;
        const label = (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
        if (action === 'bio-more') return !!node.closest('header') && /^(more|see more|read more)$/.test(label);
        return /^(accept all cookies|allow all cookies|accept cookies)$/.test(label) ||
          (!!node.closest('[role="dialog"],dialog,[aria-modal="true"]') && /^(close|not now|accept|allow all cookies)$/.test(label));
      });
      if (!el) return null;
      el.setAttribute(marker, 'true');
      const tag = el.tagName.toLowerCase();
      if (el.id) return tag + '[id=' + JSON.stringify(el.id) + ']';
      const label = el.getAttribute('aria-label');
      if (label) return tag + '[aria-label=' + JSON.stringify(label) + ']';
      return '';
    })()`);
    if (stable === null) return false;
    await page.locator(`[${marker}="true"]`).click();
    if (stable) map.remember(action, stable, handle);
    return true;
  } catch {
    return false;
  }
}
