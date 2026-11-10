/**
 * Drive from saved deep map: open Notifications via mapped ObserveResult,
 * fall back to observe→act if the cached selector is stale, then extract
 * and log the current notification list.
 *
 * Usage: bun src/cmd/log-notifications.ts [--map PATH]
 *        bun run notifications
 */
import "dotenv/config";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Stagehand } from "@browserbasehq/stagehand";
import { getAccount } from "../sign-in/accounts.js";
import { ensureAuthenticatedSession } from "../sign-in/ensure-session.js";

import { DATA_HOME } from "../paths.js";
const root = DATA_HOME;

type MapAction = {
  description?: string;
  method?: string;
  arguments?: unknown[];
  selector?: string;
  [key: string]: unknown;
};

type DeepMap = {
  user?: string;
  surfaces?: Array<{
    id: string;
    observed?: MapAction[];
  }>;
  catalog?: Array<{
    description: string;
    sampleSelector?: string;
    methods?: string[];
    surfaces?: string[];
  }>;
};

// Use .nullable() — models often emit null for missing optionals
const NotificationItemSchema = z.object({
  text: z
    .string()
    .describe("Full notification text as shown (who did what)"),
  actor: z
    .string()
    .nullable()
    .optional()
    .describe("Username or display name of the actor, if visible"),
  kind: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Rough type: like, comment, follow, mention, story, live, suggested, other",
    ),
  timeAgo: z
    .string()
    .nullable()
    .optional()
    .describe("Relative time label if shown, e.g. 2h, 1d; null if absent"),
  isUnread: z
    .boolean()
    .nullable()
    .optional()
    .describe("True if the row looks unread/highlighted"),
});

const NotificationsSchema = z.object({
  panelOpen: z
    .boolean()
    .describe("Whether a notifications panel or list is visible"),
  empty: z
    .boolean()
    .describe(
      "True only if there is no activity AND no suggested rows; false if suggested-for-you rows exist",
    ),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe("Heading or empty-state message (e.g. Activity on your posts)"),
  activityEmpty: z
    .boolean()
    .nullable()
    .optional()
    .describe("True if likes/comments activity section is empty"),
  notifications: z
    .array(NotificationItemSchema)
    .describe(
      "Each distinct row: real activity (likes/comments/follows) and suggested accounts",
    ),
});

function parseArgs(argv: string[]) {
  let mapPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--map") mapPath = argv[++i];
    else if (a.startsWith("--map=")) mapPath = a.slice("--map=".length);
  }
  return { mapPath };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function latestDeepMapPath(forUser?: string): string {
  const dataDir = resolve(root, "data");
  if (!existsSync(dataDir)) {
    throw new Error(`No data/ dir — run map-deep first`);
  }
  const files = readdirSync(dataDir)
    .filter((f) => f.startsWith("page-map-deep-") && f.endsWith(".json"))
    .filter((f) => (forUser ? f.includes(`-${forUser}-`) : true))
    .sort();
  if (!files.length) {
    throw new Error(
      `No page-map-deep-*.json in data/ — run: bun run map:deep`,
    );
  }
  return resolve(dataDir, files[files.length - 1]!);
}

function loadDeepMap(path: string): DeepMap {
  return JSON.parse(readFileSync(path, "utf8")) as DeepMap;
}

/** Prefer home surface Notifications entry; else catalog sample. */
function pickNotificationsOpenAction(map: DeepMap): MapAction {
  const preferSurfaces = [
    "home",
    "home-scrolled",
    "notifications-panel",
    "search-panel",
    "explore",
  ];
  const isNotif = (desc: string) =>
    /notif/i.test(desc) && !/like count|footer/i.test(desc);

  for (const id of preferSurfaces) {
    const surface = map.surfaces?.find((s) => s.id === id);
    const hit = surface?.observed?.find(
      (o) => o.description && isNotif(o.description),
    );
    if (hit?.selector) {
      console.log(
        `[notif] map action from surface=${id}: "${hit.description}"`,
      );
      return hit;
    }
  }

  const cat = map.catalog?.find(
    (c) => isNotif(c.description) && c.sampleSelector,
  );
  if (cat?.sampleSelector) {
    console.log(`[notif] map action from catalog: "${cat.description}"`);
    return {
      description: cat.description,
      method: cat.methods?.[0] ?? "click",
      arguments: [],
      selector: cat.sampleSelector,
    };
  }

  throw new Error(
    "Deep map has no Notifications control — re-run map-deep while logged in",
  );
}

