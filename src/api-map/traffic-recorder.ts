import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Stagehand } from "@browserbasehq/stagehand";
import { layout } from "../paths.js";

type Page = ReturnType<Stagehand["context"]["pages"]>[number];
type Session = ReturnType<Page["getSessionForFrame"]>;
type Headers = Record<string, unknown>;
type RequestEvent = { requestId: string; request: { url: string; method: string; postData?: string; headers?: Headers }; type?: string; timestamp?: number; redirectResponse?: { status: number } };
type ResponseEvent = { requestId: string; type?: string; timestamp?: number; response: { status: number; mimeType?: string; headers?: Headers; url?: string; encodedDataLength?: number } };
type ExtraEvent = { requestId: string; statusCode: number; headers?: Headers };
type FinishEvent = { requestId: string; encodedDataLength?: number; timestamp?: number };
type FailEvent = { requestId: string; errorText?: string; timestamp?: number };

export type ObservedDocumentResponse = { status: number; retryAfter?: string; transportError?: string };
export type ObservedProfileRequest = { url: string; method: string; postData: string; headers: Record<string, string>; operation: string; docId: string; provenance: "observed" | "cache-rebound" };
/**
 * Everything observed on one browser page. It lives in memory, tied to the
 * page object, and is never written to disk. Navigation evidence outlives a
 * recorder; the session-bound request material is dropped when one closes.
 */
type PageObservations = {
  /** Status of each page load, by URL. */
  documents?: Map<string, ObservedDocumentResponse>;
  /** The profile's own timeline requests, by handle. */
  profileRequests?: Map<string, ObservedProfileRequest>;
  /** Full post records seen in responses, by shortcode. */
  postRecords?: Map<string, Record<string, unknown>>;
  /** Which saved operation a rebuilt profile request came from, by handle. */
  cacheBindings?: Map<string, Operation>;
  /** Handles whose saved operation failed and must not be rebuilt again. */
  reboundsDisabled?: Set<string>;
};
const seenOn = new WeakMap<object, PageObservations>();
function pageRecord(page: object): PageObservations {
  let record = seenOn.get(page);
  if (!record) seenOn.set(page, record = {});
  return record;
}

/** Media records are available only inside the observed browser session. */
export function getObservedPostRecord(page: object, shortcode: string): Record<string, unknown> | undefined {
  return seenOn.get(page)?.postRecords?.get(shortcode);
}
/** Session-bound request material stays in memory and must never be serialized. */
export function getObservedProfileRequest(page: object, handle: string, kind: "connection" | "initial" = "connection"): ObservedProfileRequest | undefined {
  const request = seenOn.get(page)?.profileRequests?.get(handle.toLowerCase() + (kind === "initial" ? ":initial" : ""));
  return request && { ...request, headers: { ...request.headers } };
}

/** Retain the failed descriptor for diagnostics, but do not reuse it or another
 * cached descriptor on this page until Instagram emits a fresh connection. */
export function invalidateCachedProfileRequest(page: object, handle: string, docId: string): boolean {
  const key = handle.toLowerCase();
  const requests = seenOn.get(page)?.profileRequests;
  const request = requests?.get(key);
  const operation = seenOn.get(page)?.cacheBindings?.get(key);
  if (!request || request.provenance !== "cache-rebound" || request.docId !== docId || !operation) return false;
  operation.cacheValidationFailedAt = new Date().toISOString();
  requests!.delete(key);
  seenOn.get(page)?.cacheBindings?.delete(key);
  const disabled = seenOn.get(page)?.reboundsDisabled ?? new Set<string>();
  disabled.add(key);
  pageRecord(page).reboundsDisabled = disabled;
  return true;
}

/** Only evidence observed for this page and this exact navigation URL. */
export function getObservedDocumentResponse(page: object, url: string): ObservedDocumentResponse | undefined {
  const evidence = seenOn.get(page)?.documents?.get(url);
  return evidence && { ...evidence };
}

