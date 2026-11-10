import { expect, test } from "bun:test";
import { collectEmbeddedPostMedia } from "./embedded-post.js";
import { enrichOneItem } from "./read-post.js";

function fromScripts(values: unknown[], shortcode = "MATCH") {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelectorAll: () => values.map((value) => ({ textContent: JSON.stringify(value) })) },
  });
  try { return collectEmbeddedPostMedia({ shortcode }); }
  finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete (globalThis as { document?: Document }).document;
  }
}

const candidates = (name: string) => [
  { width: 320, height: 320, url: `https://cdn.test/${name}-small.jpg` },
  { width: 1080, height: 1080, url: `https://cdn.test/${name}-large.jpg` },
];

const image = (name: string) => ({ media_type: 1, image_versions2: { candidates: candidates(name) } });
const video = {
  media_type: 2,
  image_versions2: { candidates: candidates("poster") },
  video_versions: [
    { type: 103, width: 360, height: 480, url: "https://cdn.test/clip-low.mp4" },
    { type: 101, width: 720, height: 960, url: "https://cdn.test/clip-high.mp4?bytestart=0&byteend=999&token=ok" },
  ],
};

test("exact-code embedded carousel selects ordered highest-resolution image and video media", () => {
  const matching = {
    code: "MATCH", media_type: 8, carousel_media_count: 3,
    carousel_media: [image("first"), video, image("last")],
    caption: { text: "Full caption\nwith original lines" }, taken_at: 1789400000,
  };
  const unrelated = { ...matching, code: "OTHER", caption: { text: "Wrong post" } };
  const result = fromScripts([{ payload: [matching, unrelated] }]);
  expect(result?.type).toBe("carousel");
  expect(result?.mediaUrls).toEqual([
    "https://cdn.test/first-large.jpg",
    "https://cdn.test/clip-high.mp4?token=ok",
    "https://cdn.test/last-large.jpg",
  ]);
  expect(result?.carouselMedia).toEqual([
    { mediaUrl: "https://cdn.test/first-large.jpg", thumbnailUrl: "https://cdn.test/first-large.jpg", isVideo: false },
    { mediaUrl: "https://cdn.test/clip-high.mp4?token=ok", thumbnailUrl: "https://cdn.test/poster-large.jpg", isVideo: true },
    { mediaUrl: "https://cdn.test/last-large.jpg", thumbnailUrl: "https://cdn.test/last-large.jpg", isVideo: false },
  ]);
  expect(result?.caption).toBe("Full caption\nwith original lines");
  expect(result?.timestamp).toBe(new Date(1789400000 * 1000).toISOString());
  expect(result?.isVideo).toBe(true);
  expect(fromScripts([{ payload: unrelated }])).toBeNull();
});

test("incomplete carousel or missing video falls back without guessing", () => {
  const base = {
    code: "MATCH", media_type: 8, caption: { text: null }, taken_at: 1789400000,
    carousel_media: [image("first"), video], carousel_media_count: 2,
  };
  expect(fromScripts([base])?.caption).toBeNull();
  expect(fromScripts([{ ...base, carousel_media_count: 3 }])).toBeNull();
  expect(fromScripts([{ ...base, carousel_media: [image("first"), { ...video, video_versions: [] }] }])).toBeNull();
  expect(fromScripts([{ payload: JSON.stringify(base) }])).toBeNull();
  expect(fromScripts([{ ...video, code: "MATCH", caption: { text: "Video" }, taken_at: 1789400000, video_versions: [] }])).toBeNull();
});

