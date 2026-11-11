import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runScrapeLlmPreflight } from "../collect/collect-profile.js";
import { assertDetailAuthenticated, classifyEnsureSessionError, stagehandAuthProbe } from "../collect/open-profile.js";
import { enrichOneItem } from "../collect/read-post.js";
import { isSameDetailPost, canonicalDetailUrl, permalinkBelongsTo } from "../collect/links.js";
import { postMetrics } from "../collect/merge-posts.js";
import { assertProfileNavigationResponse, DetailNavigationTimeout, InstagramHttpRejectionError } from "../collect/rejections.js";
import { enrichItemsWithDetail } from "../collect/open-every-post.js";
import { helpText, parseArgs } from "./scrape-profile.js";
import { isReelOrVideoPost } from "../collect/post-shape.js";
import { navigateDetailPage } from "../collect/open-post.js";
import { shouldRediscoverCachedProfileRequest } from "../collect/read-posts-from-api.js";
import { shouldSkipGridExtract } from "../collect/scroll-grid.js";
import { validateReusableGrid } from "../collect/resume.js";
import { AuthError, isAuthError } from "../sign-in/auth-check.js";
import { GraphqlProfileError, GraphqlProfileHttpError } from "../collect/graphql-profile.js";
import { DEFAULT_DETAIL_WORKERS } from "../collect/pool.js";

import { REPO_ROOT } from "../paths.js";
const root = REPO_ROOT;

/** The collector's source: the command file plus every step file in src/collect. */
function collectorSource(): string {
  const dir = resolve(root, "src/collect");
  return [
    resolve(root, "src/cmd/scrape-profile.ts"),
    ...readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.includes(".test.")).map((name) => resolve(dir, name)),
  ].map((path) => readFileSync(path, "utf8")).join("\n");
}