const MAX_EVENTS = 2_000;
const MAX_OPERATIONS = 300;
const MAX_BODY_BYTES = 8 * 1_048_576;
/** Meta serves JSON with a JavaScript MIME type and an optional anti-XSSI prefix. */
export function parseObservedJson(source: string): unknown {
  const text = source.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, "").trim();
  try { return JSON.parse(text); }
  catch { return JSON.parse(text.split("\n").find(line => line.trim()) ?? ""); }
}
async function boundedBody<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Response body timed out")), 3_000); })]); }
  finally { clearTimeout(timer); }
}
const MAX_SHAPE_KEYS = 40;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const DOC_ID = /^\d{1,30}$/;
const SENSITIVE_KEY = /(?:cookie|auth|csrf|token|secret|password|session|caption|email|phone|challenge|signature|claim)/i;
const PAGINATION_KEY = /^(?:page_info|has_next_page|has_previous_page|end_cursor|start_cursor|next_max_id|more_available|next_page|next_cursor|has_more|paging)$/i;
const PATH_SEGMENT = /^(?:api|v\d+|graphql|query|web|feed|timeline|profile|profiles|users|user|media|posts|post|reels|reel|stories|story|comments|info|p|tv|static|ajax|data)$/;

type Operation = {
  method: string; origin: string; pathTemplate: string; queryKeys: string[];
  operation?: string; docId?: string; variablesShape?: unknown; responseShape?: unknown;
  paginationFields: string[]; statusCounts: Record<string, number>; lastSeen: string;
  timing?: { count: number; totalMs: number; minMs: number; maxMs: number };
  lastProfileValidationAt?: string;
  cacheValidationFailedAt?: string;
};
type RequestState = { page: Page; url: string; safeUrl: string; method: string; type?: string; started?: number; status?: number; retryAfter?: string; mimeType?: string; operation?: Operation };

function header(headers: Headers | undefined, name: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return typeof value === "string" ? value : undefined;
}

function retryAfter(headers?: Headers): string | undefined {
  const value = header(headers, "retry-after")?.trim();
  return value && (/^\d{1,8}$/.test(value) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d GMT$/.test(value)) ? value : undefined;
}

function mimeType(value?: string): string | undefined {
  return value && /^[a-z0-9.+-]+\/[a-z0-9.+-]{1,60}$/i.test(value) ? value : undefined;
}

function allowedUrl(raw: string, origins: Set<string>): URL | undefined {
  try {
    const url = new URL(raw);
    return origins.has(url.origin) ? url : undefined;
  } catch { return undefined; }
}

function excluded(path: string): boolean {
  return /(?:^|\/)(?:accounts|login|logout|challenge|checkpoint|two_factor|web\/accounts|api\/v1\/accounts|api\/v1\/challenge|api\/v1\/web\/accounts)(?:\/|$)/i.test(path);
}

function safePath(url: URL, handle: string): string {
  const parts = url.pathname.split("/");
  return parts.map((part, index) => {
    if (!part) return part;
    if (part === handle && index === 1) return part;
    if (index === 2 && ["p", "reel", "tv"].includes(parts[1]) && /^[\w-]{1,32}$/.test(part)) return part;
    return PATH_SEGMENT.test(part) ? part : ":id";
  }).join("/").slice(0, 240);
}

function template(url: URL): string {
  return url.pathname.split("/").map((part) =>
    PATH_SEGMENT.test(part) ? part : part ? ":id" : "",
  ).join("/").slice(0, 240);
}

function safeKeys(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter((key) => IDENTIFIER.test(key) && !SENSITIVE_KEY.test(key)))].sort().slice(0, MAX_SHAPE_KEYS);
}

function shape(value: unknown, depth = 0, budget = { remaining: 2_000 }): unknown {
  if (depth >= 10 || --budget.remaining < 0) return "object";
  if (Array.isArray(value)) return [value.length ? shape(value[0], depth + 1, budget) : "unknown"];
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(safeKeys(Object.keys(object)).map((key) => [key, shape(object[key], depth + 1, budget)]));
  }
  return value === null ? "null" : typeof value;
}

