import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ensureAuthenticatedSession } from "../sign-in/ensure-session.js";
import { startInstagramTraffic, getObservedDocumentResponse } from "../api-map/traffic-recorder.js";
import { InstagramUiMap, clickProfileTab, type MappedPage } from "../api-map/ui-map.js";
import { assertDetailAuthenticated, stagehandAuthProbe } from "../collect/open-profile.js";
import { assertProfileNavigationResponse } from "../collect/rejections.js";

import { DATA_HOME, layout } from "../paths.js";
const root = DATA_HOME;

/**
 * Which surface of the account's own profile to walk. `saved` opens the Saved
 * tab, which only the signed-in owner can see, so the saved feed is only
 * observable for the account that owns the profile.
 */
export type NetworkMapSurface = "profile" | "saved";

const USAGE = "Usage: patronum map-api --handle <Instagram handle> [--surface profile|saved]";

export function networkMapArgs(argv: string[]): { handle: string; surface: NetworkMapSurface } {
  let handle: string | null = null;
  let surface: NetworkMapSurface | null = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag !== "--handle" && flag !== "--surface") throw new Error(USAGE);
    const value = argv[++index];
    if (value == null) throw new Error(USAGE);
    if (flag === "--handle") {
      if (handle != null) throw new Error("Duplicate --handle");
      handle = value.replace(/^@/, "");
    } else {
      if (surface != null) throw new Error("Duplicate --surface");
      if (value !== "profile" && value !== "saved") throw new Error("Surface must be profile or saved");
      surface = value;
    }
  }
  if (handle == null) throw new Error(USAGE);
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle) || handle === "." || handle === "..") throw new Error("Invalid Instagram handle");
  return { handle, surface: surface ?? "profile" };
}

/**
 * The owner-only Saved tab is the only saved surface; when it is missing, log
 * the tabs and navigation the page actually rendered so a wrong selector is
 * never mistaken for a non-owner account.
 */
async function profileTabEvidence(page: { evaluate(expression: string): Promise<unknown> }): Promise<unknown> {
  return page.evaluate(`(() => {
    const seen = new Set();
    const out = [];
    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href") || "";
      const text = (anchor.textContent || "").trim().slice(0, 40);
      const key = href + "|" + text;
      if (!href.startsWith("/") || /^\\/(?:p|reel|reels|tv|stories)\\//.test(href) || seen.has(key)) continue;
      seen.add(key);
      out.push({ href, text });
      if (out.length >= 40) break;
    }
    return out;
  })()`);
}

export async function mapInstagramNetwork(handle: string, surface: NetworkMapSurface = "profile") {
  const session = await ensureAuthenticatedSession({ label: "map-instagram-apis" });
  const { stagehand, page } = session;
  const traffic = await startInstagramTraffic(stagehand, { root, handle }).catch(async error => {
    await stagehand.close();
    throw error;
  });
  const uiMap = new InstagramUiMap();
  const url = `https://www.instagram.com/${handle}/`;
  try {
    console.log(`[network-map] ${surface} @${handle}`);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
    assertProfileNavigationResponse(response, url);
    await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));
    await Bun.sleep(2_000);
    if (surface === "saved") {
      // The Saved tab is owner-only; a non-owner profile never renders it.
      if (!await clickProfileTab(page as MappedPage, uiMap, "saved", handle)) {
        console.log(`[network-map] profile tabs observed: ${JSON.stringify(await profileTabEvidence(page))}`);
        throw new Error(`Could not open the Saved tab for @${handle}; the signed-in account may not own this profile`);
      }
      await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));
      await Bun.sleep(2_500);
      console.log("[network-map] observed the Saved tab");
    }
    for (let round = 0; round < 6; round++) {
      await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight * 1.6)));
      await Bun.sleep(2_500);
      await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));
      await traffic.flush();
      console.log(`[network-map] observed ${surface} scroll ${round + 1}/6`);
    }
    const href = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>("main a[href]"))
      .map(a => a.getAttribute("href") ?? "")
      .find(value => /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel)\/[A-Za-z0-9_-]+\/$/.test(value)) ?? null);
    if (href) {
      await page.locator(`a[href=${JSON.stringify(href)}]`).first().click();
      await Bun.sleep(3_000);
      await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));
      console.log(`[network-map] observed one ${surface} post opened through its link`);
    }
    await traffic.flush();
    const map = JSON.parse(await readFile(join(root, layout.apiMap), "utf8")) as { operations?: Array<{ pathTemplate: string; operation?: string }> };
    const operations = map.operations ?? [];
    return { ok: true, handle, surface, runDir: relative(root, traffic.runDir), mapPath: layout.apiMap,
      endpoints: operations.length, graphqlOperations: operations.filter(op => /graphql/i.test(op.pathTemplate)).length };
  } catch (error) {
    const evidence = getObservedDocumentResponse(page, url);
    console.error(`[network-map] document status=${evidence?.status ?? "unknown"}${evidence?.retryAfter ? ` retry-after=${evidence.retryAfter}` : ""}`);
    throw error;
  } finally {
    try { await traffic.close(); } finally { await stagehand.close(); }
  }
}

const HELP = `patronum map-api — record which Instagram routes a profile page uses

${USAGE}

  --handle <handle>            The profile to open (no URL)
  --surface profile|saved      profile (default), or the owner-only Saved tab
  -h, --help                   Help

Opens Chrome with the saved login and writes cache/instagram-api-map.json.
Prints one JSON document. Exit codes: 0 ok · 1 failed · 2 usage`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let parsed: ReturnType<typeof networkMapArgs> | null = null;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
  } else {
    try { parsed = networkMapArgs(argv); }
    catch (error) {
      const message = error instanceof Error ? error.message : "invalid arguments";
      console.log(JSON.stringify({ ok: false, error: "usage", message: message === USAGE ? "unknown or missing option" : message, usage: USAGE }));
      process.exitCode = 2;
    }
  }
  if (parsed) try {
    const { handle, surface } = parsed;
    console.log(JSON.stringify(await mapInstagramNetwork(handle, surface)));
  }
  catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Network mapping failed" }));
    process.exitCode = 1;
  }
}
