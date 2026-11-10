import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createStagehand } from "../../browser/stagehand.js";
import { observeCheckpoint } from "./capture.js";

test("capture timeout never invokes a screenshot after an unresolved frame probe", async () => {
  let screenshots = 0;
  const page = {
    getFullFrameTree: () => ({ frame: { id: "root", url: "https://example.com" } }),
    frameForId: () => ({ evaluate: () => new Promise(() => {}) }),
    screenshot: async () => { screenshots++; return Buffer.alloc(0); },
  } as unknown as Parameters<typeof observeCheckpoint>[0];
  expect(await observeCheckpoint(page, { timeoutMs: 10 })).toMatchObject({ status: "unavailable", reason: "capture-timeout" });
  expect(screenshots).toBe(0);
});

test("capture skips pages without a visible image grid", async () => {
  let screenshots = 0;
  const page = {
    getFullFrameTree: () => ({ frame: { id: "root", url: "https://example.com" } }),
    frameForId: () => ({ evaluate: async () => null }),
    screenshot: async () => { screenshots++; return Buffer.alloc(0); },
  } as unknown as Parameters<typeof observeCheckpoint>[0];
  expect(await observeCheckpoint(page)).toMatchObject({ status: "unavailable", reason: "no-image-grid" });
  expect(screenshots).toBe(0);
});

test.skipIf(process.env.PATRONUM_CAPTCHA_BROWSER_TEST !== "1")("captures a visible nested-frame grid and replacement without clicking", async () => {
  const root = await mkdtemp(resolve("data/captcha/browser-fixture-"));
  const oldKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY ||= "browser-fixture-no-model-calls";
  let clicks = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/click") { clicks++; return new Response("ok"); }
    const origin = `http://127.0.0.1:${server.port}`;
    if (path === "/") return new Response(`<iframe style="width:600px;height:600px;border:2px solid" src="${origin}/redirect"></iframe>`, { headers: { "Content-Type": "text/html" } });
    if (path === "/redirect") return Response.redirect(`${origin}/wrapper`);
    if (path === "/wrapper") return new Response(`<iframe style="width:500px;height:500px;border:3px solid" src="http://localhost:${server.port}/grid"></iframe>`, { headers: { "Content-Type": "text/html" } });
    return new Response(`<style>td{padding:0;width:100px;height:100px}table{border-collapse:collapse}img{display:block;width:100px;height:100px}</style><div class="rc-imageselect-desc-wrapper">Select all images with <strong>buses</strong></div><table class="rc-imageselect-table-33">${Array.from({ length: 3 }, (_, row) => `<tr>${Array.from({ length: 3 }, (_, col) => `<td><img src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='${row === 0 && col === 0 ? "red" : "blue"}'/></svg>`)}"></td>`).join("")}</tr>`).join("")}</table><button onclick="fetch('/click')">Verify</button><script>document.querySelectorAll('td').forEach(e=>e.onclick=()=>fetch('/click'))</script>`, { headers: { "Content-Type": "text/html" } });
  } });
  const stagehand = createStagehand({ userDataDir: `${root}/profile`, cacheDir: `${root}/cache`, headless: true });
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    let capture = await observeCheckpoint(page);
    for (let i = 0; i < 10 && capture.status !== "captured"; i++) { await Bun.sleep(200); capture = await observeCheckpoint(page); }
    expect(capture.status).toBe("captured");
    expect(capture.observation?.gridSize).toBe(3);
    expect(capture.observation?.target).toBe("buses");
    const pixel = await page.evaluate(async (base64: string) => {
      const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
      return { width: img.width, height: img.height, pixel: [...context.getImageData(50, 50, 1, 1).data] };
    }, capture.observation!.image.dataBase64);
    expect(pixel).toEqual({ width: 300, height: 300, pixel: [255, 0, 0, 255] });
    for (const frame of page.frames()) {
      await frame.evaluate(() => {
        const image = document.querySelector("td img") as HTMLImageElement | null;
        if (image) image.src = image.src.replace("red", "green");
      });
    }
    await Bun.sleep(100);
    const replacement = await observeCheckpoint(page, { round: 1, previous: { observation: capture.observation!, fingerprints: capture.fingerprints! } });
    expect(replacement.observation?.kind).toBe("replacement");
    expect(replacement.observation?.changedIndices).toEqual([0]);
    expect(clicks).toBe(0);
  } finally {
    await stagehand.close(); server.stop(true);
    if (oldKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = oldKey;
  }
}, 30_000);

test.skipIf(process.env.PATRONUM_CAPTCHA_BROWSER_TEST !== "1")("recovers an existing cross-site iframe on attachment and rejects its hidden grid", async () => {
  const { default: puppeteer } = await import("puppeteer-core");
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const { refreshCheckpointFrames } = await import("./frames.js");
  const server = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch(request): Response {
    const path = new URL(request.url).pathname;
    const headers = { "Content-Type": "text/html" };
    if (path === "/") return new Response(`<iframe width="500" height="500" src="http://localhost:${server.port}/grid"></iframe>`, { headers });
    return new Response(`<style>table{border-collapse:collapse}td{padding:0}img{display:block;width:80px;height:80px}</style><div class="rc-imageselect-desc-wrapper"><strong>motorcycles</strong></div><table class="rc-imageselect-table-44">${Array.from({ length: 4 }, () => `<tr>${Array.from({ length: 4 }, () => `<td><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='red'/%3E%3C/svg%3E"></td>`).join("")}</tr>`).join("")}</table>`, { headers });
  } });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--site-per-process"], defaultViewport: { width: 1280, height: 800 } });
  let attached: InstanceType<typeof Stagehand> | undefined;
  try {
    const original = (await browser.pages())[0]!;
    await original.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle0" });
    attached = new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl: browser.wsEndpoint() }, verbose: 0, disablePino: true });
    await attached.init();
    const page = attached.context.pages()[0]!;
    await refreshCheckpointFrames(page);
    const capture = await observeCheckpoint(page);
    expect(capture.status).toBe("captured");
    expect(capture.observation?.gridSize).toBe(4);
    expect(capture.observation?.target).toBe("motorcycles");
    // A locally visible table inside an offscreen challenge must not be read.
    await original.evaluate(() => { const frame = document.querySelector("iframe")!; frame.style.position = "absolute"; frame.style.top = "-9999px"; });
    expect(await observeCheckpoint(page)).toMatchObject({ status: "unavailable", reason: "no-image-grid" });
  } finally {
    await attached?.close();
    await browser.close();
    server.stop(true);
  }
}, 30_000);
