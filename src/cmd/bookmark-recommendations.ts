/** Save distinct posts from this account's personalized Explore feed. */
import "dotenv/config";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStagehand } from "../browser/stagehand.js";
import { assertAuthenticated } from "../sign-in/auth-check.js";
import {
  BookmarkApi, InstagramApiError, explorePageInfo, recommendationsFromExplore,
  SAVED_QUERY_ID, SAVE_MUTATION_ID,
  type InstagramSession, type Recommendation,
} from "../saved/bookmark-recommendations.js";

type Saved = Recommendation & { savedTime?: number };
type Progress = {
  version: 1; account: string; baseline: string[]; startedAt: string; updatedAt: string;
  target: number; status: "running" | "stopped" | "complete" | "rejected" | "uncertain" | "exhausted" | "verification-failed";
  cursor: string | null; pages: number; emptyPages: number; seen: string[];
  queue: Recommendation[]; saved: Saved[]; inFlight: Recommendation | null;
  error?: string;
};

import { DATA_HOME, layout } from "../paths.js";
const root = DATA_HOME;
const progressDir = join(root, layout.bookmarksDir);
const MAX_PAGES = 500;
const DATE_POLL_DELAYS_MS = [0, 2_000, 4_000, 8_000, 16_000, 30_000];
const DATE_BATCH_SIZE = 20;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

function args(argv: string[]): { account: string; target: number; inspect: boolean; reconcileOnly: boolean } {
  let account = "";
  let target = 2000;
  let inspect = false;
  let reconcileOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--account") account = argv[++i] ?? "";
    else if (arg === "--target") target = Number(argv[++i]);
    else if (arg === "--inspect") inspect = true;
    else if (arg === "--reconcile-only") reconcileOnly = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!/^[A-Za-z0-9._]{1,30}$/.test(account)) throw new Error("--account must be an Instagram handle");
  if (!Number.isInteger(target) || target < 1 || target > 2000) throw new Error("--target must be an integer from 1 to 2000");
  if (inspect && reconcileOnly) throw new Error("Choose either --inspect or --reconcile-only");
  return { account, target, inspect, reconcileOnly };
}

function progressPath(account: string): string { return join(progressDir, `recommendations-${account}.json`); }
function withAccountLock(account: string, task: () => Promise<void>): Promise<void> {
  mkdirSync(progressDir, { recursive: true });
  const path = join(progressDir, `recommendations-${account}.lock`);
  try { mkdirSync(path); }
  catch {
    let owner = 0;
    try { owner = Number(readFileSync(join(path, "pid"), "utf8")); } catch {}
    if (owner > 0) {
      try { process.kill(owner, 0); } catch { owner = 0; }
    }
    const tooNew = Date.now() - statSync(path).mtimeMs < 60_000;
    if (owner > 0 || (!existsSync(join(path, "pid")) && tooNew)) {
      throw new Error(`Another bookmark command owns @${account}; stop it before starting another`);
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
  }
  writeFileSync(join(path, "pid"), String(process.pid), { mode: 0o600 });
  return task().finally(() => rmSync(path, { recursive: true, force: true }));
}

function verifyLocalRegistry(): void {
  const registryPath = join(root, "data/research/bookmark-dates/native/apk/ig4a-instagram-schema_client_persist_ids.json");
  if (!existsSync(registryPath)) return;
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { client_doc_id?: string }>;
  if (registry.IGCrossAppSavesQuery?.client_doc_id !== SAVED_QUERY_ID ||
      registry.IGMediaSaveMutation?.client_doc_id !== SAVE_MUTATION_ID) {
    throw new Error("Saved-query or save-mutation ID differs from the verified local Instagram registry");
  }
}
function writeProgress(path: string, state: Progress): void {
  mkdirSync(progressDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}
function readProgress(path: string, account: string): Progress | null {
  if (!existsSync(path)) return null;
  const state = JSON.parse(readFileSync(path, "utf8")) as Progress;
  if (state.version !== 1 || state.account !== account || !Array.isArray(state.baseline) ||
      !Array.isArray(state.saved) || !Array.isArray(state.queue) || !Array.isArray(state.seen)) {
    throw new Error("Bookmark checkpoint is invalid or belongs to another account");
  }
  return state;
}

async function authenticatedSession(account: string): Promise<InstagramSession> {
  const browser = createStagehand({ headless: true });
  try {
    await browser.init();
    const page = browser.context.pages()[0]!;
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeoutMs: 45_000 });
    await Bun.sleep(1500);
    await assertAuthenticated(page);
    const identity = await page.evaluate(`(() => ({
      account: [...document.querySelectorAll('nav a[href], a[href]')]
        .filter(a => /profile/i.test((a.getAttribute('aria-label') || '') + ' ' + (a.textContent || '')))
        .map(a => /^\\/([A-Za-z0-9._]+)\\/$/.exec(a.getAttribute('href') || '')?.[1])
        .find(Boolean) || null,
      userAgent: navigator.userAgent
    }))()`);
    const result = identity as { account: string | null; userAgent: string };
    if (!result.account || result.account.toLowerCase() !== account.toLowerCase()) {
      throw new Error(`Authenticated account ${result.account ?? "unknown"} does not match requested @${account}`);
    }
    const cookies = await browser.context.cookies(["https://www.instagram.com"]);
    return { account: result.account, userAgent: result.userAgent,
      cookies: cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain })) };
  } finally { await browser.close(); }
}

