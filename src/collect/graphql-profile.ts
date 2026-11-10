import { collectEmbeddedPostMedia, type EmbeddedPostMedia } from "./embedded-post.js";

export type GraphqlRequestTemplate = {
  url: string;
  method: string;
  postData: string;
  headers: Record<string, string>;
  /** Matched against the form body from an observed profile request. */
  operation: string;
  docId: string;
};

export type GraphqlProfileItem = {
  shortcode: string;
  node: Record<string, unknown>;
  media: EmbeddedPostMedia | null;
  complete: boolean;
  reason?: "incomplete-post-record";
};

export type GraphqlProfilePage = {
  nodes: Record<string, unknown>[];
  items: GraphqlProfileItem[];
  cursor: string | null;
  hasNextPage: boolean;
};

export class GraphqlProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphqlProfileError";
  }
}

export class GraphqlProfileHttpError extends GraphqlProfileError {
  readonly status: number;
  readonly retryAfter?: string;

  constructor(status: number, retryAfter?: string) {
    super(`Profile GraphQL request returned HTTP ${status}`);
    this.name = "GraphqlProfileHttpError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const CONNECTION = "PolarisProfilePostsTabContentQuery_connection";
const INITIAL = "PolarisProfilePostsQuery";
const MAX_BODY_BYTES = 8 * 1_048_576;
const MAX_EDGES = 48;
const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  if (payload.length > MAX_BODY_BYTES) throw new GraphqlProfileError("Profile GraphQL response is too large");
  try {
    return JSON.parse(payload.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, ""));
  } catch {
    throw new GraphqlProfileError("Profile GraphQL response is not valid JSON");
  }
}

/** Read only the requested profile's timeline connection, never adjacent recommendations. */
export function decodeProfileGraphqlPage(payload: unknown, handle: string): GraphqlProfilePage {
  if (!HANDLE.test(handle)) throw new GraphqlProfileError("Invalid profile handle");
  const root = parsePayload(payload);
  const data = object(root) && root.data;
  const connection = object(data) && data.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!object(connection) || !Array.isArray(connection.edges) || connection.edges.length > MAX_EDGES ||
    !object(connection.page_info)) {
    const errors = object(root) && Array.isArray(root.errors) ? root.errors : [];
    const evidence = errors.slice(0, 5).filter(object).map(error => {
      const message = [error.message, error.summary, error.description].filter(value => typeof value === "string").join(" ");
      const category = /csrf|token|lsd|auth|login/i.test(message) ? "authentication" : /cursor|after|before/i.test(message) ? "cursor" : /variable|argument|parameter/i.test(message) ? "variables" : /rate|limit|too many/i.test(message) ? "rate-limit" : "unclassified";
      return `${Number.isSafeInteger(error.code) ? String(error.code) : "unknown-code"}:${category}`;
    });
    throw new GraphqlProfileError(`Profile GraphQL timeline connection is missing or invalid${evidence.length ? ` (${evidence.join(", ")})` : ""}`);
  }

  const info = connection.page_info;
  if (typeof info.has_next_page !== "boolean" ||
    (info.end_cursor !== null && typeof info.end_cursor !== "string") ||
    (typeof info.end_cursor === "string" && (info.end_cursor.length > 4096 || /[\x00-\x1f]/.test(info.end_cursor))) ||
    (info.has_next_page && (!info.end_cursor || typeof info.end_cursor !== "string"))) {
    throw new GraphqlProfileError("Profile GraphQL pagination is invalid");
  }

  const nodes: Record<string, unknown>[] = [];
  const items: GraphqlProfileItem[] = [];
  for (const edge of connection.edges) {
    const node = object(edge) && edge.node;
    if (!object(node) || typeof node.code !== "string" || !SHORTCODE.test(node.code)) {
      throw new GraphqlProfileError("Profile GraphQL timeline contains an invalid post");
    }
    const media = collectEmbeddedPostMedia({ shortcode: node.code, records: [node] });
    nodes.push(node);
    items.push({ shortcode: node.code, node, media, complete: media !== null,
      ...(media === null ? { reason: "incomplete-post-record" as const } : {}) });
  }
  return { nodes, items, cursor: info.end_cursor as string | null, hasNextPage: info.has_next_page };
}

function single(form: URLSearchParams, key: string): string {
  const values = form.getAll(key);
  if (values.length !== 1 || !values[0]) throw new GraphqlProfileError("Invalid profile GraphQL request template");
  return values[0];
}

