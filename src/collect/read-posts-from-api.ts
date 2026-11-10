/**
 * Step 5a: take full post records from Instagram's own responses.
 *
 * Before opening posts one by one, reuse the profile request the page
 * already made (GraphQL) and the media-info responses seen when a reel is
 * opened from the grid. Every post completed here is one fewer tab to open.
 */
import { assertAuthenticated, isAuthError } from "../sign-in/auth-check.js";
import type { ObservedProfileRequest } from "../api-map/traffic-recorder.js";
import { clickProfileTab, type MappedPage } from "../api-map/ui-map.js";
import { collectEmbeddedPostMedia, type EmbeddedPostMedia } from "./embedded-post.js";
import { fetchProfileGraphqlPage, GraphqlProfileError, GraphqlProfileHttpError } from "./graphql-profile.js";
import { assertDetailAuthenticated, stagehandAuthProbe } from "./open-profile.js";
import { sleep } from "./pacing.js";
import { isReelOrVideoPost, type MediaItem } from "./post-shape.js";
import { InstagramHttpRejectionError } from "./rejections.js";
import { needsDetailEnrichment } from "./resume.js";
import type { CollectRun, PostLists } from "./run.js";

/** The ways a rebuilt request can come back malformed. Instagram's own error codes may follow in brackets. */
const MALFORMED_ANSWERS = [
  "Profile GraphQL response is not valid JSON",
  "Profile GraphQL timeline connection is missing or invalid",
  "Profile GraphQL pagination is invalid",
  "Profile GraphQL timeline contains an invalid post",
];

/** A cached profile request that returns a malformed answer is thrown away and observed afresh. */
export function shouldRediscoverCachedProfileRequest(error: unknown, provenance: ObservedProfileRequest["provenance"]): boolean {
  return provenance === "cache-rebound" && error instanceof GraphqlProfileError &&
    !(error instanceof GraphqlProfileHttpError) && !isAuthError(error) &&
    MALFORMED_ANSWERS.some((answer) => error.message === answer || error.message.startsWith(`${answer} (`));
}

/** Page through the profile's GraphQL timeline and complete every post it fully describes. */
export async function readPostsFromProfileApi(
  run: CollectRun,
  lists: PostLists,
  save: (posts: MediaItem[], reels: MediaItem[]) => void,
): Promise<void> {
  const { stagehand, page, session, handle, traffic } = run;
  const { max, skipReels } = run.options;
  const initialGraphqlTemplate = traffic.profileRequest(page, handle, "initial");
  let graphqlTemplate = traffic.profileRequest(page, handle);
  for (let attempt = 0; !graphqlTemplate && lists.posts.some(needsDetailEnrichment) && attempt < 2; attempt++) {
    await page.evaluate(() => window.scrollBy(0, Math.max(1200, window.innerHeight * 2)));
    await sleep(2_000);
    graphqlTemplate = traffic.profileRequest(page, handle);
  }
  if (graphqlTemplate && lists.posts.some(needsDetailEnrichment)) {
    console.log(`[scrape] GraphQL profile route=${graphqlTemplate.provenance} operation=${graphqlTemplate.operation}`);
    let cursor: string | null = null;
    const cursors = new Set<string>();
    const captured = new Set<string>();
    for (let batch = 1; batch <= 1_000; batch++) {
      let result: Awaited<ReturnType<typeof fetchProfileGraphqlPage>> | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const source: ObservedProfileRequest = batch === 1 && initialGraphqlTemplate ? initialGraphqlTemplate : graphqlTemplate;
        try {
          result = await fetchProfileGraphqlPage(page, source, handle,
            source === initialGraphqlTemplate ? undefined : cursor);
          break;
        } catch (error) {
          if (error instanceof GraphqlProfileHttpError) throw new InstagramHttpRejectionError(source.url, `HTTP ${error.status}`, error.status, error.retryAfter ?? null);
          if (attempt === 0 && shouldRediscoverCachedProfileRequest(error, source.provenance) &&
            traffic.invalidateProfileRequest(page, handle, source.docId)) {
            await assertAuthenticated(stagehandAuthProbe(stagehand, page), { expectedUser: session.account.user });
            await page.evaluate(() => window.scrollBy(0, Math.max(1200, window.innerHeight * 2)));
            await sleep(2_000);
            const observed = traffic.profileRequest(page, handle);
            if (observed?.provenance === "observed") {
              graphqlTemplate = observed;
              console.log("[scrape] Cached GraphQL route invalidated; observed a fresh profile connection");
              continue;
            }
            console.log("[scrape] Cached GraphQL route invalidated; using observed post detail navigation");
            break;
          }
          throw new Error(`GraphQL record validation failed: ${error instanceof Error ? error.message : "unknown error"}; saved captures retained`);
        }
      }
      if (!result) break;
      for (const item of result.items) {
        if (!item.complete || !item.media) continue;
        const reelIndex = lists.reels.findIndex(post => post.shortcode === item.shortcode);
        const postIndex = lists.posts.findIndex(post => post.shortcode === item.shortcode);
        const previous = reelIndex >= 0 ? lists.reels[reelIndex] : postIndex >= 0 ? lists.posts[postIndex] : undefined;
        const complete: MediaItem = {
          ...previous, ...item.media, shortcode: item.shortcode,
          id: typeof item.node.pk === "string" ? item.node.pk : previous?.id ?? item.shortcode,
          type: reelIndex >= 0 ? "reel" : item.media.type,
          permalink: previous?.permalink ?? `https://www.instagram.com/p/${item.shortcode}/`,
          fromProfileGrid: true, mediaOwnershipVersion: 1, metricsVersion: 1, detailSource: "graphql",
          captionComplete: true, carouselComplete: item.media.type === "carousel" ? true : undefined,
          detailStatus: "complete", detailError: null,
        };
        if (skipReels && isReelOrVideoPost(complete)) continue;
        if (reelIndex >= 0) lists.reels[reelIndex] = complete;
        else if (postIndex >= 0) lists.posts[postIndex] = complete;
        else if (lists.posts.length < max) lists.posts.push(complete);
        else continue;
        captured.add(item.shortcode);
        lists.complete.add(item.shortcode);
      }
      save(lists.posts, lists.reels);
      console.log(`[scrape] GraphQL page=${batch} records=${result.items.length} complete=${result.items.filter(item => item.complete).length} captured=${captured.size} more=${result.hasNextPage}`);
      if (!result.hasNextPage || captured.size >= max) break;
      if (!result.cursor || cursors.has(result.cursor)) throw new Error("Profile GraphQL pagination repeated a cursor");
      cursors.add(result.cursor);
      cursor = result.cursor;
      await sleep(750);
    }
  } else if (lists.posts.some(needsDetailEnrichment)) {
    console.log("[scrape] Profile GraphQL route cache miss; using observed post detail navigation");
  }
}