function status(state: Progress, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: "progress", account: state.account, status: state.status,
    target: state.target, saved: state.saved.length, pages: state.pages, queue: state.queue.length,
    ...extra }));
}

async function reconcile(api: BookmarkApi, state: Progress, path: string): Promise<Map<string, number>> {
  const wanted = new Set(state.saved.filter(item => !item.savedTime).map(item => item.shortcode));
  if (state.inFlight) wanted.add(state.inFlight.shortcode);
  if (!wanted.size) return new Map();
  let dates = await api.savedDates(100, wanted);
  for (const delay of DATE_POLL_DELAYS_MS.slice(1)) {
    if ([...wanted].every(shortcode => dates.has(shortcode))) break;
    if (stopping) throw new Error("Stopped while waiting for saved dates");
    await Bun.sleep(delay);
    dates = await api.savedDates(100, wanted);
  }
  const missing = [...wanted].filter(shortcode => !dates.has(shortcode));
  if (missing.length) {
    throw new Error(`Saved-date confirmation did not arrive within the bounded polling window for ${missing.join(", ")}`);
  }
  for (const item of state.saved) {
    if (item.savedTime) continue;
    const entry = dates.get(item.shortcode);
    if (!entry) throw new Error(`Previously confirmed save ${item.shortcode} is absent from current saved-date pages`);
    item.savedTime = entry.savedTime;
  }
  if (state.inFlight) {
    const entry = dates.get(state.inFlight.shortcode);
    if (entry && !state.baseline.includes(state.inFlight.shortcode) &&
        !state.saved.some(item => item.shortcode === state.inFlight?.shortcode)) {
      state.saved.push({ ...state.inFlight, savedTime: entry.savedTime });
    }
    state.inFlight = null;
  }
  writeProgress(path, state);
  return new Map([...dates].map(([shortcode, entry]) => [shortcode, entry.savedTime]));
}