function operationInfo(url: URL, postData?: string, headers?: Headers): Pick<Operation, "operation" | "docId" | "variablesShape"> {
  const form = new URLSearchParams(postData && postData.length <= MAX_BODY_BYTES ? postData : "");
  let json: Record<string, unknown> = {};
  if (postData && postData.length <= MAX_BODY_BYTES && /^\s*\{/.test(postData)) {
    try { const parsed = JSON.parse(postData); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed; } catch { /* no usable shape */ }
  }
  const param = (key: string) => url.searchParams.get(key) ?? form.get(key) ?? (typeof json[key] === "string" ? json[key] as string : undefined);
  const friendly = param("fb_api_req_friendly_name") ?? param("operationName") ?? header(headers, "x-fb-friendly-name");
  const docId = param("doc_id");
  let variablesShape: unknown;
  const variables = json.variables ?? param("variables");
  if (typeof variables === "string" && variables.length <= 100_000) {
    try { variablesShape = shape(JSON.parse(variables)); } catch { /* malformed variables are not persisted */ }
  } else if (variables && typeof variables === "object") {
    variablesShape = shape(variables);
  }
  return {
    ...(friendly && IDENTIFIER.test(friendly) ? { operation: friendly } : {}),
    ...(docId && DOC_ID.test(docId) ? { docId } : {}),
    ...(variablesShape ? { variablesShape } : {}),
  };
}

function paginationFields(value: unknown): string[] {
  const fields = new Set<string>();
  let remaining = 2_000;
  function walk(item: unknown, depth: number): void {
    if (depth > 10 || --remaining < 0 || fields.size >= MAX_SHAPE_KEYS || !item || typeof item !== "object") return;
    if (Array.isArray(item)) { if (item.length) walk(item[0], depth + 1); return; }
    for (const [key, child] of Object.entries(item).slice(0, MAX_SHAPE_KEYS)) {
      if (PAGINATION_KEY.test(key)) fields.add(key);
      walk(child, depth + 1);
    }
  }
  walk(value, 0);
  return [...fields].sort();
}

function transportError(error?: string): string | undefined {
  const match = error?.match(/^net::(ERR_[A-Z_]{1,60})$/);
  return match ? `net::${match[1]}` : undefined;
}

function savedShape(value: unknown, depth = 0, budget = { remaining: 2_000 }): unknown {
  if (depth > 10 || --budget.remaining < 0) return undefined;
  if (typeof value === "string") return ["object", "unknown", "null", "string", "number", "boolean", "undefined"].includes(value) ? value : undefined;
  if (Array.isArray(value)) return value.length === 1 ? [savedShape(value[0], depth + 1, budget) ?? "unknown"] : undefined;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(safeKeys(Object.keys(object)).flatMap((key) => {
      const child = savedShape(object[key], depth + 1, budget);
      return child === undefined ? [] : [[key, child]];
    }));
  }
  return undefined;
}

