import { expect, test } from "bun:test";
import {
  decodeProfileGraphqlPage, fetchProfileGraphqlPage,
  GraphqlProfileError, GraphqlProfileHttpError,
  type GraphqlRequestTemplate,
} from "./graphql-profile.js";

const candidates = (name: string) => [
  { width: 300, height: 300, url: `https://cdn.test/${name}-small.jpg` },
  { width: 1080, height: 1080, url: `https://cdn.test/${name}-large.jpg` },
];
const image = (name: string) => ({ media_type: 1, image_versions2: { candidates: candidates(name) } });
const video = (name: string) => ({ media_type: 2,
  image_versions2: { candidates: candidates(`${name}-poster`) },
  video_versions: [{ width: 720, height: 960, url: `https://cdn.test/${name}.mp4?bytestart=0&token=ok` }],
});
const common = { caption: { text: "Full caption" }, taken_at: 1789400000 };
const nodes = [
  { ...image("image"), ...common, code: "IMAGE" },
  { ...video("video"), ...common, code: "VIDEO" },
  { ...common, code: "CAROUSEL", media_type: 8, carousel_media_count: 3,
    carousel_media: [image("first"), video("middle"), image("last")] },
];

function payload(records: unknown[] = nodes, hasNextPage = true, cursor: string | null = "NEXT") {
  return { data: {
    xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: records.map((node) => ({ node })),
      page_info: { has_next_page: hasNextPage, end_cursor: cursor },
    },
    unrelated_recommendations: { edges: [{ node: { ...nodes[0], code: "WRONG" } }] },
  } };
}

function template(operation = "PolarisProfilePostsTabContentQuery_connection", username = "owner"): GraphqlRequestTemplate {
  const docId = operation === "PolarisProfilePostsQuery" ? "28322872020710458" : "28648141034875162";
  const form = new URLSearchParams({
    fb_api_req_friendly_name: operation,
    doc_id: docId,
    variables: JSON.stringify(operation === "PolarisProfilePostsQuery"
      ? { data: { count: 3 }, username }
      : { after: null, before: null, data: { count: 3, include_relationship_info: true }, first: 3, last: null, username }),
    lsd: "in-memory-token",
  });
  return { url: "https://www.instagram.com/graphql/query", method: "POST", postData: form.toString(), operation, docId,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-csrftoken": "secret-token", cookie: "ignored-cookie" } };
}

test("decodes only the profile connection in order, including mixed carousel media", () => {
  const decoded = decodeProfileGraphqlPage(`for (;;);${JSON.stringify(payload())}`, "owner");
  expect(decoded.items.map((item) => item.shortcode)).toEqual(["IMAGE", "VIDEO", "CAROUSEL"]);
  expect(decoded.items.every((item) => item.complete)).toBe(true);
  expect(decoded.items.map((item) => item.media?.type)).toEqual(["image", "video", "carousel"]);
  expect(decoded.items[2]?.media?.mediaUrls).toEqual([
    "https://cdn.test/first-large.jpg",
    "https://cdn.test/middle.mp4?token=ok",
    "https://cdn.test/last-large.jpg",
  ]);
  expect(decoded.cursor).toBe("NEXT");
  expect(decoded.hasNextPage).toBe(true);
  expect(decoded.nodes).toHaveLength(3);
});

test("missing caption, timestamp, and carousel children remain partial", () => {
  const sparse = [
    { ...nodes[0], caption: undefined },
    { ...nodes[1], taken_at: undefined },
    { ...nodes[2], carousel_media: [image("first"), video("middle")] },
  ];
  const decoded = decodeProfileGraphqlPage(payload(sparse, false, null), "owner");
  expect(decoded.items.map((item) => item.complete)).toEqual([false, false, false]);
  expect(decoded.items.map((item) => item.reason)).toEqual([
    "incomplete-post-record", "incomplete-post-record", "incomplete-post-record",
  ]);
  expect(decoded.items.map((item) => item.media)).toEqual([null, null, null]);
});

test("rejects missing connection and unusable next cursor", () => {
  expect(() => decodeProfileGraphqlPage({ data: { recommendations: payload().data } }, "owner"))
    .toThrow(GraphqlProfileError);
  expect(() => decodeProfileGraphqlPage(payload(nodes, true, null), "owner"))
    .toThrow("pagination");
  expect(() => decodeProfileGraphqlPage(payload(nodes, true, "bad\nvalue"), "owner"))
    .toThrow("pagination");
});

test("browser fetch preserves observed fields, changes only connection cursor, and includes credentials", async () => {
  let calls = 0;
  const fakeFetch = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("https://www.instagram.com/graphql/query");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("include");
    expect((options.headers as Record<string, string>)["x-csrftoken"]).toBe("secret-token");
    expect((options.headers as Record<string, string>).cookie).toBeUndefined();
    const form = new URLSearchParams(options.body as string);
    expect(form.get("lsd")).toBe("in-memory-token");
    expect(form.get("doc_id")).toBe("28648141034875162");
    expect(JSON.parse(form.get("variables")!)).toEqual({
      after: "NEXT", before: null, data: { count: 3, include_relationship_info: true },
      first: 3, last: null, username: "owner",
    });
    return new Response(JSON.stringify(payload(nodes, false, null)), { status: 200,
      headers: { "content-type": "text/javascript" } });
  };
  const page = { evaluate: async (expression: string): Promise<unknown> =>
    Function("fetch", `return ${expression}`)(fakeFetch) };
  const decoded = await fetchProfileGraphqlPage(page, template(), "owner", "NEXT");
  expect(decoded.items).toHaveLength(3);
  expect(calls).toBe(1);
});