/** Open unfinished reels from the Reels tab and complete them from the media-info response the page fetches. */
export async function readReelsFromGridClicks(
  run: CollectRun,
  lists: PostLists,
  save: (posts: MediaItem[], reels: MediaItem[]) => void,
): Promise<void> {
  const { stagehand, page, handle, uiMap, traffic } = run;
  if (!(lists.reels.some(needsDetailEnrichment) && await clickProfileTab(page as MappedPage, uiMap, "reels", handle))) return;
  await sleep(2_000);
  // The opened reel stays in a modal over the grid. Close it after each
  // read; stop this shortcut after two misses — detail tabs cover the rest.
  let observedMisses = 0;
  for (let index = 0; index < lists.reels.length && observedMisses < 2; index++) {
    const reel = lists.reels[index]!;
    if (!needsDetailEnrichment(reel) || !reel.shortcode) continue;
    const sc = reel.shortcode;
    const href = await page.evaluate((shortcode: string) => Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map(anchor => anchor.getAttribute("href") ?? "")
      .find(value => /^\/(?:[A-Za-z0-9._]+\/)?reel\/[A-Za-z0-9_-]+\/$/.test(value) && value.split("/").includes(shortcode)) ?? null, sc);
    if (!href) continue;
    console.log(`[scrape] reel @${sc} opening observed profile link`);
    await page.locator(`a[href=${JSON.stringify(href)}]`).first().click();
    let media: EmbeddedPostMedia | null = null;
    for (let poll = 0; poll < 30 && !media; poll++) {
      const record = traffic.postRecord(page, sc);
      if (record) media = collectEmbeddedPostMedia({ shortcode: sc, records: [record] });
      if (!media) await sleep(300);
    }
    if (media) {
      await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));
      lists.reels[index] = { ...reel, ...media, type: "reel", mediaOwnershipVersion: 1, metricsVersion: 1,
        detailSource: "api-info", captionComplete: true, detailStatus: "complete", detailError: null };
      lists.complete.add(sc);
      save(lists.posts, lists.reels);
      console.log(`[scrape] reel @${sc} complete from observed media-info response`);
      observedMisses = 0;
    } else if (++observedMisses >= 2) {
      console.log("[scrape] observed media-info shortcut stopped after 2 misses; using detail tabs");
    }
    try { await page.keyPress("Escape"); await sleep(400); } catch { /* modal may be gone */ }
  }
}
