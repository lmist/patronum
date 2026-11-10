import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "./stagehand.js";

test.skipIf(process.env.PATRONUM_LOGIN_BROWSER_TEST !== "1")("persists a newly issued cookie across browser shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "patronum-cookie-"));
  const options = { userDataDir: join(root, "profile"), cacheDir: join(root, "cache"), headless: true };
  let browser = createStagehand(options);
  try {
    await browser.init();
    await browser.context.addCookies([{
      name: "session_fixture", value: "fixture", domain: "example.test", path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true,
    }]);
    expect((await browser.context.cookies()).some(cookie => cookie.name === "session_fixture")).toBe(true);
    await browser.close();
    browser = createStagehand(options);
    await browser.init();
    expect((await browser.context.cookies()).some(cookie => cookie.name === "session_fixture")).toBe(true);
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
