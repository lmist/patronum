import { expect, test } from "bun:test";
import { CdpConnection, CdpTab, isTabLostError } from "./cdp-detail.js";

/** In-memory CDP peer: answers commands through `reply`, can push events. */
function fakeSocket(reply: (message: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }) => unknown) {
  const handlers: Record<string, Array<(event: { data: unknown }) => void>> = {};
  const emit = (type: string, data?: unknown) => { for (const fn of handlers[type] ?? []) fn({ data }); };
  const sent: Array<{ method: string; sessionId?: string; params: Record<string, unknown> }> = [];
  const socket = {
    readyState: 1,
    send(raw: string) {
      const message = JSON.parse(raw);
      sent.push(message);
      queueMicrotask(() => {
        const result = reply(message);
        if (result instanceof Error) emit("message", JSON.stringify({ id: message.id, error: { code: -32001, message: result.message } }));
        else if (result !== undefined) emit("message", JSON.stringify({ id: message.id, result }));
      });
    },
    close() { emit("close"); },
    addEventListener(type: string, fn: (event: { data: unknown }) => void) { (handlers[type] ??= []).push(fn); },
  };
  queueMicrotask(() => emit("open"));
  return { socket, sent, event: (method: string, params: unknown, sessionId?: string) => emit("message", JSON.stringify({ method, params, sessionId })) };
}

test("CDP tab tracks redirects and document status, and fails fast once closed", async () => {
  const fake = fakeSocket((message) => {
    if (message.method === "Target.createTarget") return { targetId: "T1" };
    if (message.method === "Target.attachToTarget") return { sessionId: "S1" };
    if (message.method === "Runtime.evaluate") return { result: { value: { href: "https://www.instagram.com/reels/CLIP/" } } };
    return {};
  });
  const conn = await CdpConnection.connect("ws://fake", 1_000, () => fake.socket as never);
  const tab = await CdpTab.open(conn);
  expect(fake.sent.filter((m) => m.sessionId === "S1").map((m) => m.method)).toEqual(["Page.enable", "Network.enable"]);

  fake.event("Page.frameNavigated", { frame: { id: "T1", url: "https://www.instagram.com/reels/CLIP/" } }, "S1");
  fake.event("Page.frameNavigated", { frame: { id: "F2", parentId: "T1", url: "https://ads.test/" } }, "S1");
  fake.event("Network.responseReceived", { type: "Document", response: { url: "https://www.instagram.com/reel/CLIP/", status: 429, headers: { "Retry-After": "60" } } }, "S1");
  fake.event("Page.frameNavigated", { frame: { id: "T9", url: "https://other.test/" } }, "S9");
  expect(tab.url()).toBe("https://www.instagram.com/reels/CLIP/");
  expect(tab.documentResponse("https://www.instagram.com/reel/CLIP/")).toEqual({ status: 429, retryAfter: "60" });
  expect(await tab.evaluate<{ href: string }>("({ href: location.href })")).toEqual({ href: "https://www.instagram.com/reels/CLIP/" });

  await tab.close();
  expect(fake.sent.at(-1)?.method).toBe("Target.closeTarget");
  const lost = await tab.sendCDP("Page.navigate", { url: "https://www.instagram.com/p/NEXT/" }).catch((error) => error);
  expect(isTabLostError(lost)).toBe(true);
  conn.close();
  const after = await conn.send("Target.getTargets").catch((error) => error);
  expect(isTabLostError(after)).toBe(true);
});

test("a detached target marks its tab closed and protocol errors keep their code", async () => {
  const fake = fakeSocket((message) => {
    if (message.method === "Target.createTarget") return { targetId: "T1" };
    if (message.method === "Target.attachToTarget") return { sessionId: "S1" };
    if (message.method === "Runtime.evaluate") return new Error("Session with given id not found.");
    return {};
  });
  const conn = await CdpConnection.connect("ws://fake", 1_000, () => fake.socket as never);
  const tab = await CdpTab.open(conn);
  const failed = await tab.evaluate("1").catch((error) => error);
  expect(String(failed)).toMatch(/-32001 Session with given id not found/);
  fake.event("Target.detachedFromTarget", { sessionId: "S1", targetId: "T1" });
  expect(isTabLostError(await tab.sendCDP("Page.enable").catch((error) => error))).toBe(true);
  conn.close();
});
