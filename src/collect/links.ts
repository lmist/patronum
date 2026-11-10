/**
 * Instagram links.
 *
 * Turn profile and post URLs into handles, shortcodes and canonical links, and
 * tell image URLs from video URLs. Pure functions, no browser.
 */
export function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

export function usernameFromUrl(profileUrl: string): string | null {
  try {
    const u = new URL(profileUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 1) {
      const candidate = parts[0]!;
      if (
        !["p", "reel", "reels", "stories", "explore", "accounts", "direct"].includes(
          candidate.toLowerCase(),
        )
      ) {
        return candidate;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

export function normalizePermalink(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    if (href.startsWith("/")) {
      return `https://www.instagram.com${href.split("?")[0]}`;
    }
    const u = new URL(href);
    if (u.hostname.includes("instagram.com")) {
      return `${u.origin}${u.pathname}`.replace(/\/$/, "") + "/";
    }
  } catch {
    return href;
  }
  return href;
}

/** Open the canonical post route; profile-prefixed URLs can expose OG metadata
 * while the interactive post body never hydrates. Keep the original permalink
 * in the record for profile-grid ownership checks. */
export function canonicalDetailUrl(permalink: string): string {
  try {
    const url = new URL(permalink);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return permalink;
    const match = /\/(p|reel|tv)\/([A-Za-z0-9_-]+)/i.exec(url.pathname);
    return match ? `${url.origin}/${match[1]}/${match[2]}/` : permalink;
  } catch {
    return permalink;
  }
}

export function shortcodeFromPermalink(permalink: string | null | undefined): string | null {
  if (!permalink) return null;
  const m = permalink.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}

export function isHttp(u: string | null | undefined): u is string {
  return !!u && /^https?:\/\//i.test(u);
}

/** True for downloadable/playable video assets (not reel poster JPGs). */
export function isVideoUrl(u: string): boolean {
  return (
    /\.(mp4|m3u8|mov|webm)(\?|$)/i.test(u) ||
    /\/(?:t50\.|video_dash)/i.test(u)
  );
}

/** Put real video URLs first so igdl + M3 prefer video_url over stills. */
export function videoFirstUrls(urls: string[]): string[] {
  const v: string[] = [];
  const rest: string[] = [];
  for (const u of unique(urls.filter(isHttp))) {
    if (isVideoUrl(u)) v.push(u);
    else rest.push(u);
  }
  return [...v, ...rest];
}

export function permalinkBelongsTo(
  permalink: string | null | undefined,
  username: string,
  fromProfileGrid = false,
): boolean {
  if (!permalink || !username) return true;
  try {
    const parts = new URL(permalink, "https://www.instagram.com").pathname
      .split("/")
      .filter(Boolean);
    const head = parts[0]?.toLowerCase();
    if (head && !["p", "reel", "reels", "tv"].includes(head)) {
      return head === username.toLowerCase() || fromProfileGrid;
    }
    return true;
  } catch {
    return true;
  }
}

/** Instagram serves one post under several paths: `/reel/X/` redirects to
 * `/reels/X/` (Clips viewer), and posts may render as `/<user>/p/X/`. Same
 * origin plus the same shortcode is the same post; anything else is not. */
export function isSameDetailPost(actualHref: string, expectedUrl: string): boolean {
  let actual: URL;
  let expected: URL;
  try { actual = new URL(actualHref); expected = new URL(expectedUrl); } catch { return false; }
  if (actual.origin !== expected.origin) return false;
  const code = (path: string) => /\/(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(path)?.[1] ?? null;
  const want = code(expected.pathname);
  if (!want) return actual.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "");
  return code(actual.pathname) === want;
}
