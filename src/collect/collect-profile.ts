/**
 * Collect one Instagram profile. Start reading here.
 *
 * `collectProfile` runs the steps in order; each step lives in its own file:
 *
 *   1. open-profile.ts     go to the profile and confirm we are signed in
 *   2. read-header.ts      name, picture, bio, counts
 *   3. scroll-grid.ts      scroll and list the posts and reels
 *   4. merge-posts.ts      combine with what an earlier run saved (resume.ts)
 *   5. open-every-post.ts  complete each post: Instagram's own responses first
 *                          (read-posts-from-api.ts), then one tab per post
 *                          (open-post.ts, read-post.ts)
 *   6. write-profile.ts    save data/profiles/<handle>-profile.json
 *
 * Shared pieces: run.ts (what the steps pass around), post-shape.ts (one
 * post), links.ts (URLs), pacing.ts (waits), rejections.ts (when Instagram
 * says no).
 */
import { resolve } from "node:path";
import { DATA_HOME, inHome, layout } from "../paths.js";
import { getAccount } from "../sign-in/accounts.js";
import { AuthError } from "../sign-in/auth-check.js";
import { ensureAuthenticatedSession, type EnsuredSession } from "../sign-in/ensure-session.js";
import { loginInstagram } from "../sign-in/login.js";
import { LlmError, pingLlm, pingToError } from "../llm/preflight.js";
import { resolveQwenApiKey, resolveQwenBaseUrl, resolveQwenModelName } from "../llm/qwen.js";
import { startInstagramTraffic, type TrafficRecorder } from "../api-map/traffic-recorder.js";
import { InstagramUiMap } from "../api-map/ui-map.js";
import { usernameFromUrl } from "./links.js";
import { mergeWithEarlierRun } from "./merge-posts.js";
import { fillInEveryPost } from "./open-every-post.js";
import { classifyEnsureSessionError, openProfile } from "./open-profile.js";
import { readHeader } from "./read-header.js";
import { alreadyComplete, loadPrior, wipeProfileArtifacts } from "./resume.js";
import type { CollectOptions, CollectRun, PostLists } from "./run.js";
import { harvestDom, listPosts } from "./scroll-grid.js";
import { writeProfile, type CollectSummary } from "./write-profile.js";

export type { CollectOptions } from "./run.js";
export type { CollectSummary } from "./write-profile.js";

export async function collectProfile(options: CollectOptions): Promise<CollectSummary> {
  const handle = usernameFromUrl(options.url) ?? "profile";
  const outPath = resolve(options.out ?? inHome(layout.profileJson(handle)));
  const scrollRounds =
    options.scrollRounds ?? Math.min(50, Math.max(16, Math.ceil(options.max / 4)));

  await runScrapeLlmPreflight(options.skipLlmPreflight);

  if (options.fresh) wipeProfileArtifacts(handle, outPath);
  const prior = options.resume && !options.fresh ? loadPrior(outPath) : null;
  if (prior) {
    console.log(
      `[scrape] resume: loaded prior posts=${prior.posts?.length ?? 0} reels=${prior.reels?.length ?? 0}`,
    );
  }

  if (options.forceLogin) await forceLogin();
  const session = await openSession();
  const { stagehand, page } = session;
  const notes: string[] = [];
  if (prior?.notes) notes.push(...prior.notes.map((n) => `[prior] ${n}`));

  let run: CollectRun | undefined;
  let traffic: TrafficRecorder | undefined;
  try {
    traffic = await startInstagramTraffic(stagehand, { root: DATA_HOME, handle });
    run = {
      options, url: options.url, handle, outPath, scrollRounds, prior, notes,
      session, stagehand, page, uiMap: new InstagramUiMap(), traffic,
    };

    await openProfile(run);
    const header = await readHeader(run);

    // Initial DOM for pfp
    let pageHarvest = await harvestDom(page);
    const grid = await listPosts(run, header);
    // Final harvest for pfp if still missing
    pageHarvest = (await harvestDom(page)) ?? pageHarvest;

    const lists: PostLists = { ...mergeWithEarlierRun(run, grid), complete: alreadyComplete(prior) };

    // Mandatory: open every post/reel for full media unless --no-detail
    if (options.detail) await fillInEveryPost(run, header, lists);
    else notes.push("detail pass skipped (--no-detail); media may be grid-thumb only");

    const summary = writeProfile(run, header, pageHarvest, lists);
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    try { await run?.cdpDetail?.close(); await traffic?.close(); } finally { await stagehand.close(); }
    console.log("[scrape] session closed");
  }
}

/**
 * Force login path: full login flow. A failed login dies with AuthError
 * (exit 3) — never continue with a public / cold scrape.
 */
async function forceLogin(): Promise<void> {
  console.log(`[scrape] --force-login: running loginInstagram…`);
  const account = getAccount();
  try {
    await loginInstagram(account);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const state = /state=(totp|checkpoint|login|home|unknown)/i.exec(msg)?.[1]?.toLowerCase() ?? "login";
    throw new AuthError(`force-login failed: ${msg}`, {
      state,
      evidence: { ok: false, reason: `force-login failed: ${msg}`, state },
    });
  }
}

async function openSession(): Promise<EnsuredSession> {
  try {
    return await ensureAuthenticatedSession({ label: "scrape-profile" });
  } catch (err) {
    throw classifyEnsureSessionError(err);
  }
}

/** Check the model answers before any browser starts or any file is touched. */
export async function runScrapeLlmPreflight(skipLlmPreflight = false) {
  if (skipLlmPreflight) {
    console.log("[scrape] LLM preflight skipped by request");
  } else {
    // Fail-closed LLM preflight BEFORE any Chrome start / disk mutation.
    // Missing key throws immediately; unreachable base URL / bad key / bad model
    // / exhausted quota all die with exit 4 before we launch a browser.
    let apiKey: string;
    try {
      apiKey = resolveQwenApiKey(process.env);
    } catch (err) {
      throw new LlmError(
        "missing-key",
        err instanceof Error ? err.message : String(err),
      );
    }
    {
      const modelName = resolveQwenModelName(process.env);
      const baseUrl = resolveQwenBaseUrl(process.env);
      console.log(`[scrape] preflight LLM ping model=${modelName}`);
      const ping = await pingLlm({
        apiKey,
        baseUrl,
        model: modelName,
        timeoutMs: 10_000,
      });
      if (!ping.ok) throw pingToError(ping);
      console.log(
        `[scrape] preflight ok latency=${ping.latencyMs}ms status=${ping.status}`,
      );
    }
  }
}
