/** Lean CDP detail tabs for the scraper.
 *
 * Detail pages only need reliable navigation plus a DOM/JSON read of the
 * embedded exact-shortcode post record. This module opens its own WebSocket to
 * the Chrome that Stagehand launched (same profile, same cookies) and drives
 * dedicated tabs with raw CDP: one `Page.navigate`, then one atomic
 * `Runtime.evaluate` per poll. It never routes through Stagehand's page/session
 * bookkeeping, so a closed or crashed tab fails fast instead of surfacing later
 * as `-32001 Session with given id not found` on an unrelated post.
 *
 * Each tab satisfies the scraper's `DetailPage` shape (goto/url/evaluate/
 * sendCDP/close), so the existing DOM fallback runs unchanged on it.
 */

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };
type Socket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
  addEventListener(type: "open", fn: () => void): void;
  readyState: number;
};

export class CdpProtocolError extends Error {
  constructor(readonly method: string, readonly code: number | null, message: string) {
    super(`${code !== null ? `${code} ` : ""}${message}`);
    this.name = "CdpProtocolError";
  }
}

/** True when the tab/session behind a call no longer exists. */
export function isTabLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /-32001|Session with given id not found|No target with given id|Target closed|CDP connection closed|detail tab closed/i.test(message);
}

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closedReason: string | null = null;

  private constructor(private readonly socket: Socket) {
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
    socket.addEventListener("close", () => this.fail("CDP connection closed"));
    socket.addEventListener("error", () => this.fail("CDP connection closed (socket error)"));
  }

  static async connect(wsUrl: string, timeoutMs = 10_000, createSocket?: (url: string) => Socket): Promise<CdpConnection> {
    const socket = createSocket ? createSocket(wsUrl) : (new WebSocket(wsUrl) as unknown as Socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out after ${timeoutMs}ms`)), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP connect failed")); });
    });
    return new CdpConnection(socket);
  }

  get closed(): boolean { return this.closedReason !== null; }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closedReason) return Promise.reject(new CdpProtocolError(method, null, this.closedReason));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpProtocolError(method, null, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.fail("CDP connection closed");
    try { this.socket.close(); } catch { /* already closed */ }
  }

  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new CdpProtocolError("", message.error.code ?? null, message.error.message ?? "CDP error"));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
      for (const listener of this.listeners) listener(event);
    }
  }

  private fail(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpProtocolError("", null, reason));
      this.pending.delete(id);
    }
  }
}

export type DocumentResponse = { status: number; retryAfter: string | null };

/** One dedicated tab driven over raw CDP. */
export class CdpTab {
  private href = "about:blank";
  private closed = false;
  private readonly documents = new Map<string, DocumentResponse>();
  private readonly unsubscribe: () => void;

  private constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
    private readonly evaluateTimeoutMs: number,
  ) {
    this.unsubscribe = conn.on((event) => this.onEvent(event));
  }

  static async open(conn: CdpConnection, opts: { evaluateTimeoutMs?: number } = {}): Promise<CdpTab> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    let sessionId: string;
    try {
      ({ sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    } catch (error) {
      await conn.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
    const tab = new CdpTab(conn, targetId, sessionId, opts.evaluateTimeoutMs ?? 15_000);
    try {
      await tab.sendCDP("Page.enable");
      await tab.sendCDP("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    } catch (error) {
      await tab.close();
      throw error;
    }
    return tab;
  }

  url(): string { return this.href; }

  /** HTTP status of the main document most recently received for `url`. */
  documentResponse(url: string): DocumentResponse | undefined {
    return this.documents.get(url) ?? this.documents.get(url.replace(/\/$/, "")) ?? undefined;
  }

  sendCDP<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new CdpProtocolError(method, -32001, "detail tab closed"));
    return this.conn.send<T>(method, params, this.sessionId, timeoutMs);
  }

  async evaluate<R = unknown>(fn: string | (() => R)): Promise<R> {
    const expression = typeof fn === "string" ? fn : `(${fn.toString()})()`;
    const reply = await this.sendCDP<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.evaluateTimeoutMs,
    );
    if (reply.exceptionDetails) {
      throw new Error(`evaluate failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "exception"}`.slice(0, 500));
    }
    return reply.result?.value as R;
  }

  /** Fallback only; the scraper navigates with Page.navigate and semantic waits. */
  async goto(url: string, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const loaded = new Promise<void>((resolve) => {
      const off = this.conn.on((event) => {
        if (event.sessionId === this.sessionId && event.method === "Page.domContentEventFired") { off(); resolve(); }
      });
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    const commit = await this.sendCDP<{ errorText?: string }>("Page.navigate", { url }, timeoutMs);
    if (commit?.errorText) throw new Error(`navigation failed: ${commit.errorText}`);
    await loaded;
    return commit;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.conn.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5_000).catch(() => {});
  }

  private onEvent(event: CdpEvent): void {
    if (event.method === "Target.detachedFromTarget" && event.params.sessionId === this.sessionId) {
      this.closed = true;
      this.unsubscribe();
      return;
    }
    if (event.sessionId !== this.sessionId) return;
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame as { id?: string; parentId?: string; url?: string } | undefined;
      if (frame && !frame.parentId && typeof frame.url === "string") this.href = frame.url;
    } else if (event.method === "Page.navigatedWithinDocument") {
      if (event.params.frameId === this.targetId && typeof event.params.url === "string") this.href = event.params.url;
    } else if (event.method === "Network.responseReceived" && event.params.type === "Document") {
      const response = event.params.response as { url?: string; status?: number; headers?: Record<string, string> } | undefined;
      if (!response?.url || typeof response.status !== "number") return;
      const headers = response.headers ?? {};
      const retryAfter = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1] ?? null;
      this.documents.set(response.url, { status: response.status, retryAfter });
    }
  }
}

/** Owns one CDP connection and the detail tabs opened on it. */
export class CdpDetailBrowser {
  private conn: CdpConnection | null = null;
  private connecting: Promise<CdpConnection> | null = null;
  private readonly tabs = new Set<CdpTab>();

  constructor(private readonly wsUrl: () => string) {}

  async newTab(): Promise<CdpTab> {
    const conn = await this.connection();
    const tab = await CdpTab.open(conn);
    this.tabs.add(tab);
    return tab;
  }

  async close(): Promise<void> {
    await Promise.all([...this.tabs].map((tab) => tab.close().catch(() => {})));
    this.tabs.clear();
    this.conn?.close();
    this.conn = null;
  }

  private async connection(): Promise<CdpConnection> {
    if (this.conn && !this.conn.closed) return this.conn;
    this.connecting ??= CdpConnection.connect(this.wsUrl()).finally(() => { this.connecting = null; });
    this.conn = await this.connecting;
    return this.conn;
  }
}