async function run(): Promise<void> {
  const { account, target, inspect, reconcileOnly } = args(process.argv.slice(2));
  verifyLocalRegistry();
  const path = progressPath(account);
  let state = readProgress(path, account);
  if (state?.status === "rejected" && !reconcileOnly && !inspect) {
    throw new Error("Previous run hit an explicit Instagram rejection; use --reconcile-only after the restriction clears before resuming saves");
  }
  console.log(JSON.stringify({ event: "session", phase: "open", account, headless: true }));
  const session = await authenticatedSession(account);
  const api = new BookmarkApi(session);
  // Do not retain browser cookies in the checkpoint or process output.
  const existing = await api.savedDates();
  if (reconcileOnly) {
    if (!state) throw new Error("No bookmark checkpoint exists to reconcile");
    const missing = state.saved.filter(item => !existing.has(item.shortcode));
    if (missing.length) throw new Error(`${missing.length} mutation-confirmed saves still lack saved-date evidence; checkpoint remains ${state.status}`);
    for (const item of state.saved) item.savedTime = existing.get(item.shortcode)!.savedTime;
    if (state.inFlight) {
      const inFlight = state.inFlight;
      const entry = existing.get(inFlight.shortcode);
      if (!entry) throw new Error(`In-flight ${inFlight.shortcode} is still unconfirmed; checkpoint remains ${state.status}`);
      if (!state.saved.some(item => item.shortcode === inFlight.shortcode)) {
        state.saved.push({ ...inFlight, savedTime: entry.savedTime });
      }
      state.inFlight = null;
    }
    state.status = "stopped";
    delete state.error;
    writeProgress(path, state);
    status(state, { dated: state.saved.length, totalSavedEntries: existing.size, recoveryReady: true });
    return;
  }
  const first = await api.explore(null);
  const firstRecommendations = recommendationsFromExplore(first);
  const firstPagination = explorePageInfo(first);
  console.log(JSON.stringify({ event: "preflight", account, existingSaves: existing.size,
    recommendations: firstRecommendations.length, nextCursor: firstPagination.next,
    more: firstPagination.more }));
  if (inspect) return;

  if (!state) {
    state = { version: 1, account, baseline: [...existing.keys()], startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), target, status: "running", cursor: firstPagination.next,
      pages: 1, emptyPages: 0, seen: firstRecommendations.map(item => item.shortcode),
      queue: firstRecommendations.filter(item => !existing.has(item.shortcode)), saved: [], inFlight: null };
  } else {
    for (const item of state.saved) if (!existing.has(item.shortcode)) {
      throw new Error(`Previously confirmed save ${item.shortcode} is absent from the current saved-date pages`);
    }
    state.target = target;
    state.status = "running";
    delete state.error;
    await reconcile(api, state, path);
  }
  const savedNow = new Set(existing.keys());
  for (const item of state.saved) savedNow.add(item.shortcode);
  writeProgress(path, state);
  status(state);

  try {
    while (!stopping && state.saved.length < state.target) {
      if (state.queue.length === 0) {
        if (state.pages >= MAX_PAGES || state.emptyPages >= 10 || state.cursor === null) {
          state.status = "exhausted";
          break;
        }
        const page = await api.explore(state.cursor);
        const candidates = recommendationsFromExplore(page);
        const pagination = explorePageInfo(page);
        const seen = new Set(state.seen);
        const fresh = candidates.filter(item => !seen.has(item.shortcode) && !savedNow.has(item.shortcode));
        for (const item of candidates) seen.add(item.shortcode);
        state.seen = [...seen];
        state.queue.push(...fresh);
        state.cursor = pagination.next;
        state.pages++;
        state.emptyPages = fresh.length ? 0 : state.emptyPages + 1;
        writeProgress(path, state);
        status(state, { discovered: fresh.length });
        continue;
      }
      const item = state.queue.shift()!;
      if (savedNow.has(item.shortcode)) { writeProgress(path, state); continue; }
      state.inFlight = item;
      writeProgress(path, state);
      // Never automatically retry a mutation: an interrupted call is reconciled
      // against Instagram's saved-date query on the next invocation.
      await api.save(item.mediaId);
      state.saved.push(item);
      savedNow.add(item.shortcode);
      state.inFlight = null;
      writeProgress(path, state);
      status(state, { shortcode: item.shortcode });
      if (state.saved.length % DATE_BATCH_SIZE === 0 || state.saved.length >= state.target) {
        await reconcile(api, state, path);
        status(state, { dated: state.saved.filter(saved => saved.savedTime).length,
          batchConfirmed: true });
      }
      if (!stopping && state.saved.length < state.target) await Bun.sleep(1200);
    }
    if (stopping) state.status = "stopped";
    else if (state.saved.length >= state.target) state.status = "complete";
    writeProgress(path, state);
    // Paginate the server's saved_time entries; UI labels and publication times
    // cannot establish when an item was bookmarked.
    await reconcile(api, state, path);
    const allDates = await api.savedDates();
    for (const item of state.saved) if (!allDates.has(item.shortcode)) throw new Error(`Missing saved date for ${item.shortcode}`);
    status(state, { dated: state.saved.filter(item => item.savedTime).length, totalSavedEntries: allDates.size });
  } catch (error) {
    state.status = error instanceof InstagramApiError && error.status ? "rejected" : "uncertain";
    state.error = error instanceof Error ? error.message : String(error);
    writeProgress(path, state);
    status(state, { error: state.error });
    throw error;
  }
  if (state.status !== "complete" && state.status !== "stopped") throw new Error(`Run ended ${state.status}`);
}

const USAGE = `patronum saved — the signed-in account's Explore recommendations and bookmarks

USAGE
  patronum saved --account <handle> --inspect
  patronum saved --account <handle> --target <count>
  patronum saved --account <handle> --reconcile-only

OPTIONS
  --account <handle>   The signed-in Instagram account (required; no @, no URL)
  --inspect            Read the recommendations; change nothing
  --target <count>     Save posts to the account's bookmarks until it holds <count> (1 to 2000).
                       This changes the Instagram account.
  --reconcile-only     Re-read saved dates for posts already recorded; save nothing
  -h, --help           Help

EXIT CODES
  0 ok · 1 failed · 2 usage
`;

let command!: ReturnType<typeof args>;

function main(argv: string[]): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  try {
    command = args(argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  withAccountLock(command.account, run).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

main(process.argv.slice(2));
