/**
 * Step 5c: read one post.
 *
 * Take the caption, date and every image or video from an open post, walking
 * through carousel slides, and return the completed record.
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { collectPostMedia } from "./post-media.js";
import { collectEmbeddedPostMedia, type EmbeddedPostMedia } from "./embedded-post.js";
import { isTabLostError } from "./cdp-detail.js";
import type { MediaItem } from "./post-shape.js";
import {
  unique,
  normalizePermalink,
  canonicalDetailUrl,
  shortcodeFromPermalink,
  isHttp,
  videoFirstUrls,
} from "./links.js";
import { sleep } from "./pacing.js";
import type { DetailPage } from "./browser-page.js";
import { stagehandAuthProbe, assertDetailAuthenticated } from "./open-profile.js";
import { normalizeMediaItem, postMetrics } from "./merge-posts.js";
import { DetailNavigationTimeout, InstagramHttpRejectionError } from "./rejections.js";
import { navigateDetailPage } from "./open-post.js";

export type DetailHarvest = {
  mediaUrls: string[];
  videoUrls: string[];
  imgUrls: string[];
  isVideo: boolean;
  caption: string | null;
  timestamp: string | null;
  hasCarouselNext: boolean;
  domBacked: boolean;
  captionFromDom: boolean;
};

/** Full detail DOM snapshot: media srcs + caption/time + carousel next flag.
 *  Video-first: prefers real mp4/CDN video over poster stills (required for M3 video_url).
 */
export async function harvestDetailMedia(page: {
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
}, input?: { shortcode: string; cover?: string | null }): Promise<DetailHarvest | null> {
  if (!page.evaluate) return null;
  const args = input ? JSON.stringify(input) : '{shortcode: location.pathname.match(/\\/(?:p|reels?|tv)\\/([\\w-]+)/)?.[1] || ""}';
  return await page.evaluate(`(${collectPostMedia.toString()})(${args})`) as DetailHarvest | null;
}

/** Exact-shortcode post objects in Instagram's JSON scripts can supply the
 * complete owned media set before the interactive carousel is hydrated. */
export async function harvestEmbeddedPostMedia(
  page: { evaluate?: <R = unknown>(expression: string) => Promise<R> },
  shortcode: string,
  polls = 6,
): Promise<EmbeddedPostMedia | null> {
  if (!page.evaluate) return null;
  const expression = `(${collectEmbeddedPostMedia.toString()})(${JSON.stringify({ shortcode })})`;
  for (let i = 0; i < polls; i++) {
    try {
      const post = await page.evaluate<EmbeddedPostMedia | null>(expression);
      if (post) return post;
    } catch {
      // Script may still be mounting; the DOM path remains the fallback.
    }
    if (i < polls - 1) await sleep(500);
  }
  return null;
}

/** OG media can arrive long before Instagram mounts the interactive post.
 * Wait for visible post-owned DOM before attempting the carousel walk. */
export async function waitForPostHydration(
  page: DetailPage,
  input: { shortcode: string; cover?: string | null },
  expectCarousel: boolean,
  timeoutMs = 25_000,
): Promise<DetailHarvest | null> {
  const deadline = Date.now() + timeoutMs;
  let firstDomAt = 0;
  let latest: DetailHarvest | null = null;
  do {
    latest = await harvestDetailMedia(page, input);
    if (latest?.domBacked) {
      if (!firstDomAt) firstDomAt = Date.now();
      const settled = Date.now() - firstDomAt >= (expectCarousel ? 4_000 : 2_000);
      if ((latest.captionFromDom && (!expectCarousel || latest.hasCarouselNext)) || settled) return latest;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  console.log(`[scrape] detail ${input.shortcode}: post DOM not fully hydrated after ${timeoutMs}ms`);
  return latest;
}

/** Click carousel Next via DOM only (no LLM). Returns true if clicked. */
export async function clickCarouselNextDom(page: {
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
}): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    return (await page.evaluate(`(() => {
      const sc = location.pathname.match(/\\/(?:p|reels?|tv)\\/([\\w-]+)/)?.[1];
      const root = document.querySelector('[data-patronum-post="' + sc + '"]');
      const candidates = root ? [...root.querySelectorAll('button, [role="button"]')].filter((el) => {
        const labels = [el, ...el.querySelectorAll('[aria-label]')]
          .map((node) => node.getAttribute('aria-label') || '')
          .join(' ');
        return /\\bnext\\b/i.test(labels);
      }) : [];
      for (const btn of candidates) {
        const r = btn.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        btn.click();
        return true;
      }
      return false;
    })()`)) as boolean;
  } catch {
    return false;
  }
}

/**
 * Walk carousel slides with DOM clicks; collect media srcs from each slide.
 * Advance only the identified post's own carousel control.
 */
