/**
 * Step 2: read the profile header.
 *
 * Name, picture, bio and the posts / followers / following counts, taken from
 * the page itself. Also splits a raw bio into links, hashtags and mentions.
 * Hands the next step the profile's identity.
 */
import { type HeaderExtract, BioOnlySchema, HeaderSchema } from "./post-shape.js";
import { unique } from "./links.js";
import { clickOptionalProfileControl, type MappedPage } from "../api-map/ui-map.js";
import { ACT_EXPAND_BIO, OBSERVE_BIO_EXPAND, extractBioOnlyInstruction, extractHeaderInstruction } from "./prompts.js";
import { inspectOptionalControls, observeActFirst } from "./open-profile.js";
import { noteLlmError, optionalModel, sleep, timedPhase } from "./pacing.js";
import type { CollectRun } from "./run.js";

export type ParsedBio = {
  lines: string[];
  hashtags: string[];
  mentions: string[];
  emails: string[];
  phones: string[];
  links: string[];
  keywords: string[];
};

export function parseBio(raw: string | null | undefined): ParsedBio {
  const text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  const lines = text ? text.split("\n").map((l) => l.trimEnd()) : [];

  const hashtags = unique(
    [...text.matchAll(/#([\w\u00C0-\u024F]+)/gu)].map((m) => m[1]!),
  );
  const mentions = unique(
    [...text.matchAll(/@([\w.]+)/g)].map((m) => m[1]!),
  );
  const emails = unique(
    [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)].map(
      (m) => m[0]!,
    ),
  );
  const phones = unique(
    [
      ...text.matchAll(
        /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/g,
      ),
    ]
      .map((m) => m[0]!.trim())
      .filter((p) => p.replace(/\D/g, "").length >= 7),
  );
  const links = unique(
    [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi)].map(
      (m) => m[0]!,
    ),
  );

  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "you", "your",
    "are", "our", "was", "were", "have", "has", "not", "but", "all", "any",
    "can", "out", "bio",
  ]);
  const keywords = unique(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[#@]/g, " ")
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3 && !stop.has(w) && !/^\d+$/.test(w)),
  ).slice(0, 40);

  return { lines, hashtags, mentions, emails, phones, links, keywords };
}

