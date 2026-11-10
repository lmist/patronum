/**
 * One-off: open authenticated Instagram session, then map page elements
 * via stagehand.observe() and stagehand.extract().
 *
 * Usage: bun src/cmd/map-elements.ts
 *        bun run map
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ensureAuthenticatedSession } from "../sign-in/ensure-session.js";

import { DATA_HOME } from "../paths.js";
const root = DATA_HOME;

async function main() {
  const session = await ensureAuthenticatedSession({ label: "map" });
  const { stagehand, account, page } = session;

  try {
    const url = page.url();
    console.log(`[map] authenticated page url: ${url}`);
    console.log(`[map] running observe("find all interactive elements")…`);

    const observed = await stagehand.observe(
      "find all interactive elements on the page",
    );

    console.log(`[map] observe returned ${observed.length} element(s)`);

    console.log(`[map] running extract() for page structure…`);
    let pageTree: unknown = null;
    try {
      pageTree = await stagehand.extract();
    } catch (err) {
      console.log(
        `[map] extract() failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    console.log(`[map] running observe for primary navigation / chrome…`);
    let navObserved: unknown[] = [];
    try {
      navObserved = await stagehand.observe(
        "find primary navigation links and buttons: Home, Search, Explore, Reels, Messages, Notifications, Create, Profile, and any other top-level app chrome",
      );
    } catch (err) {
      console.log(
        `[map] nav observe failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    const outDir = resolve(root, "data");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(outDir, `page-map-${account.user}-${stamp}.json`);

    const payload = {
      ok: true,
      user: account.user,
      sessionId: session.sessionId,
      liveUrl: session.liveUrl,
      profileDir: session.profileDir,
      didLogin: session.didLogin,
      url,
      observedCount: observed.length,
      observed,
      navObservedCount: Array.isArray(navObserved) ? navObserved.length : 0,
      navObserved,
      pageTree,
      mappedAt: new Date().toISOString(),
    };

    writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[map] wrote ${outPath}`);

    console.log("\n--- OBSERVE: interactive elements ---\n");
    for (let i = 0; i < observed.length; i++) {
      const el = observed[i] as unknown as Record<string, unknown>;
      const desc =
        el.description ?? el.instruction ?? el.selector ?? JSON.stringify(el);
      const method = el.method ?? el.action ?? "";
      console.log(
        `${String(i + 1).padStart(3)}. ${method ? `[${method}] ` : ""}${desc}`,
      );
    }

    if (Array.isArray(navObserved) && navObserved.length > 0) {
      console.log("\n--- OBSERVE: nav / chrome ---\n");
      for (let i = 0; i < navObserved.length; i++) {
        const el = navObserved[i] as unknown as Record<string, unknown>;
        const desc =
          el.description ?? el.instruction ?? el.selector ?? JSON.stringify(el);
        const method = el.method ?? el.action ?? "";
        console.log(
          `${String(i + 1).padStart(3)}. ${method ? `[${method}] ` : ""}${desc}`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          user: account.user,
          sessionId: session.sessionId,
          liveUrl: session.liveUrl,
          didLogin: session.didLogin,
          url,
          observedCount: observed.length,
          navObservedCount: Array.isArray(navObserved)
            ? navObserved.length
            : 0,
          outPath,
        },
        null,
        2,
      ),
    );
  } finally {
    await stagehand.close();
    console.log("[map] session closed");
  }
}

main().catch((err) => {
  console.error("[map] error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
