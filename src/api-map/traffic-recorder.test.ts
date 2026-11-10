import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stagehand } from "@browserbasehq/stagehand";
import { getObservedPostRecord } from "./traffic-recorder.js";
import { getObservedDocumentResponse, getObservedProfileRequest, invalidateCachedProfileRequest, startInstagramTraffic, parseObservedJson } from "./traffic-recorder.js";

test("parses JSON served with an anti-XSSI prefix without evaluating JavaScript", () => {
  expect(parseObservedJson('for (;;);{"data":{"page_info":{"has_next_page":true}}}')).toEqual({data:{page_info:{has_next_page:true}}});
  expect(() => parseObservedJson("alert('not JSON')")).toThrow();
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

class FakeSession {
  listeners = new Map<string, Set<(event: unknown) => void>>();
  body: { body: string; base64Encoded?: boolean } | Error = { body: "{}" };
  sent: string[] = [];
  on(name: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  off(name: string, listener: (event: unknown) => void) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: unknown) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  async send(name: string) {
    this.sent.push(name);
    if (name === "Network.getResponseBody") {
      if (this.body instanceof Error) throw this.body;
      return this.body;
    }
    return {};
  }
}

function fixture() {
  const session = new FakeSession();
  const page = { mainFrameId: () => "main", getSessionForFrame: () => session };
  const pages = [page];
  const context = { pages: () => pages, newPage: async () => {
    const next = { mainFrameId: () => "main", getSessionForFrame: () => session };
    pages.push(next);
    return next;
  } };
  return { session, page, context, stagehand: { context } as unknown as Stagehand };
}

async function tempRoot() { const root = await mkdtemp(join(tmpdir(), "patronum-traffic-")); roots.push(root); return root; }
async function map(root: string) { return JSON.parse(await readFile(join(root, "cache", "instagram-api-map.json"), "utf8")); }

test("media-info records are available in memory and removed when the session closes", async () => {
  const root = await tempRoot();
  const { session, page, stagehand } = fixture();
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  session.body = { body: JSON.stringify({ items: [{ code: "REEL", media_type: 2, caption: { text: "PRIVATE_POST_CAPTION" }, taken_at: 1700000000, video_versions: [{ url: "https://cdn.test/private-video.mp4", width: 900, height: 1600 }], like_count: 12, comment_count: 3, play_count: 900, video_duration: 14.2, video_dash_manifest: '<MPD mediaPresentationDuration="PT14.2S">', user: { username: "owner" } }] }) };
  session.emit("Network.requestWillBeSent", { requestId: "info", request: { url: "https://www.instagram.com/api/v1/media/123456/info/", method: "GET" }, type: "Fetch" });
  session.emit("Network.responseReceived", { requestId: "info", type: "Fetch", response: { status: 200, mimeType: "application/json" } });
  session.emit("Network.loadingFinished", { requestId: "info", encodedDataLength: 500 });
  await run.flush();
  expect(getObservedPostRecord(page, "REEL")?.media_type).toBe(2);
  expect(getObservedPostRecord(page, "REEL")).toMatchObject({ like_count: 12, comment_count: 3, play_count: 900, video_duration: 14.2 });
  expect(getObservedPostRecord(page, "REEL")?.user).toBeUndefined();
  expect(await readFile(join(root, "cache/instagram-api-map.json"), "utf8")).not.toContain("PRIVATE_POST_CAPTION");
  await run.close();
  expect(getObservedPostRecord(page, "REEL")).toBeUndefined();
});

test("groups observed GraphQL operations, merges persisted counts, and never writes values", async () => {
  const root = await tempRoot();
  const { session, stagehand } = fixture();
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  const url = "https://www.instagram.com/graphql/query/?doc_id=123456789&variables=%7B%22first%22%3A12%2C%22after%22%3A%22PRIVATE_CURSOR%22%2C%22user_id%22%3A%2298765%22%7D&access_token=PRIVATE_TOKEN";
  const request = { url, method: "POST", postData: "fb_api_req_friendly_name=ProfileTimelineQuery&variables=%7B%22first%22%3A24%2C%22after%22%3A%22PRIVATE_CURSOR%22%7D&csrf_token=PRIVATE_CSRF", headers: { cookie: "PRIVATE_COOKIE", "x-fb-friendly-name": "ProfileTimelineQuery" } };
  session.body = { body: JSON.stringify({ data: { user: { id: "98765", caption: "PRIVATE_CAPTION", edge_owner_to_timeline_media: { page_info: { end_cursor: "PRIVATE_CURSOR", has_next_page: true }, edges: [{ node: { shortcode: "ABCD", token: "PRIVATE_TOKEN" } }] } } } }) };
  for (const id of ["one", "two"]) {
    session.emit("Network.requestWillBeSent", { requestId: id, request, type: "Fetch", timestamp: 1 });
    session.emit("Network.responseReceived", { requestId: id, type: "Fetch", response: { status: 200, mimeType: "application/json", headers: { "set-cookie": "PRIVATE_COOKIE" } } });
    session.emit("Network.loadingFinished", { requestId: id, timestamp: 1.12, encodedDataLength: 500 });
  }
  await run.close();
  const saved = await map(root);
  expect(saved.operations).toHaveLength(1);
  expect(saved.operations[0]).toMatchObject({ operation: "ProfileTimelineQuery", docId: "123456789", statusCounts: { "200": 2 }, queryKeys: ["doc_id", "variables"], paginationFields: ["end_cursor", "has_next_page", "page_info"] });
  const networkDir = join(run.runDir, "cdp", "network");
  const files = await readdir(networkDir);
  expect(files.sort()).toEqual(["requests.jsonl", "responses.jsonl"]);
  const disk = (await Promise.all([join(root, "cache", "instagram-api-map.json"), ...files.map((file) => join(networkDir, file))].map((file) => readFile(file, "utf8")))).join("\n");
  for (const secret of ["PRIVATE_CURSOR", "PRIVATE_TOKEN", "PRIVATE_COOKIE", "PRIVATE_CSRF", "PRIVATE_CAPTION", "98765", "access_token"]) expect(disk).not.toContain(secret);
  expect(saved.operations[0].variablesShape.user_id).toBe("string");
  const savedRequest = JSON.parse((await readFile(join(networkDir, "requests.jsonl"), "utf8")).trim().split("\n")[0]!);
  expect(JSON.parse(savedRequest.params.request.postData)).toEqual({ operationName: "ProfileTimelineQuery", doc_id: "123456789" });
  const second = fixture();
  const resumed = await startInstagramTraffic(second.stagehand, { root, handle: "brand" });
  second.session.emit("Network.requestWillBeSent", { requestId: "three", request, type: "Fetch", timestamp: 1 });
  second.session.emit("Network.responseReceived", { requestId: "three", type: "Fetch", response: { status: 429, mimeType: "application/json" } });
  second.session.emit("Network.loadingFinished", { requestId: "three", timestamp: 1.3 });
  await resumed.close();
  expect((await map(root)).operations[0].statusCounts).toEqual({ "200": 2, "429": 1 });
});

test("correlates ExtraInfo 429 and Retry-After with exact Document URL before loadingFailed", async () => {
  const root = await tempRoot();
  const { session, page, context, stagehand } = fixture();
  const originalNewPage = context.newPage;
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  const next = await context.newPage();
  const url = "http://127.0.0.1:8123/brand/?private=SECRET";
  // Explicit loopback fixture requires its own allowlist; default recorder ignores it.
  expect(getObservedDocumentResponse(next as never, url)).toBeUndefined();
  await run.close();
  expect(context.newPage).toBe(originalNewPage);
  const local = await startInstagramTraffic(stagehand, { root, handle: "brand", allowOrigins: ["http://127.0.0.1:8123"] });
  session.emit("Network.requestWillBeSent", { requestId: "navigation", request: { url, method: "GET" }, type: "Document" });
  session.emit("Network.responseReceivedExtraInfo", { requestId: "navigation", statusCode: 429, headers: { "Retry-After": "60", cookie: "SECRET" } });
  expect(getObservedDocumentResponse(page as never, url)).toEqual({ status: 429, retryAfter: "60" });
  session.emit("Network.loadingFailed", { requestId: "navigation", errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
  expect(getObservedDocumentResponse(page as never, url)).toEqual({ status: 429, retryAfter: "60", transportError: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" });
  expect(getObservedDocumentResponse(page as never, "http://127.0.0.1:8123/brand/")).toBeUndefined();
  await local.close();
  const log = await readFile(join(local.runDir, "navigation.jsonl"), "utf8");
  expect(log).toContain('"status":429');
  expect(log).toContain('"retryAfter":"60"');
  expect(log).not.toContain("SECRET");
});

test("unavailable response bodies do not interrupt flush or listener cleanup", async () => {
  const root = await tempRoot();
  const { session, stagehand } = fixture();
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  session.body = new Error("PRIVATE_BODY_FAILURE");
  session.emit("Network.requestWillBeSent", { requestId: "a", request: { url: "https://www.instagram.com/api/v1/feed/", method: "GET" }, type: "Fetch" });
  session.emit("Network.responseReceived", { requestId: "a", type: "Fetch", response: { status: 200, mimeType: "application/json" } });
  session.emit("Network.loadingFinished", { requestId: "a", encodedDataLength: 100 });
  await run.close();
  expect(session.sent).toContain("Network.getResponseBody");
  expect((await map(root)).operations[0].statusCounts).toEqual({ "200": 1 });
  expect(session.listeners.get("Network.requestWillBeSent")?.size).toBe(0);
});

test("JSON GraphQL payloads retain only schema and errors after trace cap remain visible", async () => {
  const root = await tempRoot();
  const { session, page, stagehand } = fixture();
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  const graphql = "https://www.instagram.com/graphql/query/";
  session.emit("Network.requestWillBeSent", { requestId: "json", type: "Fetch", request: { url: graphql, method: "POST", postData: JSON.stringify({ operationName: "FeedQuery", doc_id: "654321", variables: { user_id: "PRIVATE_ID", cursor: "PRIVATE_CURSOR", count: 12 } }) } });
  session.emit("Network.responseReceived", { requestId: "json", type: "Fetch", response: { status: 200, mimeType: "application/json" } });
  session.emit("Network.loadingFinished", { requestId: "json" });
  for (let index = 0; index < 2_005; index++) {
    session.emit("Network.requestWillBeSent", { requestId: `image-${index}`, type: "Image", request: { url: `https://www.instagram.com/static/logo.png?nonce=${index}`, method: "GET" } });
  }
  const document = "https://www.instagram.com/brand/?after=PRIVATE_CURSOR";
  session.emit("Network.requestWillBeSent", { requestId: "late", type: "Document", request: { url: document, method: "GET" } });
  session.emit("Network.responseReceivedExtraInfo", { requestId: "late", statusCode: 429, headers: { "retry-after": "42" } });
  session.emit("Network.loadingFailed", { requestId: "late", errorText: "net::ERR_FAILED" });
  expect(getObservedDocumentResponse(page as never, document)).toMatchObject({ status: 429, retryAfter: "42" });
  await run.close();
  const saved = await map(root);
  expect(saved.operations[0]).toMatchObject({ operation: "FeedQuery", docId: "654321", variablesShape: { user_id: "string", cursor: "string", count: "number" } });
  const disk = (await readFile(join(root, "cache", "instagram-api-map.json"), "utf8")) + (await readFile(join(run.runDir, "navigation.jsonl"), "utf8"));
  expect(disk).not.toContain("PRIVATE_ID");
  expect(disk).not.toContain("PRIVATE_CURSOR");
  expect(disk).toContain('"status":429');
  expect(JSON.parse(await readFile(join(run.runDir, "trace-summary.json"), "utf8"))).toMatchObject({ truncated: true, recordedRequests: 2_000, observedRequests: 2_007 });
});

test("cache reload discards unvalidated fields rather than copying them forward", async () => {
  const root = await tempRoot();
  await mkdir(join(root, "cache"));
  await writeFile(join(root, "cache", "instagram-api-map.json"), JSON.stringify({ operations: [{ method: "GET", origin: "https://www.instagram.com", pathTemplate: "/graphql/query/", operation: "FeedQuery", queryKeys: ["variables"], statusCounts: { "200": 2 }, lastSeen: "2026-09-14T00:00:00.000ZPRIVATE_TOKEN", responseShape: { data: { user: "PRIVATE_ID" } }, rawPostData: "PRIVATE_CSRF" }] }));
  const run = await startInstagramTraffic(fixture().stagehand, { root, handle: "brand" });
  await run.close();
  const disk = await readFile(join(root, "cache", "instagram-api-map.json"), "utf8");
  expect(disk).not.toContain("PRIVATE_");
  expect((await map(root)).operations[0].statusCounts).toEqual({ "200": 2 });
});

test("profile rebound selects the latest validated ID, invalidates it, and accepts a fresh observed ID", async () => {
  const root = await tempRoot();
  await mkdir(join(root, "cache"));
  const operation = (docId: string, validated: string) => ({
    method: "POST", origin: "https://www.instagram.com", pathTemplate: "/graphql/query",
    queryKeys: [], operation: "PolarisProfilePostsTabContentQuery_connection", docId,
    responseShape: { data: { xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [{ node: { code: "string" } }], page_info: { end_cursor: "string", has_next_page: "boolean" } } } },
    paginationFields: ["end_cursor", "has_next_page", "page_info"], statusCounts: { "200": 1 },
    lastSeen: "2026-09-14T12:00:00.000Z", lastProfileValidationAt: validated,
  });
  await writeFile(join(root, "cache", "instagram-api-map.json"), JSON.stringify({ operations: [
    operation("111", "2026-09-14T10:00:00.000Z"),
    operation("222", "2026-09-14T11:00:00.000Z"),
  ] }));
  const { session, page, stagehand } = fixture();
  const run = await startInstagramTraffic(stagehand, { root, handle: "brand" });
  const url = "https://www.instagram.com/graphql/query";
  const request = (operationName: string, docId: string) => ({
    url, method: "POST", postData: new URLSearchParams({
      fb_api_req_friendly_name: operationName, doc_id: docId,
      variables: JSON.stringify({ username: "brand", data: { count: 12 } }),
    }).toString(),
    headers: { "x-csrftoken": "PRIVATE_CSRF" },
  });
  session.emit("Network.requestWillBeSent", { requestId: "initial", type: "Fetch", request: request("PolarisProfilePostsQuery", "333") });
  expect(getObservedProfileRequest(page, "brand")).toMatchObject({ docId: "222", provenance: "cache-rebound" });
  session.emit("Network.requestWillBeSent", { requestId: "self-fetch", type: "Fetch", request: request("PolarisProfilePostsTabContentQuery_connection", "222") });
  expect(getObservedProfileRequest(page, "brand")).toMatchObject({ docId: "222", provenance: "cache-rebound" });
  expect(invalidateCachedProfileRequest(page, "brand", "111")).toBe(false);
  expect(invalidateCachedProfileRequest(page, "brand", "222")).toBe(true);
  expect(getObservedProfileRequest(page, "brand")).toBeUndefined();
  session.emit("Network.requestWillBeSent", { requestId: "initial-again", type: "Fetch", request: request("PolarisProfilePostsQuery", "333") });
  expect(getObservedProfileRequest(page, "brand")).toBeUndefined();
  session.emit("Network.requestWillBeSent", { requestId: "fresh-connection", type: "Fetch", request: request("PolarisProfilePostsTabContentQuery_connection", "444") });
  expect(getObservedProfileRequest(page, "brand")).toMatchObject({ docId: "444", provenance: "observed" });
  await run.close();
  const saved = await map(root);
  expect(saved.operations.find((item: { docId: string }) => item.docId === "111")).toBeDefined();
  expect(saved.operations.find((item: { docId: string }) => item.docId === "222")?.cacheValidationFailedAt).toMatch(/^2026-/);
  const next = fixture();
  const resumed = await startInstagramTraffic(next.stagehand, { root, handle: "brand" });
  next.session.emit("Network.requestWillBeSent", { requestId: "later-initial", type: "Fetch", request: request("PolarisProfilePostsQuery", "333") });
  expect(getObservedProfileRequest(next.page, "brand")).toMatchObject({ docId: "111", provenance: "cache-rebound" });
  await resumed.close();
});