export async function harvestCarouselAllSlides(
  page: DetailPage,
  input: { shortcode: string; cover?: string | null },
  maxSlides = 15,
  initial?: DetailHarvest | null,
  transitionTimeoutMs = 10_000,
): Promise<{
  mediaUrls: string[];
  carouselMedia: NonNullable<MediaItem["carouselMedia"]>;
  traversalComplete: boolean;
  caption: string | null;
  timestamp: string | null;
  isVideo: boolean;
}> {
  const mediaUrls: string[] = [];
  const carouselMedia: NonNullable<MediaItem["carouselMedia"]> = [];
  const seen = new Set<string>();
  let caption: string | null = null;
  let timestamp: string | null = null;
  let isVideo = false;
  let traversalComplete = false;
  let pending: DetailHarvest | null = initial ?? null;

  let empty = 0;
  for (let i = 0; i < maxSlides; i++) {
    const h = pending ?? await harvestDetailMedia(page, input);
    pending = null;
    if (!h) {
      if (i === 0 && empty < 4) {
        empty++;
        i--;
        await sleep(700);
        continue;
      }
      break;
    }
    // OG metadata is not an interactive slide and cannot prove exhaustion.
    if (!h.domBacked) break;
    if (!caption && h.caption) caption = h.caption;
    if (!timestamp && h.timestamp) timestamp = h.timestamp;
    if (h.isVideo) isVideo = true;
    for (const u of h.videoUrls.length ? h.videoUrls : h.imgUrls) {
      const key = new URL(u).pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      mediaUrls.push(u);
      carouselMedia.push({
        mediaUrl: u,
        thumbnailUrl: h.videoUrls.includes(u) ? h.imgUrls[0] ?? null : u,
        isVideo: h.videoUrls.includes(u),
      });
    }
    if (!h.hasCarouselNext) {
      // A replacement Next can mount after the new image. Require a stable
      // no-Next window before certifying that this is the final slide.
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(250);
        const candidate = await harvestDetailMedia(page, input);
        if (!candidate?.domBacked) continue;
        const urls = candidate.videoUrls.length ? candidate.videoUrls : candidate.imgUrls;
        const newSlide = urls.some((url) => {
          try { return !seen.has(new URL(url).pathname); } catch { return false; }
        });
        if (candidate.hasCarouselNext || newSlide) {
          pending = candidate;
          break;
        }
      }
      if (pending) {
        i--;
        continue;
      }
      traversalComplete = true;
      break;
    }
    if (i === maxSlides - 1) break;
    if (!await clickCarouselNextDom(page)) break;

    // React can remove Next during the slide animation while the prior image
    // remains visible. Wait for a newly owned media path before deciding the
    // carousel ended, otherwise that transient state truncates the walk.
    for (let attempt = 0; attempt < Math.max(1, Math.ceil(transitionTimeoutMs / 250)); attempt++) {
      await sleep(250);
      const candidate = await harvestDetailMedia(page, input);
      if (!candidate) continue;
      const urls = candidate.videoUrls.length
        ? candidate.videoUrls
        : candidate.imgUrls;
      const advanced = urls.some((url) => {
        try {
          return !seen.has(new URL(url).pathname);
        } catch {
          return false;
        }
      });
      if (advanced) {
        pending = candidate;
        break;
      }
    }
    if (!pending) break;
  }

  return {
    mediaUrls: unique(mediaUrls),
    carouselMedia,
    traversalComplete,
    caption,
    timestamp,
    isVideo,
  };
}