test("request guards stop mismatched usernames, unknown operations, and initial-query pagination", async () => {
  let calls = 0;
  const page = { evaluate: async (_expression: string) => { calls++; return {}; } };
  await expect(fetchProfileGraphqlPage(page, template(undefined, "other"), "owner", "NEXT"))
    .rejects.toThrow("username");
  const bad = template();
  bad.postData = bad.postData.replace("28648141034875162", "1");
  await expect(fetchProfileGraphqlPage(page, bad, "owner", "NEXT"))
    .rejects.toThrow("operation");
  const unknown = template();
  unknown.operation = "SomeOtherQuery";
  await expect(fetchProfileGraphqlPage(page, unknown, "owner"))
    .rejects.toThrow("operation");
  await expect(fetchProfileGraphqlPage(page, template("PolarisProfilePostsQuery"), "owner", "NEXT"))
    .rejects.toThrow("does not support a cursor");
  expect(calls).toBe(0);
});

test("a newly observed document ID is accepted when its proof matches the form", async () => {
  const observed = template("PolarisProfilePostsQuery");
  observed.docId = "12345678901234567";
  const form = new URLSearchParams(observed.postData);
  form.set("doc_id", observed.docId);
  observed.postData = form.toString();
  const page = { evaluate: async (_expression: string) => ({ status: 200, text: JSON.stringify(payload(nodes, false, null)) }) };
  const decoded = await fetchProfileGraphqlPage(page, observed, "owner");
  expect(decoded.items.map((item) => item.shortcode)).toEqual(["IMAGE", "VIDEO", "CAROUSEL"]);
});

test("HTTP failures expose status and retry-after without response content", async () => {
  const page = { evaluate: async (_expression: string) => ({ status: 429, retryAfter: "60",
    text: "private-token", tooLarge: false }) };
  try {
    await fetchProfileGraphqlPage(page, template(), "owner");
    throw new Error("Expected HTTP error");
  } catch (error) {
    expect(error).toBeInstanceOf(GraphqlProfileHttpError);
    expect((error as GraphqlProfileHttpError).status).toBe(429);
    expect((error as GraphqlProfileHttpError).retryAfter).toBe("60");
    expect((error as Error).message).not.toContain("private-token");
  }
});
