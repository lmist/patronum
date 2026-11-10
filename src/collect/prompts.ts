/**
 * Stagehand observe / act / extract instructions for Instagram profile scrape.
 *
 * Guided by Stagehand v3 prompting best practices:
 * https://docs.stagehand.dev/v3/best-practices/prompting-best-practices
 * - atomic, specific observe targets (element type + role, not color)
 * - plan with observe → act with returned action
 * - extract schemas with descriptive field .describe()
 * - never invent media URLs; only DOM-visible src / href
 */

// ── Observe (discovery) ───────────────────────────────────────────

/** Profile chrome: identity + stats + tab strip */
export const OBSERVE_PROFILE_HEADER =
  "find the profile header region: profile picture image, display name, username, posts followers following counts, and bio or about text";

export const OBSERVE_PROFILE_TABS =
  "find the profile content tab buttons or links labeled Posts, Reels, Tagged, or similar in the tab strip under the profile header";

export const OBSERVE_POSTS_TAB =
  "find the Posts tab button or link in the profile tab strip (grid of posts, not Reels and not Tagged)";

export const OBSERVE_REELS_TAB =
  "find the Reels tab button or link in the profile tab strip (reel or clip grid, not Posts)";

export const OBSERVE_POST_GRID =
  "find every clickable post or reel thumbnail link in the main profile grid that navigates to /p/ or /reel/";

export const OBSERVE_LOAD_MORE_OR_SCROLL =
  "find any 'Load more' or 'See more' button related to the profile grid or bio; ignore cookie and login dialogs";

export const OBSERVE_COOKIE_OR_LOGIN_WALL =
  "find cookie Accept or Allow buttons, or a Log in dialog close/dismiss control, if either is blocking the profile";

export const OBSERVE_BIO_EXPAND =
  "find a 'more' or 'see more' control that expands a truncated profile bio";

// ── Act (single atomic actions) ───────────────────────────────────

export const ACT_CLICK_POSTS_TAB =
  "click the Posts tab in the profile tab strip under the header";

export const ACT_CLICK_REELS_TAB =
  "click the Reels tab in the profile tab strip under the header";

export const ACT_EXPAND_BIO =
  "click the more or see more control that expands the profile bio text";

export const ACT_DISMISS_OVERLAY =
  "click the Accept cookies button or the close button on a modal that is covering the profile page";

// ── Extract instructions (paired with zod schemas in scrape-profile) ─

export function extractHeaderInstruction(usernameHint: string): string {
  return [
    "Extract ONLY the Instagram profile header for this page.",
    `Expected username context: ${usernameHint}.`,
    "Capture: username without @, full display name, profile picture img src if present in the DOM,",
    "full bio text (after expansion if visible), location or address line if shown,",
    "and posts / followers / following counts as numbers (parse 1.2K → 1200, 3.4M → 3400000 when shown that way).",
    "Do not invent values. Use null when a field is not visible.",
    "Do not list posts or reels in this step.",
  ].join(" ");
}

export function extractGridInstruction(opts: {
  surface: "posts" | "reels";
  max: number;
}): string {
  const surface =
    opts.surface === "reels"
      ? "Reels tab grid (reel/clip thumbnails)"
      : "Posts tab grid (photo/video/carousel thumbnails)";
  return [
    `Extract every visible item in the Instagram profile ${surface}.`,
    `Return at most ${opts.max} items.`,
    "For each item include: shortcode or id from the /p/ or /reel/ link if present,",
    "type (image | video | carousel | reel), caption only if already visible without opening,",
    "timestamp only if visible, permalink URL, thumbnailUrl from the img src attribute,",
    "mediaUrls as an array of actual img/video/source src values from the DOM only.",
    "Set isVideo true when a video/reel/clip indicator is present.",
    "Never invent, guess, or reconstruct CDN URLs that are not in the DOM.",
    "If the grid is empty or blocked, return an empty list and note why in notes.",
  ].join(" ");
}

export function extractBioOnlyInstruction(): string {
  return [
    "Extract the full profile bio / about text block and any location line shown under the profile name.",
    "If a truncated bio has already been expanded, use the full text.",
    "Do not invent contact info; only copy what is visible.",
  ].join(" ");
}

export const OBSERVE_POST_DETAIL_MEDIA =
  "find the main post or reel media: primary image, video player, carousel slides, and next/previous carousel buttons if this is a multi-image post";

export const OBSERVE_CAROUSEL_NEXT =
  "find the Next button or chevron control that advances to the next slide in the Instagram post carousel";

export const ACT_CAROUSEL_NEXT =
  "click the Next button or right chevron that advances the Instagram post carousel to the next slide";

export function extractPostDetailInstruction(): string {
  return [
    "Extract this open Instagram post or reel detail view.",
    "Capture: shortcode from the URL if visible, type (image|video|carousel|reel),",
    "full caption text if shown, timestamp if shown, permalink,",
    "every media URL currently visible as img/video/source src attributes in the main media area (mediaUrls array),",
    "thumbnailUrl if distinct, isVideo true for video/reel,",
    "and carouselMedia entries for each slide if this is a carousel (mediaUrl/thumbnailUrl/isVideo per slide).",
    "Never invent CDN URLs — only copy src values present in the DOM.",
  ].join(" ");
}
