import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStagehand } from "../browser/stagehand.js";
import { enterCodeOnce } from "./code-entry.js";

// A stand-in for Instagram's two-factor page: one Code input, a Continue
// button that is disabled while the field is empty, and a server that
// accepts a code once and refuses anything else.
const PAGE = `<!doctype html><title>Instagram</title>
<h1>Go to your authentication app</h1>
<label>Code <input type="text" id="code" value="504284"></label>
<p id="error" hidden>Please check the security code and try again.</p>
<div role="button" id="go" aria-disabled="false">Continue</div>
<div role="button">Try another way</div>
<script>
  const input = document.getElementById("code"), go = document.getElementById("go");
  input.addEventListener("input", () => go.setAttribute("aria-disabled", String(input.value === "")));
  go.addEventListener("click", async () => {
    const response = await fetch("/verify?code=" + encodeURIComponent(input.value));
    if (response.ok) location.href = "/home"; else document.getElementById("error").hidden = false;
  });
</script>`;

test("a code replaces what is in the field, is submitted once, and a refusal is reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patronum-code-entry-"));
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY ||= "local-fixture-only";
  const submitted: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/verify") {
      const code = url.searchParams.get("code") ?? "";
      const reused = submitted.includes(code);
      submitted.push(code);
      return new Response("", { status: code === "222222" && !reused ? 200 : 403 });
    }
    return new Response(url.pathname === "/home" ? "<title>Home</title><p>Signed in</p>" : PAGE, { headers: { "content-type": "text/html" } });
  } });
  const stagehand = createStagehand({ userDataDir: join(dir, "profile"), cacheDir: join(dir, "cache"), headless: true });
  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${server.port}/accounts/login/two_step_verification`);

    // The field already holds an earlier code. A wrong code is refused, and the refusal is seen.
    expect(await enterCodeOnce(stagehand, "111111", 4_000)).toBe("rejected");
    expect(submitted).toEqual(["111111"]);

    // With the refusal still on screen, the next code goes in alone and the page moves on.
    expect(await enterCodeOnce(stagehand, "222222", 6_000)).toBe("advanced");
    expect(submitted).toEqual(["111111", "222222"]);
    expect(new URL(page.url()).pathname).toBe("/home");

    // No code input on this page.
    expect(await enterCodeOnce(stagehand, "333333", 1_000)).toBe("no-field");
    expect(submitted).toHaveLength(2);
  } finally {
    await stagehand.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.QWEN_API_KEY; else process.env.QWEN_API_KEY = previousKey;
  }
}, 90_000);