test("raw records use the exact decoder without reading DOM scripts", () => {
  const record = {
    code: "MATCH", media_type: 1, image_versions2: { candidates: candidates("raw") },
    caption: { text: "Raw caption" }, taken_at: 1789400000,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Reflect.deleteProperty(globalThis, "document");
  try {
    expect(collectEmbeddedPostMedia({ shortcode: "MATCH", records: [record] })?.mediaUrls)
      .toEqual(["https://cdn.test/raw-large.jpg"]);
    expect(collectEmbeddedPostMedia({ shortcode: "MATCH", records: [{ ...record, caption: undefined }] }))
      .toBeNull();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
  }
});

test("authenticated detail uses exact embedded post before carousel clicking", async () => {
  const post = {
    code: "MATCH", media_type: 8, carousel_media_count: 3,
    carousel_media: [image("first"), video, image("last")],
    caption: { text: "Full embedded caption" }, taken_at: 1789400000,
  };
  const document = { querySelectorAll: () => [{ textContent: JSON.stringify({ unrelated: { ...post, code: "OTHER" }, post }) }] };
  const page = {
    url: () => "https://www.instagram.com/p/MATCH/",
    goto: async () => {},
    evaluate: async <R>(expression: string | (() => R)): Promise<R> => {
      if (typeof expression === "function") return expression();
      if (expression.includes("loggedInShell")) return { loginWall: false, loggedInShell: true, user: null } as R;
      return Function("document", `return ${expression}`)(document) as R;
    },
  };
  const stagehand = { context: { cookies: async () => [] } } as unknown as Parameters<typeof enrichOneItem>[0];
  const result = await enrichOneItem(stagehand, page, {
    shortcode: "MATCH", type: "carousel", permalink: "https://www.instagram.com/owner/p/MATCH/",
    mediaUrls: ["https://cdn.test/cover.jpg"], thumbnailUrl: "https://cdn.test/cover.jpg",
  }, 0, 1, []);
  expect(result.item.detailSource).toBe("embedded-json");
  expect(result.item.mediaOwnershipVersion).toBe(1);
  expect(result.item.carouselComplete).toBe(true);
  expect(result.item.captionComplete).toBe(true);
  expect(result.item.caption).toBe("Full embedded caption");
  expect(result.item.mediaUrls).toEqual([
    "https://cdn.test/first-large.jpg",
    "https://cdn.test/clip-high.mp4?token=ok",
    "https://cdn.test/last-large.jpg",
  ]);
});

test("stated likes, comments, plays, views and video duration are kept; absent ones stay absent", () => {
  const reel = {
    ...video, code: "MATCH", caption: { text: "Reel" }, taken_at: 1789400000,
    like_count: 129771, comment_count: 402, view_count: null, play_count: 2_500_000,
    video_dash_manifest: '<MPD mediaPresentationDuration="PT1M2.5S" minBufferTime="PT1S">',
  };
  const result = collectEmbeddedPostMedia({ shortcode: "MATCH", records: [reel] });
  expect(result).toMatchObject({ likeCount: 129771, commentCount: 402, playCount: 2_500_000, videoDurationSec: 62.5 });
  expect(result && "viewCount" in result).toBe(false);

  const declared = collectEmbeddedPostMedia({ shortcode: "MATCH", records: [{ ...reel, play_count: undefined, ig_play_count: 77, video_duration: 30.04 }] });
  expect(declared).toMatchObject({ playCount: 77, videoDurationSec: 30.04 });

  const still = collectEmbeddedPostMedia({ shortcode: "MATCH", records: [{
    code: "MATCH", media_type: 1, image_versions2: { candidates: candidates("still") },
    caption: { text: "Still" }, taken_at: 1789400000, like_count: -1, video_dash_manifest: 'mediaPresentationDuration="PT9S"',
  }] });
  expect(Object.keys(still ?? {}).filter((key) => /Count|Duration/.test(key))).toEqual([]);
});

test("a /reel/ link that lands on /reels/ is read from its embedded record with metrics", async () => {
  const reel = {
    ...video, code: "CLIP", caption: { text: "Reel caption" }, taken_at: 1789400000,
    like_count: 12, comment_count: 3, video_dash_manifest: '<MPD mediaPresentationDuration="PT30S">',
  };
  const document = { querySelectorAll: () => [{ textContent: JSON.stringify({ feed: [{ ...reel, code: "OTHER" }, reel] }) }] };
  const href = "https://www.instagram.com/reels/CLIP/";
  const calls: string[] = [];
  const page = {
    url: () => href,
    goto: async () => {},
    sendCDP: async (method: string) => { calls.push(method); return {}; },
    close: async () => { calls.push("close"); },
    evaluate: async <R>(expression: string | (() => R)): Promise<R> => {
      if (typeof expression === "function") return expression();
      if (expression.includes("loggedInShell")) return { loginWall: false, loggedInShell: true, user: null } as R;
      if (expression === "({ href: location.href })") return { href } as R;
      return Function("document", `return ${expression}`)(document) as R;
    },
  };
  const stagehand = { context: { cookies: async () => [] } } as unknown as Parameters<typeof enrichOneItem>[0];
  const result = await enrichOneItem(stagehand, page, {
    shortcode: "CLIP", type: "reel", permalink: "https://www.instagram.com/reel/CLIP/",
    mediaUrls: ["https://cdn.test/cover.jpg"],
  }, 0, 1, []);
  expect(calls).toEqual(["Page.navigate"]);
  expect(result.item).toMatchObject({
    detailSource: "embedded-json", type: "reel", captionComplete: true, caption: "Reel caption",
    mediaUrls: ["https://cdn.test/clip-high.mp4?token=ok"], likeCount: 12, commentCount: 3, videoDurationSec: 30,
  });
});