export async function harvestHeaderDom(page: {
  evaluate?: <R = unknown>(fn: string | (() => R)) => Promise<R>;
}): Promise<HeaderExtract | null> {
  if (!page.evaluate) return null;
  try {
    return (await page.evaluate(`(() => {
      const isHttp = (s) => typeof s === "string" && /^https?:\\/\\//i.test(s);
      const parseCount = (raw) => {
        if (raw == null) return null;
        const t = String(raw).replace(/,/g, "").trim();
        const m = t.match(/([0-9]*\\.?[0-9]+)\\s*([kmb])?/i);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (!Number.isFinite(n)) return null;
        const suf = (m[2] || "").toLowerCase();
        if (suf === "k") n *= 1e3;
        if (suf === "m") n *= 1e6;
        if (suf === "b") n *= 1e9;
        return Math.round(n);
      };

      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute("content") || "";
      const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;
      const canon = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || location.href;

      let username = null;
      try {
        const parts = new URL(canon).pathname.split("/").filter(Boolean);
        const skip = new Set(["p","reel","reels","tv","stories","explore","accounts","direct"]);
        if (parts[0] && !skip.has(parts[0].toLowerCase())) username = parts[0];
      } catch (_) {}
      const at = ogTitle.match(/@([A-Za-z0-9._]+)/);
      if (at) username = username || at[1];
      const nameM = ogTitle.match(/^(.+?)\\s*\\(/);
      let fullName = nameM ? nameM[1].replace(/\\s+on Instagram$/i, "").trim() : null;
      const hName = document.querySelector("header h1, header h2, header span")?.textContent?.trim();
      if (!fullName && hName && hName !== username) fullName = hName;

      let posts = null, followers = null, following = null;
      const descFollow = ogDesc.match(/([0-9][0-9.,]*\\s*[kmb]?)\\s*Followers/i);
      const descFollowing = ogDesc.match(/([0-9][0-9.,]*\\s*[kmb]?)\\s*Following/i);
      const descPosts = ogDesc.match(/([0-9][0-9.,]*\\s*[kmb]?)\\s*Posts/i);
      if (descFollow) followers = parseCount(descFollow[1]);
      if (descFollowing) following = parseCount(descFollowing[1]);
      if (descPosts) posts = parseCount(descPosts[1]);

      document.querySelectorAll("header li, header a, ul li").forEach((el) => {
        const t = (el.textContent || "").toLowerCase();
        const numEl = el.querySelector("span, em") || el;
        const num = parseCount(numEl.textContent || el.textContent);
        if (num == null) return;
        if (t.includes("follower") && followers == null) followers = num;
        else if (t.includes("following") && following == null) following = num;
        else if (t.includes("post") && posts == null) posts = num;
      });

      let bioRaw = null;
      const header = document.querySelector("header");
      if (header) {
        const chunks = [...header.querySelectorAll("span, h1, h2, div")]
          .map((el) => (el.textContent || "").trim())
          .filter((t) => t.length >= 12 && t.length < 600 && !/followers|following|posts/i.test(t));
        if (chunks.length) {
          bioRaw = chunks.sort((a, b) => b.length - a.length)[0];
        }
      }
      if (!bioRaw && ogDesc) {
        const cut = ogDesc.replace(/^[^-]*-\\s*/, "").trim();
        if (cut && cut.length > 8 && !/^see instagram/i.test(cut)) bioRaw = cut;
      }

      let profilePicUrl = isHttp(ogImg) ? ogImg : null;
      if (!profilePicUrl) {
        const img = document.querySelector('header img, img[alt*="profile picture" i]');
        const src = img && (img.currentSrc || img.src);
        if (isHttp(src)) profilePicUrl = src;
      }

      return {
        username,
        fullName,
        profilePicUrl,
        bioRaw,
        location: null,
        counts: { posts, followers, following },
        notes: ["header harvested from DOM/meta"],
      };
    })()`)) as HeaderExtract;
  } catch (err) {
    console.log(
      `[scrape] header DOM harvest failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/** Read the header from the page; ask the model only for what the page did not give. */
export async function readHeader(run: CollectRun): Promise<HeaderExtract> {
  const { stagehand, page, handle, uiMap, notes } = run;
  // Expand only an actual visible truncated bio, via a validated Stagehand locator.
  if ((await inspectOptionalControls(page)).bioMore) {
    const clicked = await clickOptionalProfileControl(page as MappedPage, uiMap, "bio-more", handle);
    if (!clicked) await observeActFirst(stagehand, OBSERVE_BIO_EXPAND, ACT_EXPAND_BIO, undefined, { map: uiMap, action: "bio-more", handle });
    await sleep(800);
  }

  // DOM/meta already carries the ordinary profile header; model extraction is
  // reserved for missing identity or counts, not used as a discovery probe.
  let header: HeaderExtract = (await timedPhase("header:dom", () => harvestHeaderDom(page))) ?? {};
  if (!header.username || (header.counts?.posts == null && header.counts?.followers == null)) {
    try {
      const modelHeader = await optionalModel("extract:header", () => stagehand.extract(
        extractHeaderInstruction(handle), HeaderSchema,
      ));
      header = {
        ...modelHeader,
        username: header.username ?? modelHeader.username,
        fullName: header.fullName ?? modelHeader.fullName,
        profilePicUrl: header.profilePicUrl ?? modelHeader.profilePicUrl,
        bioRaw: header.bioRaw ?? modelHeader.bioRaw,
        counts: {
          posts: header.counts?.posts ?? modelHeader.counts?.posts ?? null,
          followers: header.counts?.followers ?? modelHeader.counts?.followers ?? null,
          following: header.counts?.following ?? modelHeader.counts?.following ?? null,
        },
      };
      if (modelHeader.notes) notes.push(...modelHeader.notes);
    } catch (err) {
      const msg = noteLlmError(err);
      notes.push(`header extract failed: ${msg}`);
      console.log(`[scrape] header extract failed: ${msg}`);
    }
  } else {
    console.log(`[scrape] header DOM ready user=${header.username} posts=${header.counts?.posts ?? "?"}; skip model`);
  }

  if (!header.bioRaw && !header.username) {
    try {
      const bioOnly = await optionalModel("extract:bio", () => stagehand.extract(extractBioOnlyInstruction(), BioOnlySchema));
      if (bioOnly.bioRaw) header.bioRaw = bioOnly.bioRaw;
      if (bioOnly.location && !header.location) header.location = bioOnly.location;
    } catch (err) {
      noteLlmError(err);
    }
  }
  return header;
}
