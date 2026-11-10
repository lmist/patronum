/**
 * Step 6: save the profile.
 *
 * Progress is written after the grid and after every opened post, so a run
 * that stops can pick up where it left off. The final file drops rows that
 * are not real posts and records what was collected.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isHttp, permalinkBelongsTo, unique, usernameFromUrl } from "./links.js";
import { isReelOrVideoPost, type HeaderExtract, type MediaItem } from "./post-shape.js";
import { parseBio } from "./read-header.js";
import { needsDetailEnrichment } from "./resume.js";
import type { CollectRun, PostLists } from "./run.js";
import type { DomHarvest } from "./scroll-grid.js";

/** Save the post list as soon as the grid has been read. */
export function saveGridProgress(run: CollectRun, header: HeaderExtract, posts: MediaItem[], reels: MediaItem[]): void {
  const { outPath, url, handle, prior, notes, session } = run;
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.${process.pid}.grid-tmp`;
    writeFileSync(tmp, JSON.stringify({
      ok: true,
      partial: true,
      scrapedAt: new Date().toISOString(),
      sourceUrl: url,
      username: header.username ?? handle,
      fullName: header.fullName ?? prior?.fullName ?? null,
      profilePicUrl: header.profilePicUrl ?? prior?.profilePicUrl ?? null,
      bioRaw: header.bioRaw ?? prior?.bioRaw ?? null,
      counts: header.counts ?? prior?.counts ?? null,
      posts: [...(prior?.posts ?? []), ...posts],
      reels: run.options.skipReels ? [] : [...(prior?.reels ?? []), ...reels],
      notes: unique(notes).slice(-80),
      session: { authenticated: true, didLogin: session.didLogin },
    }, null, 2));
    renameSync(tmp, outPath);
    console.log(`[scrape] grid checkpoint posts=${posts.length} reels=${reels.length}`);
  } catch (err) {
    console.log(`[scrape] grid checkpoint failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Save after each opened post so a resumed run can skip the finished ones. */
export function saveDetailProgress(run: CollectRun, header: HeaderExtract, posts: MediaItem[], reels: MediaItem[]): void {
  const { outPath, url, handle, prior, notes, session } = run;
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.${process.pid}.detail-tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          ok: true,
          partial: true,
          scrapedAt: new Date().toISOString(),
          sourceUrl: url,
          username: handle,
          fullName: header.fullName ?? prior?.fullName ?? null,
          profilePicUrl: header.profilePicUrl ?? prior?.profilePicUrl ?? null,
          bioRaw: header.bioRaw ?? prior?.bioRaw ?? null,
          counts: header.counts ?? prior?.counts ?? null,
          posts,
          reels,
          notes: unique(notes).slice(-80),
          session: { authenticated: true, didLogin: session.didLogin },
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmp, outPath);
  } catch (err) {
    console.log(
      `[scrape] checkpoint write failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** What a finished run reports on its last line of output. */
export type CollectSummary = {
  ok: true;
  partial: boolean;
  path: string;
  counts: {
    posts: number;
    reels: number;
    mediaUrls: number;
    followers: number | null | undefined;
    following: number | null | undefined;
    profilePosts: number | null | undefined;
    incompleteDetails: number;
    notes: number;
  };
};

/** Write the final profile JSON and return the summary of what it holds. */
export function writeProfile(
  run: CollectRun,
  header: HeaderExtract,
  pageHarvest: DomHarvest | null,
  lists: PostLists,
): CollectSummary {
  const { page, session, prior, notes, url, handle, outPath, scrollRounds } = run;
  const { forceLogin, skipLlmPreflight, fresh, detail, skipReels, max } = run.options;
  let finalPosts = lists.posts;
  let finalReels = lists.reels;

  const username =
    header.username ??
    prior?.username ??
    handle ??
    usernameFromUrl(page.url()) ??
    "unknown";

  const bioRaw = header.bioRaw ?? prior?.bioRaw ?? null;
  const bio = parseBio(bioRaw);
  const location = header.location ?? prior?.location ?? null;

  const profilePicUrl =
    (isHttp(header.profilePicUrl) ? header.profilePicUrl : null) ??
    pageHarvest?.profilePicUrl ??
    (isHttp(prior?.profilePicUrl) ? prior!.profilePicUrl! : null) ??
    null;
  if (!profilePicUrl) notes.push("profilePicUrl not found");

  const counts = {
    posts: header.counts?.posts ?? prior?.counts?.posts ?? null,
    followers: header.counts?.followers ?? prior?.counts?.followers ?? null,
    following: header.counts?.following ?? prior?.counts?.following ?? null,
  };

  // Drop ghost grid/LLM rows with no identity and no media (cannot detail-open)
  const isRealItem = (it: MediaItem) =>
    !!(
      it.shortcode ||
      it.permalink ||
      (it.mediaUrls && it.mediaUrls.length) ||
      it.thumbnailUrl
    );
  const ghostPosts = finalPosts.length;
  const ghostReels = finalReels.length;
  finalPosts = finalPosts.filter(
    (it) => isRealItem(it) && permalinkBelongsTo(it.permalink, handle, it.fromProfileGrid),
  );
  finalReels = finalReels.filter(
    (it) => isRealItem(it) && permalinkBelongsTo(it.permalink, handle, it.fromProfileGrid),
  );
  if (skipReels) {
    const droppedVideo = finalPosts.length;
    finalPosts = finalPosts.filter((it) => !isReelOrVideoPost(it));
    finalReels = [];
    if (droppedVideo - finalPosts.length > 0) {
      notes.push(
        `skip-reels: dropped ${droppedVideo - finalPosts.length} reel/video post(s); image + carousel only`,
      );
    }
  }
  if (ghostPosts - finalPosts.length + ghostReels - finalReels.length > 0) {
    notes.push(
      `dropped ${ghostPosts - finalPosts.length + ghostReels - finalReels.length} ghost item(s) without permalink/media`,
    );
  }

  const missingMedia =
    finalPosts.filter((p) => !(p.mediaUrls?.length || p.thumbnailUrl)).length +
    finalReels.filter((p) => !(p.mediaUrls?.length || p.thumbnailUrl)).length;
  if (missingMedia > 0) {
    notes.push(
      `${missingMedia} item(s) lack mediaUrls and thumbnailUrl after deep scroll`,
    );
  }

  const mediaUrlSet = new Set<string>();
  if (profilePicUrl) mediaUrlSet.add(profilePicUrl);
  for (const p of [...finalPosts, ...finalReels]) {
    for (const u of p.mediaUrls ?? []) mediaUrlSet.add(u);
    if (p.thumbnailUrl) mediaUrlSet.add(p.thumbnailUrl);
    for (const c of p.carouselMedia ?? []) {
      if (c.mediaUrl) mediaUrlSet.add(c.mediaUrl);
      if (c.thumbnailUrl) mediaUrlSet.add(c.thumbnailUrl);
    }
  }

  const incompleteDetails = detail
    ? [...finalPosts, ...finalReels].filter(needsDetailEnrichment).length
    : 0;
  if (incompleteDetails) notes.push(`${incompleteDetails} detail item(s) remain incomplete; retry from saved checkpoint`);

  const payload = {
    ok: true,
    partial: incompleteDetails > 0,
    scrapedAt: new Date().toISOString(),
    sourceUrl: url,
    pageUrl: page.url(),
    mode: {
      forceLogin,
      skipLlmPreflight,
      fresh,
      resume: !!prior,
      detail,
      skipReels,
      max,
      scrollRounds,
    },
    username,
    fullName: header.fullName ?? prior?.fullName ?? null,
    profilePicUrl,
    bioRaw,
    bio,
    location,
    counts,
    posts: finalPosts,
    reels: finalReels,
    notes: unique(notes),
    session: {
      sessionId: session.sessionId,
      liveUrl: session.liveUrl,
      authenticated: true,
      didLogin: session.didLogin,
      account: session.account.user,
    },
    domHarvest: pageHarvest
      ? {
          gridItemCount: pageHarvest.gridItems.length,
          imgCount: pageHarvest.allImgSrcs.length,
          videoCount: pageHarvest.allVideoSrcs.length,
          hrefCount: pageHarvest.allPostHrefs.length,
        }
      : null,
    stats: {
      postCount: finalPosts.length,
      reelCount: finalReels.length,
      mediaUrlCount: mediaUrlSet.size,
      priorPostCount: prior?.posts?.length ?? 0,
      priorReelCount: prior?.reels?.length ?? 0,
      incompleteDetailCount: incompleteDetails,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[scrape] wrote ${outPath}`);

  return {
    ok: true,
    partial: payload.partial,
    path: outPath,
    counts: {
      posts: finalPosts.length,
      reels: finalReels.length,
      mediaUrls: mediaUrlSet.size,
      followers: counts.followers,
      following: counts.following,
      profilePosts: counts.posts,
      incompleteDetails,
      notes: payload.notes.length,
    },
  };
}