export async function enrichOneItem(
  stagehand: Stagehand,
  page: DetailPage,
  item: MediaItem,
  i: number,
  total: number,
  notes: string[],
): Promise<{ item: MediaItem; opened: boolean }> {
  const sc =
    item.shortcode ?? shortcodeFromPermalink(item.permalink) ?? `idx${i}`;
  const permalink =
    normalizePermalink(item.permalink) ??
    (sc && !sc.startsWith("idx")
      ? item.type === "reel" || (item.permalink ?? "").includes("/reel/")
        ? `https://www.instagram.com/reel/${sc}/`
        : `https://www.instagram.com/p/${sc}/`
      : null);

  if (!permalink) {
    notes.push(`detail skip ${sc}: no permalink`);
    return { item, opened: false };
  }

  const detailUrl = canonicalDetailUrl(permalink);
  console.log(`[scrape] detail ${i + 1}/${total} open ${detailUrl}`);
  try {
    await navigateDetailPage(page, detailUrl);
  } catch (err) {
    if (err instanceof DetailNavigationTimeout || err instanceof InstagramHttpRejectionError) throw err;
    // A lost tab is a worker problem, not a post problem: let the pool replace it.
    if (isTabLostError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`detail nav ${sc}: ${msg}`);
    console.log(`[scrape] detail nav fail ${sc}: ${msg}`);
    return { item, opened: false };
  }
  await sleep(1800);

  // Fail-closed auth check #3: wait for an initially blank post body, but
  // never wait through an explicit login or checkpoint page.
  await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page));

  const embedded = await harvestEmbeddedPostMedia(page, sc);
  if (embedded) {
    const complete: MediaItem = {
      ...item,
      mediaOwnershipVersion: 1,
      metricsVersion: 1,
      detailSource: "embedded-json",
      carouselComplete: embedded.type === "carousel" ? true : undefined,
      captionComplete: true,
      detailStatus: "complete",
      detailError: null,
      shortcode: sc,
      id: item.id ?? sc,
      // A reel decodes as media_type 2 ("video"); keep the reel classification.
      type: item.type === "reel" && embedded.type === "video" ? "reel" : embedded.type,
      caption: embedded.caption,
      timestamp: embedded.timestamp,
      permalink,
      mediaUrls: embedded.mediaUrls,
      thumbnailUrl: embedded.thumbnailUrl,
      isVideo: embedded.isVideo,
      carouselMedia: embedded.carouselMedia,
      ...postMetrics(embedded),
    };
    const stated = postMetrics(embedded);
    console.log(`[scrape] detail ${i + 1}/${total} @${sc} embedded post media=${embedded.mediaUrls.length} type=${embedded.type}${Object.keys(stated).length ? ` metrics=${Object.keys(stated).join(",")}` : ""}`);
    return { item: normalizeMediaItem(complete, notes), opened: true };
  }

  // Light overlay dismiss via DOM only (no LLM act fallback on every post)
  try {
    await page.evaluate?.(`(() => {
        const btns = [...document.querySelectorAll('button, [role="button"]')];
        for (const b of btns) {
          const t = (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
          if (t === 'allow all cookies' || t === 'accept' || t === 'accept all' || t === 'not now') {
            b.click();
            return;
          }
        }
      })()`);
  } catch {
    // ignore
  }

  await sleep(1500);

  const ownership = { shortcode: sc, cover: item.thumbnailUrl };
  const cachedCarousel = item.type === "carousel" && item.mediaOwnershipVersion === 1 &&
    item.carouselComplete === true && (item.carouselMedia?.length ?? 0) > 1 && item.captionComplete !== true;
  const hydrated = await waitForPostHydration(page, ownership, item.type === "carousel");
  const car = cachedCarousel ? {
    mediaUrls: videoFirstUrls((item.carouselMedia ?? []).map((slide) => slide.mediaUrl).filter(isHttp)),
    carouselMedia: item.carouselMedia!,
    traversalComplete: true,
    caption: hydrated?.caption ?? null,
    timestamp: hydrated?.timestamp ?? null,
    isVideo: item.isVideo === true,
  } : await harvestCarouselAllSlides(page, ownership, 30, hydrated);
  if (cachedCarousel) console.log(`[scrape] detail ${sc}: reuse ${car.carouselMedia.length} verified slides; caption-only refresh`);
  let detailHarvest = await harvestDetailMedia(page, ownership);
  await sleep(1200);
  const detailHarvest2 = await harvestDetailMedia(page, ownership);
  if (detailHarvest2) {
    detailHarvest = {
      mediaUrls: videoFirstUrls([
        ...(detailHarvest2.mediaUrls || []),
        ...(detailHarvest?.mediaUrls || []),
      ]),
      videoUrls: unique([
        ...(detailHarvest2.videoUrls || []),
        ...(detailHarvest?.videoUrls || []),
      ]),
      imgUrls: unique([
        ...(detailHarvest2.imgUrls || []),
        ...(detailHarvest?.imgUrls || []),
      ]),
      isVideo: !!(detailHarvest2.isVideo || detailHarvest?.isVideo),
      caption: detailHarvest2.caption || detailHarvest?.caption || null,
      timestamp: detailHarvest2.timestamp || detailHarvest?.timestamp || null,
      hasCarouselNext: !!(
        detailHarvest2.hasCarouselNext || detailHarvest?.hasCarouselNext
      ),
      domBacked: !!(detailHarvest2.domBacked || detailHarvest?.domBacked),
      captionFromDom: !!(detailHarvest2.captionFromDom || detailHarvest?.captionFromDom),
    };
  }
  if (detailHarvest?.videoUrls?.length) {
    console.log(
      `[scrape] detail ${sc}: ${detailHarvest.videoUrls.length} real video URL(s) → M3 video_url`,
    );
  } else if (
    item.type === "reel" ||
    item.isVideo ||
    permalink.includes("/reel/")
  ) {
    notes.push(
      `detail ${sc}: reel page but no downloadable video URL (poster stills only)`,
    );
    console.log(
      `[scrape] detail ${sc}: WARNING no video file URL — would send stills to M3`,
    );
  }

  const fullDomCaption =
    (detailHarvest2?.captionFromDom ? detailHarvest2.caption : null) ||
    (detailHarvest?.captionFromDom ? detailHarvest.caption : null) ||
    (hydrated?.captionFromDom ? hydrated.caption : null);

  const mediaAfterDom = videoFirstUrls([
    ...car.mediaUrls,
    ...(detailHarvest?.mediaUrls ?? []),
  ]).filter(isHttp);
  const captionAfterDom = fullDomCaption || (item.captionComplete ? item.caption : null);
  const currentDomBacked = !!(hydrated?.domBacked || detailHarvest?.domBacked);

  if (mediaAfterDom.length > 0 && !captionAfterDom && currentDomBacked) {
    notes.push(`detail ${sc}: caption not in DOM; LLM caption extract unavailable on CDP detail tab`);
  } else if (mediaAfterDom.length === 0) {
    console.log(
      `[scrape] detail ${i + 1}/${total} @${sc} skip LLM extract (media=0)`,
    );
  }

  const harvestedUrls = videoFirstUrls([
    ...(detailHarvest?.videoUrls ?? []),
    ...car.mediaUrls,
    ...(detailHarvest?.mediaUrls ?? []),
  ]).filter(isHttp);
  const gridUrls = (item.mediaUrls ?? []).filter(isHttp);
  const mediaUrls = harvestedUrls.length ? harvestedUrls : gridUrls;
  // OG metadata is only a preview. A carousel must reach a DOM-backed final
  // slide with no Next; two discovered slides alone do not prove completion.
  const carouselExpected = item.type === "carousel" || car.carouselMedia.length > 1;
  const domBacked = cachedCarousel || currentDomBacked;
  const carouselComplete = cachedCarousel || (car.traversalComplete && car.carouselMedia.length > 1);
  const expectedVideo = item.type === "reel" || item.type === "video" || item.isVideo === true;
  const hasHttpVideo = !!detailHarvest?.videoUrls.some(isHttp) ||
    car.carouselMedia.some((slide) => slide.isVideo === true && isHttp(slide.mediaUrl));
  const owned = harvestedUrls.length > 0 && domBacked &&
    (!carouselExpected || carouselComplete) && (!expectedVideo || hasHttpVideo);

  const carouselMedia = car.carouselMedia.length > 1 ? car.carouselMedia : null;
  if (!owned) {
    notes.push(
      carouselExpected && !carouselComplete
        ? `detail ${sc}: carousel not hydrated/traversed; keeping cover unverified`
        : harvestedUrls.length === 0 && gridUrls.length
        ? `detail ${sc}: owned harvest empty; keeping ${gridUrls.length} grid URL(s) unverified`
        : `detail ${sc}: no post-owned media found`,
    );
  }

  const type =
    item.type ??
    (permalink.includes("/reel/")
      ? "reel"
      : carouselMedia && carouselMedia.length > 1
        ? "carousel"
        : detailHarvest?.isVideo || car.isVideo
          ? "video"
          : "image");

  const merged: MediaItem = {
    mediaOwnershipVersion: owned ? 1 : undefined,
    carouselComplete: carouselExpected ? carouselComplete : undefined,
    captionComplete: !!fullDomCaption,
    fromProfileGrid: item.fromProfileGrid,
    shortcode: item.shortcode ?? sc,
    id: item.id ?? sc,
    type,
    caption:
      fullDomCaption ||
      car.caption ||
      detailHarvest?.caption ||
      item.caption ||
      null,
    timestamp:
      car.timestamp ||
      detailHarvest?.timestamp ||
      item.timestamp ||
      null,
    permalink,
    mediaUrls,
    thumbnailUrl:
      car.carouselMedia[0]?.thumbnailUrl ??
      detailHarvest?.imgUrls[0] ??
      mediaUrls[0] ??
      item.thumbnailUrl ??
      null,
    isVideo:
      detailHarvest?.isVideo ??
      car.isVideo ??
      item.isVideo ??
      (type === "reel" || type === "video"),
    carouselMedia,
  };

  if (!merged.mediaUrls?.length && !merged.thumbnailUrl) {
    notes.push(`detail ${sc}: still no media after open`);
    console.log(`[scrape] detail ${i + 1}/${total} @${sc} NO MEDIA`);
    return { item: normalizeMediaItem(merged, notes), opened: false };
  }
  console.log(
    `[scrape] detail ${i + 1}/${total} @${sc} ${owned ? "ok" : "KEEP GRID"} media=${merged.mediaUrls?.length ?? 0} caption=${merged.caption ? "yes" : "no"}`,
  );
  return { item: normalizeMediaItem(merged, notes), opened: true };
}