describe("scrape-profile help", () => {
  it("rediscovery is limited to cached schema failures, never HTTP or auth failures", () => {
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileError("Profile GraphQL timeline connection is missing or invalid"), "cache-rebound"), true);
    // Instagram's error codes are appended to the message; the cached request must still be dropped.
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileError("Profile GraphQL timeline connection is missing or invalid (1675012:variables, 1675012:variables)"), "cache-rebound"), true);
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileError("Profile GraphQL timeline connection is missing or invalid"), "observed"), false);
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileHttpError(429, "60"), "cache-rebound"), false);
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileHttpError(401), "cache-rebound"), false);
    assert.equal(shouldRediscoverCachedProfileRequest(new GraphqlProfileError("Profile GraphQL browser request failed"), "cache-rebound"), false);
    assert.equal(shouldRediscoverCachedProfileRequest(new AuthError("login", { state: "login", evidence: { ok: false } }), "cache-rebound"), false);
  });

  it("uses Stagehand context cookies for profile auth even without a page shell", async () => {
    const stagehand = { context: { cookies: async () => [{ name: "ds_user_id", value: "fixture", domain: ".instagram.com" }] } } as unknown as Parameters<typeof stagehandAuthProbe>[0];
    const page = {
      url: () => "https://www.instagram.com/designerbriefs/",
      evaluate: async <R>(): Promise<R> => ({ loginWall: false, loggedInShell: false, user: null }) as R,
    };
    await assertDetailAuthenticated(stagehandAuthProbe(stagehand, page), 50, 5);
    const login = { ...page, url: () => "https://www.instagram.com/accounts/login/" };
    await assert.rejects(assertDetailAuthenticated(stagehandAuthProbe(stagehand, login), 50, 5), (error) => isAuthError(error) && error.state === "login");
  });

  it("uses only an existing Stagehand navigation response for HTTP status", () => {
    assert.doesNotThrow(() => assertProfileNavigationResponse({ status: () => 200 }, "https://www.instagram.com/designerbriefs/"));
    assert.throws(() => assertProfileNavigationResponse({ status: () => 429, headers: () => ({ "retry-after": "120" }) }, "https://www.instagram.com/designerbriefs/"),
      (error) => error instanceof InstagramHttpRejectionError && error.httpStatus === 429 && error.retryAfter === "120" && error.retryable === false);
    assert.throws(() => assertProfileNavigationResponse({ status: () => 503, headers: () => { throw new Error("headers unavailable"); } }, "https://www.instagram.com/designerbriefs/"),
      (error) => error instanceof InstagramHttpRejectionError && error.httpStatus === 503 && error.retryAfter === null);
  });

  it("stops at an Instagram HTTP rejection and checkpoints the exact post error", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const item = (shortcode: string): Item => ({ shortcode, type: "image", permalink: `https://www.instagram.com/p/${shortcode}/`, mediaUrls: ["https://cdn.test/cover.jpg"] });
    const page = { url: () => "about:blank", goto: async () => {} };
    const opened: string[] = [];
    const checkpoints: Item[] = [];
    const transport = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";
    await assert.rejects(enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], page, [item("A"), item("B")], [], {
      workers: 1,
      onItem: (value) => checkpoints.push(value),
      enrichOne: async (_stagehand, _tab, value) => {
        opened.push(value.shortcode!);
        throw new InstagramHttpRejectionError(value.permalink!, transport);
      },
    }), (error) => error instanceof InstagramHttpRejectionError && error.retryable === false && error.transportError === transport);
    assert.deepEqual(opened, ["A"]);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.detailStatus, "failed");
    assert.equal(checkpoints[0]?.detailAttempts, 1);
    assert.match(checkpoints[0]?.detailError ?? "", /ERR_HTTP_RESPONSE_CODE_FAILURE/);
  });

  it("classifies a committed CDP HTTP-response failure without guessing its status", async () => {
    const url = "https://www.instagram.com/p/REJECTED/";
    const page = {
      url: () => url,
      goto: async () => {},
      evaluate: async <R>(): Promise<R> => ({ href: url }) as R,
      sendCDP: async (method: string) => method === "Page.navigate"
        ? { errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" }
        : {},
    };
    await assert.rejects(navigateDetailPage(page, url, 100), (error) =>
      error instanceof InstagramHttpRejectionError &&
      error.transportError === "net::ERR_HTTP_RESPONSE_CODE_FAILURE" &&
      !/429|Retry-After/.test(error.message));
  });

  it("checkpoints a failed post and continues on a focused replacement tab", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const item = (shortcode: string): Item => ({ shortcode, type: "image", permalink: `https://www.instagram.com/p/${shortcode}/`, mediaUrls: ["https://cdn.test/cover.jpg"] });
    const original = { url: () => "about:blank", goto: async () => {}, sendCDP: async () => {}, close: async () => {} };
    const focusCalls: string[] = [];
    const detailTab = { ...original, sendCDP: async (method: string) => { focusCalls.push(`initial:${method}`); } };
    const replacement = { ...original, sendCDP: async (method: string) => { focusCalls.push(`replacement:${method}`); } };
    // The watchdog closes a timed-out tab, so the next post must not reuse it.
    const next = { ...original, sendCDP: async (method: string) => { focusCalls.push(`next:${method}`); } };
    let created = 0;
    const seen: Array<{ code: string | null | undefined; tab: unknown }> = [];
    const checkpoints: Item[] = [];
    const result = await enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], original, [item("A"), item("B")], [], {
      workers: 1,
      createPage: async () => [detailTab, replacement, next][created++]!,
      onItem: (value) => checkpoints.push(value),
      enrichOne: async (_stagehand, tab, value) => {
        seen.push({ code: value.shortcode, tab });
        if (value.shortcode === "A") throw new DetailNavigationTimeout(value.permalink!, 20);
        return { opened: true, item: { ...value, mediaOwnershipVersion: 1, caption: "Full caption", captionComplete: true } };
      },
    });
    assert.deepEqual(seen.map((entry) => entry.code), ["A", "A", "B"]);
    assert.equal(seen[0]?.tab, detailTab);
    assert.equal(seen[1]?.tab, replacement);
    assert.equal(seen[2]?.tab, next);
    assert.deepEqual(focusCalls, ["initial:Emulation.setFocusEmulationEnabled", "replacement:Emulation.setFocusEmulationEnabled", "next:Emulation.setFocusEmulationEnabled"]);
    assert.equal(created, 3);
    assert.equal(result[0]?.detailStatus, "failed");
    assert.equal(result[0]?.detailAttempts, 2);
    assert.match(result[0]?.detailError ?? "", /navigation timed out/);
    assert.equal(result[1]?.detailStatus, "complete");
    assert.equal(result[1]?.detailError, null);
    assert.equal(checkpoints.length, 2);
  });

  it("does not rewrite checkpoints for unchanged resume-complete rows", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const complete: Item = {
      shortcode: "DONE", type: "image", permalink: "https://www.instagram.com/p/DONE/",
      mediaOwnershipVersion: 1, captionComplete: true, caption: "Full caption",
      mediaUrls: ["https://cdn.test/done.jpg"], detailStatus: "complete",
    };
    const pending: Item = { shortcode: "PENDING", type: "image", permalink: "https://www.instagram.com/p/PENDING/", mediaUrls: ["https://cdn.test/cover.jpg"] };
    const page = { url: () => "about:blank", goto: async () => {} };
    const checkpoints: string[] = [];
    const opened: string[] = [];
    const results = await enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], page, [complete, pending], [], {
      workers: 1,
      skipShortcodes: new Set(["DONE"]),
      onItem: (item) => checkpoints.push(item.shortcode!),
      enrichOne: async (_stagehand, _tab, item) => {
        opened.push(item.shortcode!);
        return { opened: true, item: { ...item, mediaOwnershipVersion: 1, captionComplete: true, caption: "New full caption" } };
      },
    });
    assert.deepEqual(opened, ["PENDING"]);
    assert.deepEqual(checkpoints, ["PENDING"]);
    assert.equal(results[0]?.detailStatus, "complete");
    assert.equal(results[0]?.mediaOwnershipVersion, 1);
    assert.equal(results[1]?.detailStatus, "complete");
  });

  it("keeps explicit auth failure fatal across the detail batch", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const first: Item = { shortcode: "A", type: "image", permalink: "https://www.instagram.com/p/A/", mediaUrls: ["https://cdn.test/a.jpg"] };
    const page = { url: () => "about:blank", goto: async () => {} };
    let secondCalled = false;
    await assert.rejects(enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], page, [first, { ...first, shortcode: "B" }], [], {
      workers: 1,
      enrichOne: async (_stagehand, _tab, value) => {
        if (value.shortcode === "B") secondCalled = true;
        throw new AuthError("login wall", { state: "login", evidence: { ok: false, state: "login" } });
      },
    }), (error) => isAuthError(error));
    assert.equal(secondCalled, false);
  });

  it("preserves verified slides when a caption-only retry remains incomplete", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const prior: Item = {
      shortcode: "A", type: "carousel", permalink: "https://www.instagram.com/p/A/",
      mediaOwnershipVersion: 1, carouselComplete: true, captionComplete: false,
      caption: "OG preview", mediaUrls: ["https://cdn.test/one.jpg", "https://cdn.test/two.jpg"],
      carouselMedia: [{ mediaUrl: "https://cdn.test/one.jpg" }, { mediaUrl: "https://cdn.test/two.jpg" }],
    };
    const page = { url: () => "about:blank", goto: async () => {}, close: async () => {} };
    let attempts = 0;
    const [result] = await enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], page, [prior], [], {
      workers: 1, createPage: async () => ({ ...page }),
      enrichOne: async () => {
        attempts++;
        if (attempts === 2) throw new Error("temporary detail failure");
        return { opened: true, item: { ...prior, mediaOwnershipVersion: undefined, carouselComplete: false, carouselMedia: null, caption: null, captionComplete: false } };
      },
    });
    assert.equal(attempts, 2);
    assert.equal(result?.detailStatus, "incomplete");
    assert.equal(result?.detailAttempts, 2);
    assert.match(result?.detailError ?? "", /temporary detail failure/);
    assert.equal(result?.mediaOwnershipVersion, 1);
    assert.equal(result?.carouselComplete, true);
    assert.equal(result?.carouselMedia?.length, 2);
    assert.equal(result?.caption, "OG preview");
  });

  it("treats Instagram's alias paths for one shortcode as the same post", () => {
    assert.equal(isSameDetailPost("https://www.instagram.com/reels/CLIP/", "https://www.instagram.com/reel/CLIP/"), true);
    assert.equal(isSameDetailPost("https://www.instagram.com/owner/p/POST/?img_index=1", "https://www.instagram.com/p/POST/"), true);
    assert.equal(isSameDetailPost("https://www.instagram.com/reels/OTHER/", "https://www.instagram.com/reel/CLIP/"), false);
    assert.equal(isSameDetailPost("https://www.instagram.com/reels/", "https://www.instagram.com/reel/CLIP/"), false);
    assert.equal(isSameDetailPost("https://evil.test/reel/CLIP/", "https://www.instagram.com/reel/CLIP/"), false);
    assert.equal(isSameDetailPost("not a url", "https://www.instagram.com/reel/CLIP/"), false);
  });

  it("surfaces a lost detail tab to the worker pool instead of recording a post failure", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const lost = {
      url: () => "about:blank", goto: async () => {},
      evaluate: async <R>(): Promise<R> => ({}) as R,
      sendCDP: async () => { throw new Error("-32001 Session with given id not found."); },
    };
    const notes: string[] = [];
    await assert.rejects(enrichOneItem({} as Parameters<typeof enrichOneItem>[0], lost,
      { shortcode: "CLIP", type: "reel", permalink: "https://www.instagram.com/reel/CLIP/" }, 0, 1, notes), /-32001/);
    assert.deepEqual(notes, []);

    const tabs: string[] = [];
    let created = 0;
    const result = await enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], lost, [{ shortcode: "A", type: "image", permalink: "https://www.instagram.com/p/A/" } as Item], [], {
      workers: 1,
      createPage: async () => ({ ...lost, sendCDP: async () => {}, name: `tab${++created}` }) as unknown as typeof lost,
      enrichOne: async (_stagehand, tab, value) => {
        tabs.push((tab as { name?: string }).name ?? "?");
        if (tabs.length === 1) throw new Error("-32001 Session with given id not found.");
        return { opened: true, item: { ...value, mediaOwnershipVersion: 1, mediaUrls: ["https://cdn.test/a.jpg"], caption: "A", captionComplete: true } };
      },
    });
    assert.deepEqual(tabs, ["tab1", "tab2"]);
    assert.equal(result[0]?.detailStatus, "complete");
  });

  it("reopens record-backed rows captured before metrics once, then skips them", async () => {
    type Item = Parameters<typeof enrichItemsWithDetail>[2][number];
    const row = (shortcode: string, extra: Partial<Item> = {}): Item => ({
      shortcode, type: "reel", permalink: `https://www.instagram.com/reel/${shortcode}/`, detailSource: "api-info",
      mediaOwnershipVersion: 1, captionComplete: true, caption: "Caption", mediaUrls: ["https://cdn.test/clip.mp4"],
      detailStatus: "complete", ...extra,
    });
    const page = { url: () => "about:blank", goto: async () => {} };
    const opened: string[] = [];
    const result = await enrichItemsWithDetail({} as Parameters<typeof enrichItemsWithDetail>[0], page, [row("OLD"), row("NEW", { metricsVersion: 1 })], [], {
      workers: 1,
      skipShortcodes: new Set(["OLD", "NEW"]),
      enrichOne: async (_stagehand, _tab, value) => {
        opened.push(value.shortcode!);
        return { opened: true, item: { ...value, metricsVersion: 1, likeCount: 4 } };
      },
    });
    assert.deepEqual(opened, ["OLD"]);
    assert.equal(result[0]?.likeCount, 4);
    assert.equal(result[0]?.metricsVersion, 1);
    assert.equal(result[1]?.detailStatus, "complete");
  });

  it("keeps only stated, non-negative post metrics", () => {
    assert.deepEqual(postMetrics({ likeCount: 5, commentCount: null, playCount: -1, viewCount: 0, videoDurationSec: 12.5 }), { likeCount: 5, viewCount: 0, videoDurationSec: 12.5 });
    assert.deepEqual(postMetrics({ likeCount: 9 }, { likeCount: 1, commentCount: 2 }), { likeCount: 9, commentCount: 2 });
    assert.deepEqual(postMetrics(undefined, {}), {});
  });

  it("stops and closes a detail tab whose CDP navigation never responds", async () => {
    const calls: string[] = [];
    const stuck = {
      goto: async () => await new Promise<never>(() => {}),
      url: () => "about:blank",
      sendCDP: async (method: string) => { calls.push(method); },
      close: async () => { calls.push("close"); },
    };
    await assert.rejects(navigateDetailPage(stuck, "https://www.instagram.com/p/STUCK/", 20), DetailNavigationTimeout);
    assert.deepEqual(calls, ["Page.stopLoading", "close"]);
  });

  it("retries only evidence-free unknown detail auth, not an explicit login page", async () => {
    const login = { url: () => "https://www.instagram.com/accounts/login/" };
    await assert.rejects(assertDetailAuthenticated(login, 5000, 10), (error) => isAuthError(error) && error.state === "login");
    const blank = {
      url: () => "https://www.instagram.com/p/POST/",
      evaluate: async <R>(): Promise<R> => ({ loginWall: false, loggedInShell: false, user: null }) as R,
    };
    await assert.rejects(assertDetailAuthenticated(blank, 20, 10), (error) => !isAuthError(error) && /did not hydrate/.test(String(error)));
  });

  it("reuses only an exact authenticated complete profile grid", () => {
    const prior = {
      username: "designerbriefs", sourceUrl: "https://www.instagram.com/designerbriefs/",
      session: { authenticated: true }, counts: { posts: 2 },
      posts: [
        { shortcode: "A", permalink: "https://www.instagram.com/designerbriefs/p/A/", mediaUrls: ["https://cdn.test/a.jpg"] },
        { shortcode: "B", permalink: "https://www.instagram.com/collaborator/p/B/", fromProfileGrid: true, mediaUrls: ["https://cdn.test/b.jpg"] },
      ],
      reels: [{ shortcode: "R", permalink: "https://www.instagram.com/designerbriefs/reel/R/", mediaUrls: [] }],
    };
    const valid = validateReusableGrid(prior, "designerbriefs", prior.sourceUrl, false);
    assert.equal(valid.posts?.length, 2);
    assert.equal(valid.reels?.length, 1);
    assert.equal(validateReusableGrid({ ...prior, session: { authenticated: false } }, "designerbriefs", prior.sourceUrl, false).posts, null);
    assert.equal(validateReusableGrid({ ...prior, counts: { posts: 3 } }, "designerbriefs", prior.sourceUrl, false).posts, null);
    assert.equal(validateReusableGrid({ ...prior, posts: [{ ...prior.posts[0] }, { ...prior.posts[1], fromProfileGrid: false }] }, "designerbriefs", prior.sourceUrl, false).posts, null);
  });

  it("uses env detail workers unless an explicit CLI value wins", () => {
    const previous = process.env.PATRONUM_DETAIL_WORKERS;
    try {
      process.env.PATRONUM_DETAIL_WORKERS = "4";
      assert.equal(parseArgs([]).workers, 4);
      assert.equal(parseArgs(["--workers", "2"]).workers, 2);
      process.env.PATRONUM_DETAIL_WORKERS = "invalid";
      assert.equal(parseArgs([]).workers, DEFAULT_DETAIL_WORKERS);
    } finally {
      if (previous === undefined) delete process.env.PATRONUM_DETAIL_WORKERS;
      else process.env.PATRONUM_DETAIL_WORKERS = previous;
    }
  });

  it("opens canonical post routes and trusts foreign-author URLs only from the profile grid", () => {
    assert.equal(canonicalDetailUrl("https://www.instagram.com/designerbriefs/p/ABC/"), "https://www.instagram.com/p/ABC/");
    assert.equal(canonicalDetailUrl("https://www.instagram.com/designerbriefs/reel/XYZ/"), "https://www.instagram.com/reel/XYZ/");
    assert.equal(permalinkBelongsTo("https://www.instagram.com/collaborator/p/ABC/", "designerbriefs", true), true);
    assert.equal(permalinkBelongsTo("https://www.instagram.com/stranger/p/OTHER/", "designerbriefs", false), false);
  });

  it("does not report a browser transport failure as an Instagram auth failure", () => {
    const transport = new Error("connect ECONNREFUSED 127.0.0.1:51028");
    assert.equal(classifyEnsureSessionError(transport), transport);
    assert.equal(isAuthError(classifyEnsureSessionError(transport)), false);

    const login = classifyEnsureSessionError(new Error("Login stuck (state=checkpoint)"));
    assert.equal(isAuthError(login), true);
    assert.equal((login as AuthError).state, "checkpoint");
  });

  it("documents default 10 parallel detail workers", () => {
    const text = helpText();
    assert.match(text, /--workers/);
    assert.match(text, /default:\s*10|default 10/i);
    assert.equal(DEFAULT_DETAIL_WORKERS, 10);
  });

  it("detail pass is wired through the shipped mapPool helper", () => {
    const src = collectorSource();
    assert.match(src, /from "\.\.\/collect\/pool\.js"/);
    assert.match(src, /mapPool\(/);
    assert.match(src, /DEFAULT_DETAIL_WORKERS/);
    assert.match(src, /createPage/);
    assert.match(src, /cdpDetail\.newTab/);
  });

  it("an empty owned harvest keeps grid media instead of failing the scrape", () => {
    const src = collectorSource();
    assert.doesNotMatch(
      src,
      /no post-owned media found; refusing unrelated page images/,
    );
    assert.match(src, /KEEP GRID/);
    assert.match(src, /keeping \$\{gridUrls\.length\} grid URL/);
    assert.match(src, /mediaOwnershipVersion: owned \? 1/);
    assert.match(src, /skip LLM extract \(media=0\)/);
  });

  it("documents --skip-reels for image/carousel-only scrapes", () => {
    const text = helpText();
    assert.match(text, /--skip-reels/);
    assert.match(text, /image \+ carousel/);
  });

  it("uses an identified DOM grid even when --max greatly exceeds account size", () => {
    assert.equal(shouldSkipGridExtract(120, 120), true);
    assert.equal(shouldSkipGridExtract(121, 120), true);
    assert.equal(shouldSkipGridExtract(119, 100000), true);
    assert.equal(shouldSkipGridExtract(0, 120), false);
    assert.equal(shouldSkipGridExtract(10, 0), false);
  });

  it("isReelOrVideoPost keeps image and carousel, drops reels and videos", () => {
    assert.equal(isReelOrVideoPost({ type: "image" }), false);
    assert.equal(isReelOrVideoPost({ type: "carousel", isVideo: true }), false);
    assert.equal(isReelOrVideoPost({ type: "photo" }), false);
    assert.equal(isReelOrVideoPost({ type: "reel" }), true);
    assert.equal(isReelOrVideoPost({ type: "video" }), true);
    assert.equal(
      isReelOrVideoPost({ permalink: "https://www.instagram.com/x/reel/ABC/" }),
      true,
    );
    assert.equal(isReelOrVideoPost({ isVideo: true }), true);
    assert.equal(
      isReelOrVideoPost({
        type: "image",
        permalink: "https://www.instagram.com/p/ABC/",
      }),
      false,
    );
  });

  it("bun src/cmd/scrape-profile.ts --help exits 0 and names --workers", () => {
    const out = execFileSync("bun", ["src/cmd/scrape-profile.ts", "--help"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.match(out, /USAGE/);
    assert.match(out, /--workers/);
    assert.match(out, /10/);
  });

  it("helpText documents fail-closed exit codes 0/1/2/3/4", () => {
    const text = helpText();
    assert.match(text, /EXIT CODES/);
    assert.match(text, /^\s*0\b/m);
    assert.match(text, /^\s*1\b/m);
    assert.match(text, /^\s*2\b/m);
    assert.match(text, /^\s*3\b/m);
    assert.match(text, /^\s*4\b/m);
    assert.match(text, /auth/i);
    assert.match(text, /llm/i);
    // No more "continuing public" language.
    assert.doesNotMatch(text, /public/i);
    assert.doesNotMatch(text, /allowPublic/);
  });

  it("source has no allowPublic / continuing public branches", () => {
    const src = collectorSource();
    assert.doesNotMatch(src, /allowPublic/);
    assert.doesNotMatch(src, /continuing public/);
    assert.doesNotMatch(src, /continuing without login/);
    // AuthError + assertAuthenticated must be wired in.
    assert.match(src, /assertAuthenticated/);
    assert.match(src, /AuthError/);
    assert.match(src, /exit\(3\)/);
  });

  it("ensure-session no longer exposes an allowPublic option", () => {
    const src = readFileSync(
      resolve(root, "src/sign-in/ensure-session.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /allowPublic/);
  });

  it("source has no llmDisabled / DOM-only-mode branches", () => {
    const src = collectorSource();
    assert.doesNotMatch(src, /llmDisabled/);
    assert.doesNotMatch(src, /continuing with DOM-only harvest/);
    assert.match(src, /pingLlm/);
    assert.match(src, /isProviderError/);
    assert.match(src, /exit\(4\)/);
  });

  it("missing QWEN_API_KEY exits 4 with error:llm BEFORE any Chrome start", () => {
    const before = statSync(resolve(root, "data/chrome-profile"), {
      throwIfNoEntry: false,
    })?.mtimeMs;
    let code = 0;
    let combined = "";
    // Empty strings block dotenv from repopulating from .env (dotenv only
    // sets when a key is undefined) and our firstNonEmpty treats "" as unset.
    const env = { ...process.env, LLM_API_KEY: "", QWEN_API_KEY: "", DASHSCOPE_API_KEY: "", ALIBABA_API_KEY: "" };
    try {
      execFileSync(
        "bun",
        ["src/cmd/scrape-profile.ts", "--url", "https://www.instagram.com/x/"],
        {
          cwd: root,
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      code = e.status ?? 0;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.equal(code, 4, combined);
    assert.match(combined, /"error":\s*"llm"/);
    assert.match(combined, /"kind":\s*"missing-key"/);
    const after = statSync(resolve(root, "data/chrome-profile"), {
      throwIfNoEntry: false,
    })?.mtimeMs;
    if (before !== undefined && after !== undefined) {
      assert.equal(
        before,
        after,
        "data/chrome-profile mtime changed → Chrome started before LLM check",
      );
    }
  });
});

it("requires explicit opt-in to skip the scraper LLM preflight", () => {
  assert.equal(parseArgs([]).skipLlmPreflight, false);
  assert.equal(parseArgs(["--skip-llm-preflight"]).skipLlmPreflight, true);
  assert.match(helpText(), /--skip-llm-preflight/);
});

it("skipped scraper preflight makes no provider request or key lookup", async () => {
  const keys = ["LLM_API_KEY", "QWEN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_API_KEY"];
  const prior = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "";
    await runScrapeLlmPreflight(true);
    await assert.rejects(runScrapeLlmPreflight(false), /key/i);
  } finally {
    keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
  }
});
