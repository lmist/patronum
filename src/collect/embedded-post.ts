/** Runs inside the authenticated canonical post page. Keep self-contained so
 * the same function can be serialized through Stagehand page.evaluate(). */
export function collectEmbeddedPostMedia(input: { shortcode: string; records?: unknown[] }) {
  type RecordLike = Record<string, unknown>;
  const object = (value: unknown): value is RecordLike => !!value && typeof value === "object" && !Array.isArray(value);
  const http = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
  };
  const mediaUrl = (value: string) => {
    const url = new URL(value);
    url.searchParams.delete("bytestart");
    url.searchParams.delete("byteend");
    return url.href;
  };
  const best = (value: unknown): string | null => {
    if (!Array.isArray(value)) return null;
    let winner: { url: string; area: number; width: number } | null = null;
    for (const candidate of value) {
      if (!object(candidate) || !http(candidate.url)) continue;
      const width = Number(candidate.width) || 0;
      const height = Number(candidate.height) || 0;
      const area = Math.max(0, width) * Math.max(0, height);
      if (!winner || area > winner.area || (area === winner.area && width > winner.width)) {
        winner = { url: mediaUrl(candidate.url), area, width };
      }
    }
    return winner?.url ?? null;
  };
  const image = (post: RecordLike) => best(object(post.image_versions2) ? post.image_versions2.candidates : null);
  const video = (post: RecordLike) => best(post.video_versions);
  const timestamp = (value: unknown): string | null => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const date = new Date(seconds > 1e12 ? seconds : seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const dashDuration = (manifest: unknown): number | null => {
    if (typeof manifest !== "string") return null;
    const match = /mediaPresentationDuration="PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"/.exec(manifest.slice(0, 4_000));
    if (!match || (!match[1] && !match[2] && !match[3])) return null;
    const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) / 1000 : null;
  };
  /** Engagement and duration only when the record states them; never 0 for absent. */
  const metrics = (post: RecordLike) => {
    const out: { likeCount?: number; commentCount?: number; playCount?: number; viewCount?: number; videoDurationSec?: number } = {};
    const likes = count(post.like_count);
    const comments = count(post.comment_count);
    const plays = count(post.play_count) ?? count(post.ig_play_count);
    const views = count(post.view_count) ?? count(post.video_view_count);
    const declared = typeof post.video_duration === "number" && Number.isFinite(post.video_duration) && post.video_duration > 0
      ? Math.round(post.video_duration * 1000) / 1000 : null;
    const duration = post.media_type === 2 ? declared ?? dashDuration(post.video_dash_manifest) : null;
    if (likes !== null) out.likeCount = likes;
    if (comments !== null) out.commentCount = comments;
    if (plays !== null) out.playCount = plays;
    if (views !== null) out.viewCount = views;
    if (duration !== null) out.videoDurationSec = duration;
    return out;
  };
  const decode = (post: RecordLike) => {
    if (post.code !== input.shortcode && post.shortcode !== input.shortcode) return null;
    if (post.media_type !== 1 && post.media_type !== 2 && post.media_type !== 8) return null;
    if (!("caption" in post) || !(post.caption === null ||
      (object(post.caption) && (typeof post.caption.text === "string" || post.caption.text === null)))) return null;
    const caption = post.caption === null ? null : (post.caption as RecordLike).text as string | null;
    if (caption && caption.length > 20_000) return null;
    const takenAt = timestamp(post.taken_at);
    if (!takenAt) return null;

    if (post.media_type === 8) {
      const children = post.carousel_media;
      const count = post.carousel_media_count;
      if (!Array.isArray(children) || !Number.isSafeInteger(count) || (count as number) < 2 || children.length !== count) return null;
      const carouselMedia: Array<{ mediaUrl: string; thumbnailUrl: string | null; isVideo: boolean }> = [];
      for (const child of children) {
        if (!object(child) || (child.media_type !== 1 && child.media_type !== 2)) return null;
        const poster = image(child);
        const isVideo = child.media_type === 2;
        const url = isVideo ? video(child) : poster;
        if (!url) return null;
        carouselMedia.push({ mediaUrl: url, thumbnailUrl: poster ?? (isVideo ? null : url), isVideo });
      }
      return {
        type: "carousel" as const, mediaUrls: carouselMedia.map((item) => item.mediaUrl),
        carouselMedia, thumbnailUrl: carouselMedia[0]?.thumbnailUrl ?? null,
        isVideo: carouselMedia.some((item) => item.isVideo), caption, timestamp: takenAt,
        ...metrics(post),
      };
    }

    const isVideo = post.media_type === 2;
    const poster = image(post);
    const url = isVideo ? video(post) : poster;
    if (!url) return null;
    return {
      type: isVideo ? "video" as const : "image" as const,
      mediaUrls: [url], carouselMedia: null,
      thumbnailUrl: poster ?? (isVideo ? null : url), isVideo, caption, timestamp: takenAt,
      ...metrics(post),
    };
  };

  if (input.records !== undefined) {
    if (!Array.isArray(input.records)) return null;
    for (const record of input.records.slice(0, 80)) {
      if (object(record)) {
        const result = decode(record);
        if (result) return result;
      }
    }
    return null;
  }

  const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[type="application/json"]')].slice(0, 80);
  let visited = 0;
  for (const script of scripts) {
    const source = script.textContent ?? "";
    if (!source || source.length > 16_000_000) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { continue; }
    const stack: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
    while (stack.length && visited < 100_000) {
      const { value, depth } = stack.pop()!;
      visited++;
      if (depth > 48 || !value || typeof value !== "object") continue;
      if (object(value)) {
        const result = decode(value);
        if (result) return result;
        for (const child of Object.values(value)) if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      } else if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

export type EmbeddedPostMedia = NonNullable<ReturnType<typeof collectEmbeddedPostMedia>>;