function preparedRequest(template: GraphqlRequestTemplate, handle: string, after?: string | null) {
  if (!HANDLE.test(handle) || template.method !== "POST" || template.postData.length > 100_000) {
    throw new GraphqlProfileError("Invalid profile GraphQL request template");
  }
  let url: URL;
  try { url = new URL(template.url); }
  catch { throw new GraphqlProfileError("Invalid profile GraphQL request template"); }
  if (url.protocol !== "https:" || url.hostname !== "www.instagram.com" || url.port || url.hash ||
    !["/graphql/query", "/api/graphql"].includes(url.pathname) || url.search) {
    throw new GraphqlProfileError("Profile GraphQL endpoint is not allowed");
  }

  const form = new URLSearchParams(template.postData);
  const operation = single(form, "fb_api_req_friendly_name");
  const docId = single(form, "doc_id");
  if (![CONNECTION, INITIAL].includes(operation) || operation !== template.operation ||
    docId !== template.docId || !/^\d{1,30}$/.test(docId)) {
    throw new GraphqlProfileError("Profile GraphQL operation is not allowed");
  }
  let variables: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(single(form, "variables"));
    if (!object(parsed)) throw new Error();
    variables = parsed;
  } catch {
    throw new GraphqlProfileError("Invalid profile GraphQL variables");
  }
  if (typeof variables.username !== "string" || variables.username.toLowerCase() !== handle.toLowerCase()) {
    throw new GraphqlProfileError("Profile GraphQL username does not match the requested profile");
  }
  if (!object(variables.data) || !Number.isSafeInteger(variables.data.count) ||
    (variables.data.count as number) < 1 || (variables.data.count as number) > 24) {
    throw new GraphqlProfileError("Invalid profile GraphQL page size");
  }
  if (operation === CONNECTION) {
    if (!Number.isSafeInteger(variables.first) || (variables.first as number) < 1 ||
      (variables.first as number) !== variables.data.count) {
      throw new GraphqlProfileError("Invalid profile GraphQL page size");
    }
    if (after !== undefined) {
      if (after !== null && (after.length < 1 || after.length > 4096 || /[\x00-\x1f]/.test(after))) {
        throw new GraphqlProfileError("Invalid profile GraphQL cursor");
      }
      variables.after = after;
    }
  } else if (after !== undefined) {
    throw new GraphqlProfileError("Initial profile GraphQL query does not support a cursor");
  }
  form.set("variables", JSON.stringify(variables));

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(template.headers)) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || typeof value !== "string" || value.length > 8192) continue;
    if (/^(?:cookie|host|content-length|origin|referer|user-agent|accept-encoding|connection)$/i.test(name) ||
      /^sec-/i.test(name)) continue;
    headers[name] = value;
  }
  return { url: url.href, body: form.toString(), headers };
}

/** This function is serialized into the already authenticated browser page. */
async function browserFetch(request: { url: string; body: string; headers: Record<string, string> }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(request.url, {
      method: "POST", body: request.body, headers: request.headers,
      credentials: "include", signal: controller.signal,
    });
    const retryAfter = response.headers.get("retry-after") ?? undefined;
    if (response.status !== 200) return { status: response.status, retryAfter, text: "", tooLarge: false };
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, retryAfter, text: "", tooLarge: false };
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8 * 1_048_576) {
        await reader.cancel();
        return { status: response.status, retryAfter, text: "", tooLarge: true };
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { status: response.status, retryAfter, text: parts.join(""), tooLarge: false };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchProfileGraphqlPage(
  page: { evaluate(expression: string): Promise<unknown> },
  template: GraphqlRequestTemplate,
  handle: string,
  after?: string | null,
): Promise<GraphqlProfilePage> {
  const request = preparedRequest(template, handle, after);
  let result: unknown;
  try {
    result = await page.evaluate(`(${browserFetch.toString()})(${JSON.stringify(request)})`);
  } catch {
    throw new GraphqlProfileError("Profile GraphQL browser request failed");
  }
  if (!object(result) || typeof result.status !== "number" || !Number.isInteger(result.status)) {
    throw new GraphqlProfileError("Profile GraphQL browser response is invalid");
  }
  const retryAfter = typeof result.retryAfter === "string" &&
    (/^\d{1,8}$/.test(result.retryAfter) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT$/.test(result.retryAfter))
    ? result.retryAfter : undefined;
  if (result.status !== 200) throw new GraphqlProfileHttpError(result.status, retryAfter);
  if (result.tooLarge === true || typeof result.text !== "string") {
    throw new GraphqlProfileError("Profile GraphQL response is too large or invalid");
  }
  return decodeProfileGraphqlPage(result.text, handle);
}
