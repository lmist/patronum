/**
 * Deep Instagram UI map: multiple surfaces, observe + extract per surface,
 * scroll feed, open transient panels (search / notifications / create).
 *
 * Usage: bun src/cmd/map-deep.ts
 *        bun run map:deep
 *
 * Output: data/page-map-deep-<user>-<timestamp>.json
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Stagehand } from "@browserbasehq/stagehand";
import { ensureAuthenticatedSession } from "../sign-in/ensure-session.js";

import { DATA_HOME } from "../paths.js";
const root = DATA_HOME;

type ObservedAction = {
  description?: string;
  method?: string;
  arguments?: unknown[];
  selector?: string;
  [key: string]: unknown;
};

type SurfaceMap = {
  id: string;
  label: string;
  url: string;
  ok: boolean;
  error?: string;
  observedCount: number;
  observed: ObservedAction[];
  inputsObservedCount?: number;
  inputsObserved?: ObservedAction[];
  pageTree?: unknown;
  pageTreeChars?: number;
  durationMs: number;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function safeGoto(
  page: { goto: Function; url: () => string },
  url: string,
) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeoutMs: 45_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[deep] nav wait: ${msg} (url=${page.url()})`);
    if (!page.url() || page.url() === "about:blank") throw err;
  }
  await sleep(2800);
}

async function mapSurface(
  stagehand: Stagehand,
  page: { url: () => string; evaluate?: Function; mouse?: { wheel?: Function } },
  opts: {
    id: string;
    label: string;
    includeInputs?: boolean;
    includeTree?: boolean;
  },
): Promise<SurfaceMap> {
  const started = Date.now();
  console.log(`\n[deep] ▶ ${opts.id} — ${opts.label}`);
  console.log(`[deep]   url=${page.url()}`);

  try {
    const observed = (await stagehand.observe(
      "find ALL interactive elements on the page: every button, link, input, textarea, select, tab, menu item, icon button, and clickable control. Include feed, sidebar, headers, footers, and overlays.",
    )) as ObservedAction[];

    console.log(`[deep]   observe → ${observed.length} elements`);

    let inputsObserved: ObservedAction[] | undefined;
    if (opts.includeInputs !== false) {
      try {
        inputsObserved = (await stagehand.observe(
          "find all text inputs, search fields, textareas, contenteditable fields, and form controls where a user can type",
        )) as ObservedAction[];
        console.log(
          `[deep]   inputs → ${inputsObserved.length} typeable fields`,
        );
      } catch (err) {
        console.log(
          `[deep]   inputs failed: ${err instanceof Error ? err.message : err}`,
        );
        inputsObserved = [];
      }
    }

    let pageTree: unknown;
    let pageTreeChars = 0;
    if (opts.includeTree !== false) {
      try {
        pageTree = await stagehand.extract();
        const text =
          pageTree &&
          typeof pageTree === "object" &&
          "pageText" in (pageTree as object)
            ? String((pageTree as { pageText?: string }).pageText ?? "")
            : JSON.stringify(pageTree ?? "");
        pageTreeChars = text.length;
        console.log(`[deep]   extract → ${pageTreeChars} chars a11y tree`);
      } catch (err) {
        console.log(
          `[deep]   extract failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return {
      id: opts.id,
      label: opts.label,
      url: page.url(),
      ok: true,
      observedCount: observed.length,
      observed,
      inputsObservedCount: inputsObserved?.length,
      inputsObserved,
      pageTree,
      pageTreeChars,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[deep]   FAILED: ${message}`);
    return {
      id: opts.id,
      label: opts.label,
      url: page.url(),
      ok: false,
      error: message,
      observedCount: 0,
      observed: [],
      durationMs: Date.now() - started,
    };
  }
}

async function scrollFeed(
  page: {
    evaluate?: (fn: string | (() => void)) => Promise<unknown>;
    mouse?: { wheel?: (x: number, y: number) => Promise<void> };
  },
  times: number,
) {
  for (let i = 0; i < times; i++) {
    console.log(`[deep] scroll ${i + 1}/${times}`);
    try {
      if (page.mouse?.wheel) {
        await page.mouse.wheel(0, 1000 + i * 100);
      } else if (page.evaluate) {
        await page.evaluate(
          `window.scrollBy({ top: ${900 + i * 120}, left: 0, behavior: 'smooth' })`,
        );
      }
    } catch {
      try {
        await page.evaluate?.(`window.scrollBy(0, 900)`);
      } catch {
        // ignore
      }
    }
    await sleep(1500);
  }
  await sleep(1000);
}

async function tryActFirst(
  stagehand: Stagehand,
  instruction: string,
): Promise<boolean> {
  try {
    const actions = await stagehand.observe(instruction);
    if (!actions.length) {
      console.log(`[deep] no match for: ${instruction}`);
      return false;
    }
    await stagehand.act(actions[0]!);
    await sleep(2200);
    return true;
  } catch (err) {
    console.log(
      `[deep] act failed (${instruction}): ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

async function tryEscape(page: {
  keyPress?: (key: string) => Promise<void>;
  keyboard?: { press?: (key: string) => Promise<void> };
}) {
  try {
    if (page.keyPress) await page.keyPress("Escape");
    else if (page.keyboard?.press) await page.keyboard.press("Escape");
  } catch {
    // ignore
  }
  await sleep(800);
}

async function main() {
  const session = await ensureAuthenticatedSession({
    label: "deep",
    keepAlive: true,
  });
  const { stagehand, account, page } = session;
  const surfaces: SurfaceMap[] = [];

  try {
    // ── 1. Home feed (top) ──────────────────────────────────────────
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "home",
        label: "Home feed (top)",
      }),
    );

    // ── 2. Home after scroll ────────────────────────────────────────
    await scrollFeed(page, 3);
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "home-scrolled",
        label: "Home feed (after 3 scrolls)",
        includeTree: true,
      }),
    );

    // ── 3. Search panel ─────────────────────────────────────────────
    await safeGoto(page, "https://www.instagram.com/");
    const openedSearch = await tryActFirst(
      stagehand,
      "find the Search navigation link or button in the left sidebar",
    );
    if (openedSearch) {
      surfaces.push(
        await mapSurface(stagehand, page, {
          id: "search-panel",
          label: "Search panel / overlay",
        }),
      );
      await tryEscape(page);
    } else {
      surfaces.push({
        id: "search-panel",
        label: "Search panel / overlay",
        url: page.url(),
        ok: false,
        error: "could not open Search",
        observedCount: 0,
        observed: [],
        durationMs: 0,
      });
    }

    // ── 4. Notifications panel ──────────────────────────────────────
    const openedNotif = await tryActFirst(
      stagehand,
      "find the Notifications navigation link or button in the left sidebar",
    );
    if (openedNotif) {
      surfaces.push(
        await mapSurface(stagehand, page, {
          id: "notifications-panel",
          label: "Notifications panel / overlay",
        }),
      );
      await tryEscape(page);
    }

    // ── 5. Create new post dialog ───────────────────────────────────
    const openedCreate = await tryActFirst(
      stagehand,
      "find the New post or Create navigation link or button in the left sidebar",
    );
    if (openedCreate) {
      surfaces.push(
        await mapSurface(stagehand, page, {
          id: "create-dialog",
          label: "Create / New post dialog",
        }),
      );
      await tryEscape(page);
      await tryEscape(page);
    }

    // ── 6. Explore ──────────────────────────────────────────────────
    await safeGoto(page, "https://www.instagram.com/explore/");
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "explore",
        label: "Explore page",
      }),
    );

    // ── 7. Reels ────────────────────────────────────────────────────
    await safeGoto(page, "https://www.instagram.com/reels/");
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "reels",
        label: "Reels page",
      }),
    );

    // ── 8. Direct / Messages ────────────────────────────────────────
    await safeGoto(page, "https://www.instagram.com/direct/inbox/");
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "direct-inbox",
        label: "Direct messages inbox",
      }),
    );

    // ── 9. Own profile ──────────────────────────────────────────────
    await safeGoto(page, `https://www.instagram.com/${account.user}/`);
    surfaces.push(
      await mapSurface(stagehand, page, {
        id: "profile-self",
        label: `Own profile @${account.user}`,
      }),
    );

    // ── 10. Profile → following (if present) ────────────────────────
    const openedFollowing = await tryActFirst(
      stagehand,
      "find the following count link or following button on the profile page",
    );
    if (openedFollowing) {
      surfaces.push(
        await mapSurface(stagehand, page, {
          id: "profile-following",
          label: "Following list modal",
          includeTree: false,
        }),
      );
      await tryEscape(page);
    }

    // ── Aggregate ───────────────────────────────────────────────────
    const outDir = resolve(root, "data");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(
      outDir,
      `page-map-deep-${account.user}-${stamp}.json`,
    );

    // Index of all unique action descriptions across surfaces
    const byDescription = new Map<
      string,
      { surfaces: string[]; methods: Set<string>; sampleSelector?: string }
    >();
    for (const s of surfaces) {
      for (const el of s.observed) {
        const desc = String(el.description ?? "").trim() || "(no description)";
        const entry = byDescription.get(desc) ?? {
          surfaces: [],
          methods: new Set<string>(),
        };
        if (!entry.surfaces.includes(s.id)) entry.surfaces.push(s.id);
        if (el.method) entry.methods.add(String(el.method));
        if (!entry.sampleSelector && el.selector)
          entry.sampleSelector = String(el.selector);
        byDescription.set(desc, entry);
      }
    }

    const catalog = [...byDescription.entries()]
      .map(([description, v]) => ({
        description,
        methods: [...v.methods],
        surfaces: v.surfaces,
        sampleSelector: v.sampleSelector,
      }))
      .sort((a, b) => a.description.localeCompare(b.description));

    const summary = surfaces.map((s) => ({
      id: s.id,
      label: s.label,
      ok: s.ok,
      url: s.url,
      observedCount: s.observedCount,
      inputsObservedCount: s.inputsObservedCount ?? 0,
      pageTreeChars: s.pageTreeChars ?? 0,
      durationMs: s.durationMs,
      error: s.error,
    }));

    const payload = {
      ok: surfaces.some((s) => s.ok),
      mode: "deep",
      user: account.user,
      sessionId: session.sessionId,
      liveUrl: session.liveUrl,
      profileDir: session.profileDir,
      didLogin: session.didLogin,
      mappedAt: new Date().toISOString(),
      surfaceCount: surfaces.length,
      totalObserved: surfaces.reduce((n, s) => n + s.observedCount, 0),
      uniqueDescriptions: catalog.length,
      summary,
      catalog,
      surfaces,
    };

    writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
    console.log(`\n[deep] wrote ${outPath}`);

    console.log("\n========== DEEP MAP SUMMARY ==========\n");
    for (const s of summary) {
      const status = s.ok ? "ok" : "FAIL";
      console.log(
        `  [${status}] ${s.id.padEnd(22)} observe=${String(s.observedCount).padStart(3)}  inputs=${String(s.inputsObservedCount).padStart(2)}  tree=${s.pageTreeChars}ch  ${s.durationMs}ms`,
      );
      if (s.error) console.log(`         error: ${s.error}`);
    }
    console.log(
      `\n  totals: surfaces=${surfaces.length}  observed-actions=${payload.totalObserved}  unique-descriptions=${catalog.length}`,
    );
    console.log(`  out: ${outPath}\n`);

    console.log(
      JSON.stringify(
        {
          ok: payload.ok,
          user: account.user,
          liveUrl: session.liveUrl,
          surfaceCount: surfaces.length,
          totalObserved: payload.totalObserved,
          uniqueDescriptions: catalog.length,
          summary,
          outPath,
        },
        null,
        2,
      ),
    );
  } finally {
    await stagehand.close();
    console.log("[deep] session closed");
  }
}

main().catch((err) => {
  console.error("[deep] error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