async function openNotificationsPanel(
  stagehand: Stagehand,
  mapped: MapAction,
): Promise<"map" | "observe-fallback" | "act-string"> {
  const observeInstruction =
    "find the Notifications navigation link or button in the left sidebar or bottom nav";

  // 1) Try mapped ObserveResult (selector from deep map)
  try {
    console.log(`[notif] act from map: ${mapped.description}`);
    await stagehand.act(mapped as never);
    await sleep(2500);
    if (await isNotificationsPanelOpen(stagehand)) {
      console.log("[notif] panel open via map act");
      return "map";
    }
    console.log("[notif] map act ran but panel not visible; falling back…");
  } catch (err) {
    console.log(
      `[notif] map act failed (${err instanceof Error ? err.message : err}); falling back…`,
    );
  }

  // 2) Fresh observe → act
  try {
    const found = await stagehand.observe(observeInstruction);
    if (found.length) {
      console.log(
        `[notif] observe fallback → acting: ${(found[0] as MapAction).description}`,
      );
      await stagehand.act(found[0]!);
      await sleep(2500);
      if (await isNotificationsPanelOpen(stagehand)) {
        return "observe-fallback";
      }
    }
  } catch (err) {
    console.log(
      `[notif] observe fallback failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  // 3) Plain act string (may hit cacheDir)
  console.log("[notif] act-string fallback…");
  await stagehand.act(
    "click the Notifications link or button in the left sidebar",
  );
  await sleep(2500);
  return "act-string";
}

async function isNotificationsPanelOpen(stagehand: Stagehand): Promise<boolean> {
  try {
    const probe = await stagehand.extract(
      "Is the Instagram notifications / activity panel currently open and showing notification rows, an empty activity state, or a Today/This week activity list? Answer based on visible UI only.",
      z.object({
        open: z.boolean().describe("True if notifications/activity UI is open"),
        detail: z.string().optional(),
      }),
    );
    console.log(
      `[notif] panel probe: open=${probe.open}${probe.detail ? ` (${probe.detail})` : ""}`,
    );
    return probe.open;
  } catch {
    return false;
  }
}

async function main() {
  const { mapPath: mapArg } = parseArgs(process.argv.slice(2));
  const accountHint = getAccount().user;
  const mapPath = mapArg
    ? resolve(mapArg)
    : latestDeepMapPath(accountHint);

  console.log(`[notif] using map: ${mapPath}`);
  const map = loadDeepMap(mapPath);
  const openAction = pickNotificationsOpenAction(map);

  const session = await ensureAuthenticatedSession({ label: "notif" });
  const { stagehand, account, page } = session;

  try {
    const pathUsed = await openNotificationsPanel(stagehand, openAction);
    await sleep(2000);

    console.log(`[notif] extracting notification list (url=${page.url()})…`);
    let extracted = await stagehand.extract(
      "Read the Instagram notifications panel or activity feed that is currently open (left drawer or full page). List every notification row visible: who acted, what happened, relative time if shown, and whether it looks unread. Include likes, comments, follows, mentions, suggested follows, and system notices. If empty, set empty true. Do not invent notifications.",
      NotificationsSchema,
    );

    // One more open+extract pass if we still have nothing
    if (!extracted.panelOpen && extracted.notifications.length === 0) {
      console.log("[notif] empty result; retry open + extract…");
      await stagehand.act(
        "click the Notifications link in the navigation sidebar",
      );
      await sleep(3500);
      extracted = await stagehand.extract(
        "Read the Instagram notifications panel or activity feed that is currently open. List every notification row visible: who acted, what happened, relative time if shown, and whether it looks unread. If empty, set empty true. Do not invent notifications.",
        NotificationsSchema,
      );
    }

    const outDir = resolve(root, "data");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = resolve(
      outDir,
      `notifications-${account.user}-${stamp}.json`,
    );

    const payload = {
      ok: true,
      user: account.user,
      sessionId: session.sessionId,
      liveUrl: session.liveUrl,
      profileDir: session.profileDir,
      didLogin: session.didLogin,
      mapPath,
      openAction: {
        description: openAction.description,
        method: openAction.method,
        selector: openAction.selector,
      },
      openPath: pathUsed,
      url: page.url(),
      extracted,
      loggedAt: new Date().toISOString(),
    };

    writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

    console.log("\n========== NOTIFICATIONS ==========\n");
    console.log(`panelOpen: ${extracted.panelOpen}  empty: ${extracted.empty}`);
    if (extracted.summary) console.log(`summary: ${extracted.summary}`);
    console.log(`count: ${extracted.notifications.length}\n`);

    if (!extracted.notifications.length) {
      console.log("(no notification rows extracted)");
    } else {
      for (let i = 0; i < extracted.notifications.length; i++) {
        const n = extracted.notifications[i]!;
        const bits = [
          n.isUnread ? "UNREAD" : "read",
          n.kind,
          n.timeAgo,
          n.actor,
        ].filter(Boolean);
        console.log(
          `${String(i + 1).padStart(3)}. [${bits.join(" · ")}] ${n.text}`,
        );
      }
    }

    console.log(`\n[notif] wrote ${outPath}`);
    console.log(
      JSON.stringify(
        {
          ok: true,
          user: account.user,
          openPath: pathUsed,
          count: extracted.notifications.length,
          empty: extracted.empty,
          panelOpen: extracted.panelOpen,
          outPath,
          liveUrl: session.liveUrl,
        },
        null,
        2,
      ),
    );
  } finally {
    await stagehand.close();
    console.log("[notif] session closed");
  }
}

main().catch((err) => {
  console.error("[notif] error:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
