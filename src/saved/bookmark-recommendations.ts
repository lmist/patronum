/** Instagram's own personalized Explore feed and saved-entry GraphQL contract. */
export const EXPLORE_PATH = "/api/v1/discover/web/explore_grid/";
export const SAVED_QUERY_ID = "125097014114157517169042575661";
export const SAVE_MUTATION_ID = "11301895607778415850555732280";
export const NATIVE_APP_ID = "567067343352427";

export type Recommendation = { shortcode: string; mediaId: string };
export type SavedEntry = { shortcode: string; savedTime: number; contentUrl: string };

type Json = Record<string, unknown>;
function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

export class InstagramApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "InstagramApiError"; }
}

/** Layouts include medias, fill_items, and one_by_two_item; walk each shape. */
export function recommendationsFromExplore(body: unknown): Recommendation[] {
  const root = record(body);
  if (!root || !Array.isArray(root.sectional_items)) throw new InstagramApiError("Explore response has no sectional_items");
  const found = new Map<string, Recommendation>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 12 || !value) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const item = record(value);
    if (!item) return;
    const shortcode = item.code;
    const mediaId = item.id;
    if (typeof shortcode === "string" && /^[A-Za-z0-9_-]{5,30}$/.test(shortcode) &&
        typeof mediaId === "string" && /^\d+_\d+$/.test(mediaId)) {
      found.set(shortcode, { shortcode, mediaId });
    }
    for (const child of Object.values(item)) if (typeof child === "object") visit(child, depth + 1);
  };
  visit(root.sectional_items);
  return [...found.values()];
}

export function explorePageInfo(body: unknown): { next: string | null; more: boolean } {
  const root = record(body);
  if (!root || typeof root.more_available !== "boolean") throw new InstagramApiError("Explore pagination is missing");
  const next = root.next_max_id;
  if (root.more_available && typeof next !== "string" && typeof next !== "number") {
    throw new InstagramApiError("Explore continuation cursor is missing");
  }
  return { next: root.more_available ? String(next) : null, more: root.more_available };
}

export function savedConnection(body: unknown): { entries: SavedEntry[]; next: string | null } {
  const data = record(record(body)?.data);
  const key = data && Object.keys(data).find(name => name.includes("xfb_cross_app_saves_infinite_scroll"));
  const connection = key ? record(data?.[key]) : null;
  const edges = connection?.edges;
  const pageInfo = record(connection?.page_info);
  if (!Array.isArray(edges) || !pageInfo || typeof pageInfo.has_next_page !== "boolean") {
    throw new InstagramApiError("Saved-date response has no valid connection");
  }
  const entries: SavedEntry[] = [];
  for (const edge of edges) {
    const node = record(record(edge)?.node);
    if (!node) throw new InstagramApiError("Saved-date response contains an invalid entry");
    if (node.source_app !== "Instagram") continue;
    if (typeof node.content_url !== "string" || !Number.isInteger(node.saved_time) || Number(node.saved_time) <= 0) {
      throw new InstagramApiError("Saved-date response contains an invalid Instagram entry");
    }
    const match = /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?/.exec(node.content_url);
    if (!match) throw new InstagramApiError("Saved-date entry has no Instagram shortcode");
    entries.push({ shortcode: match[1]!, savedTime: Number(node.saved_time), contentUrl: node.content_url });
  }
  const next = pageInfo.has_next_page ? pageInfo.end_cursor : null;
  if (pageInfo.has_next_page && (typeof next !== "string" || !next)) {
    throw new InstagramApiError("Saved-date continuation cursor is missing");
  }
  return { entries, next: typeof next === "string" ? next : null };
}

export function confirmedSave(body: unknown, mediaId: string): boolean {
  const data = record(record(body)?.data);
  const key = data && Object.keys(data).find(name => name.includes("xig_media_save"));
  const media = key ? record(record(data?.[key])?.media) : null;
  const id = media?.id;
  return media?.has_viewer_saved === true &&
    typeof id === "string" && (id === mediaId || id === mediaId.split("_")[0]);
}

export type InstagramSession = { cookies: Array<{ name: string; value: string; domain: string }>; userAgent: string; account: string };

export class BookmarkApi {
  private readonly cookies: string;
  private readonly sessionId: string;
  private readonly userId: string;
  private readonly csrf: string;
  private readonly secretValues: string[];
  constructor(private readonly session: InstagramSession) {
    const relevant = session.cookies.filter(cookie => cookie.domain.endsWith("instagram.com"));
    const byName = new Map(relevant.map(cookie => [cookie.name, cookie.value]));
    this.sessionId = byName.get("sessionid") ?? "";
    this.userId = byName.get("ds_user_id") ?? "";
    this.csrf = byName.get("csrftoken") ?? "";
    if (!this.sessionId || !this.userId) throw new InstagramApiError("Authenticated Instagram session cookies are missing");
    this.cookies = relevant.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
    this.secretValues = relevant.map(cookie => cookie.value).filter(value => value.length >= 4);
  }

