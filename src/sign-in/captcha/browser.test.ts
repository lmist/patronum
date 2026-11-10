import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createStagehand } from "../../browser/stagehand.js";
import { createChallengeDriver } from "./browser.js";
import { solveChallenge } from "./solver.js";

test.skipIf(process.env.PATRONUM_CAPTCHA_BROWSER_TEST !== "1")("opens and completes a nested browser challenge with replacement tiles", async () => {
  const root = await mkdtemp(resolve("data/captcha/solver-fixture-"));
  let submitted = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/submitted") { submitted++; return new Response("ok"); }
    const origin = `http://127.0.0.1:${server.port}`;
    const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
    if (path === "/") return html(`<iframe style="width:600px;height:600px" src="${origin}/wrapper"></iframe>`);
    if (path === "/wrapper") return html(`<iframe style="width:500px;height:500px" src="http://localhost:${server.port}/challenge"></iframe>`);
    return html(`<style>td{padding:0;width:100px;height:100px}table{border-collapse:collapse}img{display:block;width:100px;height:100px}</style>
<button id="recaptcha-anchor" aria-checked="false" onclick="document.querySelector('#challenge').style.display='block'">I'm not a robot</button>
<div id="challenge" style="display:none"><div class="rc-imageselect-desc-wrapper">Select all images with <strong>buses</strong>. Click verify once there are none left.</div>
<table class="rc-imageselect-table-33">${Array.from({ length: 3 }, (_, row) => `<tr>${Array.from({ length: 3 }, (_, col) => `<td><img src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='${row === 0 && col === 0 ? "red" : "blue"}'/></svg>`)}"></td>`).join("")}</tr>`).join("")}</table>
<button id="recaptcha-verify-button" onclick="if(document.querySelector('td img').src.includes('green')){fetch('/submitted');document.querySelector('#challenge').style.display='none';document.querySelector('#recaptcha-anchor').setAttribute('aria-checked','true')}">Verify</button></div>
<script>document.querySelector('td').onclick=()=>{setTimeout(()=>{const img=document.querySelector('td img');img.src=img.src.replace('red','green')},100)}</script>`);
  } });
  const stagehand = createStagehand({ userDataDir: `${root}/profile`, cacheDir: `${root}/cache`, headless: true });
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    let calls = 0;
    const result = await solveChallenge(createChallengeDriver(page), { name: "fixture", async recognize() { return { selectedIndices: calls++ === 0 ? [0] : [], confidence: 1 }; } }, { timeoutMs: 20_000 });
    expect(result).toMatchObject({ status: "solved", rounds: 2 });
    expect(submitted).toBe(1);
  } finally { await stagehand.close(); server.stop(true); }
}, 30_000);

test("recognizes Instagram advancing from CAPTCHA to email code entry", async () => {
  let url = "https://www.instagram.com/auth_platform/recaptcha/";
  const driver = createChallengeDriver({ url: () => url } as Parameters<typeof createChallengeDriver>[0]);
  url = "https://www.instagram.com/auth_platform/codeentry/";
  expect(await driver.inspect(1)).toEqual({ kind: "solved" });
});

test.skipIf(process.env.PATRONUM_CAPTCHA_BROWSER_TEST !== "1")("routes codeentry email-named code field to email verification", async () => {
  const { classifyPage } = await import("../login.js");
  const root = await mkdtemp(resolve("data/captcha/email-fixture-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response('<h1>Check your email</h1><p>Enter the code we sent</p><label>Code<input name="email" type="text"></label><button>Get a new code</button><button>Continue</button>', { headers: { "Content-Type": "text/html" } }) });
  const stagehand = createStagehand({ userDataDir: `${root}/profile`, cacheDir: `${root}/cache`, headless: true });
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${server.port}/auth_platform/codeentry/`, { waitUntil: "load" });
    expect(await classifyPage(stagehand, page.url())).toBe("checkpoint");
  } finally { await stagehand.close(); server.stop(true); }
}, 30_000);