function savedOperation(value: unknown, origins: Set<string>): Operation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<Operation>;
  if (!["GET", "POST"].includes(item.method ?? "") || !item.origin || !origins.has(item.origin) ||
    !item.pathTemplate || item.pathTemplate.length > 240 || !item.pathTemplate.startsWith("/") ||
    item.pathTemplate.split("/").some((part) => part && part !== ":id" && !PATH_SEGMENT.test(part))) return undefined;
  const statusCounts = Object.fromEntries(Object.entries(item.statusCounts ?? {}).filter(([status, count]) =>
    /^(?:[1-5]\d\d|transport_error)$/.test(status) && Number.isSafeInteger(count) && count >= 0,
  ));
  const timing = item.timing;
  const validTiming = timing && [timing.count, timing.totalMs, timing.minMs, timing.maxMs].every((n) => Number.isSafeInteger(n) && n >= 0);
  const variablesShape = savedShape(item.variablesShape);
  const responseShape = savedShape(item.responseShape);
  const savedTime = (time: unknown): time is string => typeof time === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) && !Number.isNaN(Date.parse(time));
  return {
    method: item.method!, origin: item.origin, pathTemplate: item.pathTemplate,
    queryKeys: safeKeys(Array.isArray(item.queryKeys) ? item.queryKeys : []),
    ...(item.operation && IDENTIFIER.test(item.operation) ? { operation: item.operation } : {}),
    ...(item.docId && DOC_ID.test(item.docId) ? { docId: item.docId } : {}),
    ...(variablesShape !== undefined ? { variablesShape } : {}),
    ...(responseShape !== undefined ? { responseShape } : {}),
    paginationFields: [...new Set((Array.isArray(item.paginationFields) ? item.paginationFields : []).filter((key) => typeof key === "string" && PAGINATION_KEY.test(key)))].sort().slice(0, MAX_SHAPE_KEYS),
    statusCounts, lastSeen: savedTime(item.lastSeen) ? item.lastSeen : new Date().toISOString(),
    ...(validTiming ? { timing: { count: timing.count, totalMs: timing.totalMs, minMs: timing.minMs, maxMs: timing.maxMs } } : {}),
    ...(savedTime(item.lastProfileValidationAt) ? { lastProfileValidationAt: item.lastProfileValidationAt } : {}),
    ...(savedTime(item.cacheValidationFailedAt) ? { cacheValidationFailedAt: item.cacheValidationFailedAt } : {}),
  };
}

/** A running recorder. Hold it for the length of a run and ask it what the browser saw. */
export type TrafficRecorder = {
  /** Write what has been observed so far to data/network/<handle>/ and the API map. */
  flush(): Promise<void>;
  /** Stop listening, forget session-bound request material, and flush. */
  close(): Promise<void>;
  runDir: string;
  /** How a page load ended: status, Retry-After, transport error. */
  documentResponse(page: object, url: string): ObservedDocumentResponse | undefined;
  /** The timeline request the profile page made, ready to replay with a new cursor. */
  profileRequest(page: object, handle: string, kind?: "connection" | "initial"): ObservedProfileRequest | undefined;
  /** Stop reusing a rebuilt profile request that returned a bad answer. */
  invalidateProfileRequest(page: object, handle: string, docId: string): boolean;
  /** The full record Instagram returned for one post, if the page fetched it. */
  postRecord(page: object, shortcode: string): Record<string, unknown> | undefined;
};