  private async request(url: string, init: RequestInit): Promise<Json> {
    let response: Response;
    try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: "manual" }); }
    catch (error) { throw new InstagramApiError(`Instagram transport failed: ${String(error)}`); }
    const body = await response.json().catch(() => null);
    const data = record(body);
    if (!response.ok || !data || response.status >= 300 || data.status === "fail" || data.error_type ||
        Array.isArray(data.errors) && data.errors.length > 0) {
      const firstError = Array.isArray(data?.errors) ? record(data.errors[0]) : null;
      let reason = String(firstError?.message ?? data?.message ?? data?.error_type ?? "unexpected response").slice(0, 180);
      for (const value of this.secretValues) reason = reason.split(value).join("[redacted]");
      reason = reason.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
      const code = firstError?.code == null ? "" : ` [code ${String(firstError.code).slice(0, 20)}]`;
      throw new InstagramApiError(`Instagram rejected request (${response.status}): ${reason}${code}`, response.status);
    }
    return data;
  }

  async explore(maxId: string | null): Promise<Json> {
    const url = new URL(EXPLORE_PATH, "https://www.instagram.com");
    for (const [key, value] of Object.entries({
      include_fixed_destinations: "true", is_nonpersonalized_explore: "false", is_prefetch: "false",
      module: "explore_popular", omit_cover_media: "false",
    })) url.searchParams.set(key, value);
    if (maxId !== null) url.searchParams.set("max_id", maxId);
    return this.request(url.toString(), { headers: {
      "Cookie": this.cookies, "User-Agent": this.session.userAgent,
      "X-IG-App-ID": "936619743392459", "X-CSRFToken": this.csrf,
      "X-Requested-With": "XMLHttpRequest", "Accept": "*/*",
    } });
  }

  private async graphql(name: string, docId: string, variables: Json): Promise<Json> {
    const auth = Buffer.from(JSON.stringify({
      ds_user_id: this.userId, sessionid: this.sessionId, should_use_header_over_cookies: true,
    })).toString("base64");
    const body = new URLSearchParams({
      method: "post", pretty: "false", format: "json", server_timestamps: "true", locale: "user", purpose: "fetch",
      fb_api_req_friendly_name: name, client_doc_id: docId,
      enable_canonical_naming: "true", enable_canonical_variable_overrides: "true",
      enable_canonical_naming_ambiguous_type_prefixing: "true", variables: JSON.stringify(variables),
    });
    return this.request("https://b.i.instagram.com/graphql_www", { method: "POST", headers: {
      "Cookie": this.cookies, "User-Agent": "Instagram 449.0.0.52.84 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 1079242191)",
      "X-IG-App-ID": NATIVE_APP_ID, "X-IG-Capabilities": "3brTv10=", "Accept-Language": "en-US", "Accept": "*/*",
      "Authorization": `Bearer IGT:2:${auth}`, "IG-INTENDED-USER-ID": this.userId,
      "X-FB-Friendly-Name": name, "X-Client-Doc-Id": docId,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }, body });
  }

  async savedDates(maxPages = 100, wanted?: ReadonlySet<string>): Promise<Map<string, SavedEntry>> {
    const entries = new Map<string, SavedEntry>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.graphql("IGCrossAppSavesQuery", SAVED_QUERY_ID,
        { after: cursor, first: 30, filters: null, entrypoint: "IGD" });
      const connection = savedConnection(body);
      for (const entry of connection.entries) entries.set(entry.shortcode, entry);
      if (wanted && [...wanted].every(shortcode => entries.has(shortcode))) return entries;
      if (!connection.next) return entries;
      if (cursors.has(connection.next)) throw new InstagramApiError("Saved-date pagination repeated a cursor");
      cursors.add(connection.next);
      cursor = connection.next;
    }
    throw new InstagramApiError(`Saved-date pagination exceeded ${maxPages} pages`);
  }

  async save(mediaId: string): Promise<void> {
    const body = await this.graphql("IGMediaSaveMutation", SAVE_MUTATION_ID, { data: { media_id: mediaId } });
    if (!confirmedSave(body, mediaId)) throw new InstagramApiError("Save mutation did not confirm this media as saved");
  }
}
