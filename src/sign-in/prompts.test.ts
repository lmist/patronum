import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACT_CLICK_LOGIN,
  ACT_TYPE_EMAIL_CODE,
  ACT_TYPE_PASSWORD,
  ACT_TYPE_TOTP,
  ACT_TYPE_USERNAME,
  INSTAGRAM_AUTH_CACHE_DIR,
  emailCodeVariables,
  instructionContainsSecret,
  passwordVariables,
  totpVariables,
  usernameVariables,
} from "./prompts.js";
import {
  createStagehand,
  resolveAuthCacheDir,
  resolveChromeProfileDir,
} from "../browser/stagehand.js";
import { layout } from "../paths.js";
const CACHE_FROM_STAGEHAND = layout.authCache;
import { classifyPageByUrl } from "./login.js";

import { REPO_ROOT } from "../paths.js";
const root = REPO_ROOT;

describe("Stagehand optimization: prompts + cache", () => {
  it("exports workflow-scoped cache dir name", () => {
    assert.equal(INSTAGRAM_AUTH_CACHE_DIR, "cache/instagram-auth");
    assert.equal(CACHE_FROM_STAGEHAND, "cache/instagram-auth");
    assert.ok(resolveAuthCacheDir().endsWith("cache/instagram-auth"));
    assert.ok(resolveChromeProfileDir().endsWith("data/chrome-profile"));
  });

  it("createStagehand uses LOCAL env and cacheDir", () => {
    const prev = process.env.QWEN_API_KEY;
    const prevDs = process.env.DEEPSEEK_API_KEY;
    const prevMmx = process.env.MINIMAX_API_KEY;
    process.env.QWEN_API_KEY = "test-qwen-not-real";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const sh = createStagehand();
      const anySh = sh as unknown as {
        cacheDir?: string;
        opts?: { cacheDir?: string; env?: string };
        stagehandOptions?: { cacheDir?: string; env?: string };
      };
      const stagehandSrc = readFileSync(
        resolve(root, "src/browser/stagehand.ts"),
        "utf8",
      );
      assert.match(stagehandSrc, /cacheDir/);
      assert.match(stagehandSrc, /env:\s*"LOCAL"/);
      assert.match(stagehandSrc, /userDataDir|chrome-profile/);
      assert.doesNotMatch(stagehandSrc, /BROWSERBASE_API_KEY/);
      assert.doesNotMatch(stagehandSrc, /deepseek\/deepseek-v4-pro/);
      const runtime =
        anySh.cacheDir ?? anySh.opts?.cacheDir ?? anySh.stagehandOptions?.cacheDir;
      if (runtime) {
        assert.match(String(runtime), /instagram-auth/);
      }
      assert.equal(typeof sh.init, "function");
    } finally {
      if (prev === undefined) delete process.env.QWEN_API_KEY;
      else process.env.QWEN_API_KEY = prev;
      if (prevDs === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDs;
      if (prevMmx === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = prevMmx;
    }
  });

  it("credential acts use %variables% and helpers do not put secrets in instructions", () => {
    const secretUser = "unique_user_xyz_99";
    const secretPass = "unique_pass_abc_!!";
    const secretTotp = "123456";

    for (const instr of [
      ACT_TYPE_USERNAME,
      ACT_TYPE_PASSWORD,
      ACT_TYPE_TOTP,
      ACT_TYPE_EMAIL_CODE,
      ACT_CLICK_LOGIN,
    ]) {
      assert.equal(
        instructionContainsSecret(instr, secretUser),
        false,
        `instruction embeds user: ${instr}`,
      );
      assert.equal(instructionContainsSecret(instr, secretPass), false);
      assert.equal(instructionContainsSecret(instr, secretTotp), false);
    }

    assert.match(ACT_TYPE_USERNAME, /%username%/);
    assert.match(ACT_TYPE_PASSWORD, /%password%/);
    assert.match(ACT_TYPE_TOTP, /%totp_code%/);
    assert.match(ACT_TYPE_EMAIL_CODE, /%email_code%/);

    const u = usernameVariables(secretUser);
    const p = passwordVariables(secretPass);
    const t = totpVariables(secretTotp);
    const e = emailCodeVariables(secretTotp);
    assert.equal(u.variables.username, secretUser);
    assert.equal(p.variables.password, secretPass);
    assert.equal(t.variables.totp_code, secretTotp);
    assert.equal(e.variables.email_code, secretTotp);

    const loginSrc = readFileSync(
      resolve(root, "src/sign-in/login.ts"),
      "utf8",
    );
    assert.match(loginSrc, /usernameVariables|ACT_TYPE_USERNAME/);
    assert.match(loginSrc, /passwordVariables|ACT_TYPE_PASSWORD/);
    assert.match(loginSrc, /totpVariables|ACT_TYPE_TOTP/);
    assert.doesNotMatch(
      loginSrc,
      /act\(\s*`[^`]*\$\{account\.pass\}/,
    );
    assert.doesNotMatch(
      loginSrc,
      /act\(\s*`[^`]*\$\{account\.user\}/,
    );
    assert.doesNotMatch(loginSrc, /act\(\s*`[^`]*\$\{code\}/);
    assert.doesNotMatch(loginSrc, /act\(\s*`[^`]*generateTOTP/);
  });

  it("classifyPageByUrl short-circuits without LLM for known IG URLs", () => {
    assert.equal(
      classifyPageByUrl("https://www.instagram.com/accounts/login/"),
      "login",
    );
    assert.equal(
      classifyPageByUrl(
        "https://www.instagram.com/accounts/login/two_step_verification",
      ),
      "totp",
    );
    assert.equal(
      classifyPageByUrl(
        "https://www.instagram.com/auth_platform/codeentry/?next=%2F",
      ),
      "totp",
    );
    assert.equal(
      classifyPageByUrl("https://www.instagram.com/accounts/onetap/"),
      "home",
    );
    assert.equal(classifyPageByUrl("https://www.instagram.com/"), "home");
    assert.equal(
      classifyPageByUrl("https://www.instagram.com/challenge/"),
      "checkpoint",
    );
    assert.equal(classifyPageByUrl("https://www.instagram.com/explore/"), null);
  });

  it("login source uses observe for optional UI and omits pageSnapshot on hot path", () => {
    const loginSrc = readFileSync(
      resolve(root, "src/sign-in/login.ts"),
      "utf8",
    );
    assert.match(loginSrc, /\.observe\(/);
    assert.doesNotMatch(loginSrc, /pageSnapshot/);
    const sessionSrc = readFileSync(
      resolve(root, "src/sign-in/session.ts"),
      "utf8",
    );
    assert.doesNotMatch(sessionSrc, /\.extract\(/);
  });
});