export async function startInstagramTraffic(
  stagehand: Stagehand,
  options: { root: string; handle: string; allowOrigins?: string[] },
): Promise<TrafficRecorder> {
  if (!/^[A-Za-z0-9._]{1,40}$/.test(options.handle) || options.handle === "." || options.handle === "..") throw new Error("Invalid Instagram handle");
  const origins = new Set((options.allowOrigins ?? ["https://www.instagram.com", "https://i.instagram.com", "https://instagram.com"])
    .map((origin) => new URL(origin).origin));
  if ([...origins].some((origin) => !/^https:\/\/(?:[a-z0-9-]+\.)*instagram\.com$/.test(origin) &&
    !(options.allowOrigins && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)))) {
    throw new Error("Traffic origins must be Instagram HTTPS or explicit loopback HTTP origins");
  }

  const root = resolve(options.root);
  const runDir = join(root, layout.networkDir(options.handle), `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`);
  const mapPath = join(root, layout.apiMap);
  const operations = new Map<string, Operation>();
  try {
    const previous = JSON.parse(await readFile(mapPath, "utf8")) as { operations?: Operation[] };
    for (const candidate of (Array.isArray(previous.operations) ? previous.operations : []).slice(0, MAX_OPERATIONS)) {
      const item = savedOperation(candidate, origins);
      if (item) {
        const key = [item.method, item.origin, item.pathTemplate, item.operation ?? "", item.docId ?? ""].join("|");
        operations.set(key, item);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const requestLines: string[] = [];
  const responseLines: string[] = [];
  const navigationLines: string[] = [];
  const sessions = new Map<Page, { session: Session; listeners: Array<[string, (event: never) => void]>; requests: Map<string, RequestState> }>();
  const pendingBodies = new Set<Promise<void>>();
  let count = 0;
  let closed = false;
  let flushQueue = Promise.resolve();

  const observe = async (page: Page): Promise<void> => {
    if (closed || sessions.has(page)) return;
    const session = page.getSessionForFrame(page.mainFrameId());
    const requests = new Map<string, RequestState>();
    const listeners: Array<[string, (event: never) => void]> = [];
    const on = <T>(name: string, listener: (event: T) => void) => {
      session.on(name, listener);
      listeners.push([name, listener as (event: never) => void]);
    };
    sessions.set(page, { session, listeners, requests });
    const evidence = seenOn.get(page)?.documents ?? new Map<string, ObservedDocumentResponse>();
    pageRecord(page).documents = evidence;
    const recordNavigation = (state: RequestState, failure?: string) => {
      if (state.type !== "Document" || (state.status === undefined && !failure)) return;
      const result: ObservedDocumentResponse = {
        ...(state.status !== undefined ? { status: state.status } : { status: 0 }),
        ...(state.retryAfter ? { retryAfter: state.retryAfter } : {}),
        ...(failure ? { transportError: failure } : {}),
      };
      evidence.set(state.url, result);
      if (evidence.size > 100) evidence.delete(evidence.keys().next().value!);
      if (navigationLines.length >= MAX_EVENTS) navigationLines.shift();
      navigationLines.push(JSON.stringify({ url: state.safeUrl, ...result }));
    };
    on<RequestEvent>("Network.requestWillBeSent", (event) => {
      const url = allowedUrl(event.request.url, origins);
      if (!url || excluded(url.pathname)) return;
      count++;
      const queryKeys = safeKeys(url.searchParams.keys());
      const safeUrl = `${url.origin}${safePath(url, options.handle)}${queryKeys.length ? `?${queryKeys.map((key) => `${encodeURIComponent(key)}=[REDACTED]`).join("&")}` : ""}`;
      const state: RequestState = { page, url: event.request.url, safeUrl, method: event.request.method, type: event.type, started: event.timestamp };
      if (count > MAX_EVENTS && event.type !== "Document" && !/(?:graphql|\/api\/)/i.test(url.pathname)) return;
      requests.set(event.requestId, state);
      if (requests.size > MAX_EVENTS) requests.delete(requests.keys().next().value!);
      const isApi = /(?:graphql|\/api\/)/i.test(url.pathname);
      const info = isApi ? operationInfo(url, event.request.postData, event.request.headers) : {};
      if (state.method === "POST" && ["/graphql/query", "/api/graphql"].includes(url.pathname.replace(/\/$/, "")) &&
        ["PolarisProfilePostsQuery", "PolarisProfilePostsTabContentQuery_connection"].includes(info.operation ?? "") && event.request.postData && event.request.postData.length <= 100_000) {
        try {
          const body = new URLSearchParams(event.request.postData);
          const variables = JSON.parse(body.get("variables") ?? "null");
          if (variables?.username?.toLowerCase() === options.handle.toLowerCase()) {
            const headers: Record<string, string> = {};
            for (const name of ["content-type", "x-fb-lsd", "x-csrftoken", "x-ig-app-id", "x-asbd-id", "x-fb-friendly-name"]) {
              const value = header(event.request.headers, name);
              if (value) headers[name] = value;
            }
            if (info.operation === "PolarisProfilePostsQuery" && info.docId) {
              const templates = seenOn.get(page)?.profileRequests ?? new Map<string, ObservedProfileRequest>();
              templates.set(options.handle.toLowerCase() + ":initial", { url: url.href, method: "POST", postData: body.toString(), headers: { ...headers }, operation: info.operation, docId: info.docId, provenance: "observed" });
              pageRecord(page).profileRequests = templates;
            }
            let provenance: ObservedProfileRequest["provenance"] = "observed";
            let usable = info.operation === "PolarisProfilePostsTabContentQuery_connection";
            let cached: Operation | undefined;
            const current = seenOn.get(page)?.profileRequests?.get(options.handle.toLowerCase());
            if (usable && current?.provenance === "cache-rebound" && current.docId === info.docId) {
              provenance = "cache-rebound";
              cached = seenOn.get(page)?.cacheBindings?.get(options.handle.toLowerCase());
            }
            if (!usable && !seenOn.get(page)?.reboundsDisabled?.has(options.handle.toLowerCase())) {
              cached = [...operations.values()].filter(op => op.operation === "PolarisProfilePostsTabContentQuery_connection" && op.origin === url.origin &&
                op.pathTemplate.replace(/\/$/, "") === url.pathname.replace(/\/$/, "") && op.docId && (op.statusCounts["200"] ?? 0) > 0 &&
                !op.cacheValidationFailedAt &&
                (op.responseShape as { data?: Record<string, unknown> } | undefined)?.data?.xdt_api__v1__feed__user_timeline_graphql_connection)
                .sort((a, b) => (b.lastProfileValidationAt ?? b.lastSeen).localeCompare(a.lastProfileValidationAt ?? a.lastSeen))[0];
              if (cached && variables.data && Number.isInteger(variables.data.count)) {
                body.set("fb_api_req_friendly_name", cached.operation!);
                body.set("doc_id", cached.docId!);
                body.set("variables", JSON.stringify({ after: null, before: null, data: variables.data, first: Math.min(24, Math.max(1, variables.data.count)), last: null, username: variables.username }));
                headers["x-fb-friendly-name"] = cached.operation!;
                provenance = "cache-rebound";
                usable = true;
              }
            }
            if (usable) {
              const templates = seenOn.get(page)?.profileRequests ?? new Map<string, ObservedProfileRequest>();
              templates.set(options.handle.toLowerCase(), { url: url.href, method: "POST", postData: body.toString(), headers, operation: body.get("fb_api_req_friendly_name")!, docId: body.get("doc_id")!, provenance });
              pageRecord(page).profileRequests = templates;
              if (cached && provenance === "cache-rebound") {
                const bindings = seenOn.get(page)?.cacheBindings ?? new Map<string, Operation>();
                bindings.set(options.handle.toLowerCase(), cached);
                pageRecord(page).cacheBindings = bindings;
              } else seenOn.get(page)?.cacheBindings?.delete(options.handle.toLowerCase());
            }
          }
        } catch { /* Unrecognized request bodies cannot seed a profile query. */ }
      }
      if (count <= MAX_EVENTS) requestLines.push(JSON.stringify({ method: "Network.requestWillBeSent", params: { requestId: event.requestId, type: event.type, request: { url: safeUrl, method: event.request.method,
        ...((info.operation || info.docId) ? { postData: JSON.stringify({ ...(info.operation ? { operationName: info.operation } : {}), ...(info.docId ? { doc_id: info.docId } : {}) }) } : {}),
      } } }));
      if (!isApi) return;
      const key = [state.method, url.origin, template(url), info.operation ?? "", info.docId ?? ""].join("|");
      let operation = operations.get(key);
      if (!operation && operations.size < MAX_OPERATIONS) {
        operation = { method: state.method, origin: url.origin, pathTemplate: template(url), queryKeys, ...info, paginationFields: [], statusCounts: {}, lastSeen: new Date().toISOString() };
        operations.set(key, operation);
      }
      if (operation) {
        operation.queryKeys = safeKeys([...operation.queryKeys, ...queryKeys]);
        if (info.variablesShape) operation.variablesShape = info.variablesShape;
        operation.lastSeen = new Date().toISOString();
        state.operation = operation;
      }
    });
    on<ResponseEvent>("Network.responseReceived", (event) => {
      const state = requests.get(event.requestId);
      if (!state) return;
      state.type = event.type ?? state.type;
      state.status = state.status ?? event.response.status;
      state.retryAfter ??= retryAfter(event.response.headers);
      state.mimeType = mimeType(event.response.mimeType);
      recordNavigation(state);
      if (count <= MAX_EVENTS && responseLines.length < MAX_EVENTS) responseLines.push(JSON.stringify({ method: "Network.responseReceived", params: { requestId: event.requestId, type: state.type, response: { url: state.safeUrl, status: state.status, mimeType: state.mimeType, headers: { ...(state.mimeType ? { "content-type": state.mimeType } : {}), ...(state.retryAfter ? { "retry-after": state.retryAfter } : {}) } } } }));
    });
    on<ExtraEvent>("Network.responseReceivedExtraInfo", (event) => {
      const state = requests.get(event.requestId);
      if (!state) return;
      state.status = event.statusCode;
      state.retryAfter = retryAfter(event.headers) ?? state.retryAfter;
      recordNavigation(state);
    });
    on<FinishEvent>("Network.loadingFinished", (event) => {
      const state = requests.get(event.requestId);
      if (!state) return;
      requests.delete(event.requestId);
      recordNavigation(state);
      if (state.operation && state.status !== undefined) {
        const op = state.operation;
        op.statusCounts[String(state.status)] = (op.statusCounts[String(state.status)] ?? 0) + 1;
        if (event.timestamp !== undefined && state.started !== undefined) {
          const elapsed = Math.max(0, Math.round((event.timestamp - state.started) * 1000));
          const old = op.timing;
          op.timing = { count: (old?.count ?? 0) + 1, totalMs: (old?.totalMs ?? 0) + elapsed, minMs: Math.min(old?.minMs ?? elapsed, elapsed), maxMs: Math.max(old?.maxMs ?? elapsed, elapsed) };
        }
        if (pendingBodies.size < 8 && /json|javascript/i.test(state.mimeType ?? "") && (event.encodedDataLength ?? MAX_BODY_BYTES + 1) <= MAX_BODY_BYTES) {
          const task = boundedBody(session.send<{ body: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId: event.requestId })).then(({ body, base64Encoded }) => {
            if ((base64Encoded ? Buffer.byteLength(body, "base64") : Buffer.byteLength(body)) > MAX_BODY_BYTES) return;
            const parsed = parseObservedJson(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
            if (/\/api\/v1\/media\/[^/]+\/info\/?$/.test(new URL(state.url).pathname) && parsed && typeof parsed === "object") {
              const items = (parsed as { items?: unknown }).items;
              if (Array.isArray(items)) {
                const records = seenOn.get(page)?.postRecords ?? new Map<string, Record<string, unknown>>();
                for (const item of items.slice(0, 20)) {
                  if (!item || typeof item !== "object" || typeof item.code !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.code)) continue;
                  const selected: Record<string, unknown> = {};
                  for (const key of ["code", "pk", "id", "media_type", "caption", "taken_at", "carousel_media_count", "carousel_media", "image_versions2", "video_versions",
                    "like_count", "comment_count", "play_count", "ig_play_count", "view_count", "video_view_count", "video_duration"]) {
                    if (key in item) selected[key] = item[key];
                  }
                  // Duration fallback only; the manifest header carries mediaPresentationDuration.
                  if (typeof item.video_dash_manifest === "string") selected.video_dash_manifest = item.video_dash_manifest.slice(0, 4_000);
                  records.set(item.code, selected);
                  if (records.size > 20) records.delete(records.keys().next().value!);
                }
                pageRecord(page).postRecords = records;
              }
            }
            op.responseShape = shape(parsed);
            op.paginationFields = [...new Set([...op.paginationFields, ...paginationFields(parsed)])].filter((key) => PAGINATION_KEY.test(key)).sort().slice(0, MAX_SHAPE_KEYS);
            if (state.status === 200 &&
              (op.responseShape as { data?: Record<string, unknown> } | undefined)?.data?.xdt_api__v1__feed__user_timeline_graphql_connection) {
              op.lastProfileValidationAt = new Date().toISOString();
            }
          }).catch(() => { /* Response bodies can be unavailable after navigation. */ }).finally(() => pendingBodies.delete(task));
          pendingBodies.add(task);
        }
      }
    });
    on<FailEvent>("Network.loadingFailed", (event) => {
      const state = requests.get(event.requestId);
      if (!state) return;
      requests.delete(event.requestId);
      recordNavigation(state, transportError(event.errorText));
      if (state.operation) state.operation.statusCounts[state.status === undefined ? "transport_error" : String(state.status)] = (state.operation.statusCounts[state.status === undefined ? "transport_error" : String(state.status)] ?? 0) + 1;
    });
    try { await session.send("Network.enable"); }
    catch (error) {
      for (const [name, listener] of listeners) session.off(name, listener);
      sessions.delete(page);
      throw error;
    }
  };

  const context = stagehand.context;
  const originalNewPage = context.newPage;
  const wrappedNewPage = async (...args: Parameters<typeof originalNewPage>) => {
    const page = await originalNewPage.apply(context, args);
    await observe(page);
    return page;
  };
  context.newPage = wrappedNewPage as typeof originalNewPage;
  try { await Promise.all(context.pages().map(observe)); }
  catch (error) { context.newPage = originalNewPage; for (const { session, listeners } of sessions.values()) for (const [name, listener] of listeners) session.off(name, listener); throw error; }

  const flush = (): Promise<void> => {
    flushQueue = flushQueue.then(async () => {
      await Promise.all(pendingBodies);
      const networkDir = join(runDir, "cdp", "network");
      await mkdir(networkDir, { recursive: true });
      await mkdir(join(root, "cache"), { recursive: true });
      for (const [name, lines] of [["requests.jsonl", requestLines], ["responses.jsonl", responseLines]] as const) {
        if (lines.length) { await appendFile(join(networkDir, name), `${lines.join("\n")}\n`, { mode: 0o600 }); lines.length = 0; }
      }
      if (navigationLines.length) await writeFile(join(runDir, "navigation.jsonl"), `${navigationLines.join("\n")}\n`, { mode: 0o600 });
      const next = `${mapPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(next, JSON.stringify({ version: 1, operations: [...operations.values()] }, null, 2), { mode: 0o600 });
      await rename(next, mapPath);
      if (count > MAX_EVENTS) await writeFile(join(runDir, "trace-summary.json"), JSON.stringify({ recordedRequests: MAX_EVENTS, observedRequests: count, truncated: true }), { mode: 0o600 });
    });
    return flushQueue;
  };
  let reportedSaveError = false;
  const saveTimer = setInterval(() => {
    void flush().catch(() => {
      if (!reportedSaveError) console.error("[network-map] Could not persist observations; collection close will report the storage error.");
      reportedSaveError = true;
    });
  }, 2_000);
  saveTimer.unref();
  const close = async (): Promise<void> => {
    if (closed) return flush();
    closed = true;
    clearInterval(saveTimer);
    if (context.newPage === wrappedNewPage) context.newPage = originalNewPage;
    for (const [page, { session, listeners }] of sessions) {
      for (const [name, listener] of listeners) session.off(name, listener);
      delete seenOn.get(page)?.profileRequests;
      delete seenOn.get(page)?.postRecords;
      delete seenOn.get(page)?.cacheBindings;
      delete seenOn.get(page)?.reboundsDisabled;
    }
    sessions.clear();
    await flush();
  };
  return {
    flush, close, runDir,
    documentResponse: getObservedDocumentResponse,
    profileRequest: getObservedProfileRequest,
    invalidateProfileRequest: invalidateCachedProfileRequest,
    postRecord: getObservedPostRecord,
  };
}
