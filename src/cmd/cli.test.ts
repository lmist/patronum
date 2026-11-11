import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { helpText } from "./cli.js";

import { REPO_ROOT } from "../paths.js";
const root = REPO_ROOT;

describe("CLI help", () => {
  it("helpText documents local Stagehand commands", () => {
    const text = helpText();
    for (const needle of [
      "login",
      "session",
      "start",
      "--fresh-profile",
      "--keep-open",
      "AGENTMAIL_ADDRESS",
      "QWEN_API_KEY",
      "Qwen",
      "IG_USER",
      "data/chrome-profile",
      "AGENTS.md",
      "patronum login",
      "patronum session --check-only",
      "local Stagehand",
    ]) {
      assert.match(text, new RegExp(needle.replace(".", "\\.")));
    }
    // multi-account / Browserbase paths are gone
    assert.doesNotMatch(text, /accounts\.json/);
    assert.doesNotMatch(text, /Browserbase contexts/);
    assert.doesNotMatch(text, /DEEPSEEK_API_KEY/);
    // the patronum command is the only name a user sees
    assert.doesNotMatch(text, /bun run|bun src\//);
  });

  it("bun src/cmd/cli.ts --help prints usage and exits 0", () => {
    const out = execFileSync("bun", ["src/cmd/cli.ts", "--help"], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.match(out, /USAGE/);
    assert.match(out, /COMMANDS/);
    assert.match(out, /local Stagehand/);
  });

  it("unknown command prints help and exits non-zero", () => {
    let code = 0;
    let combined = "";
    try {
      execFileSync("bun", ["src/cmd/cli.ts", "not-a-command"], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      code = e.status ?? 0;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.notEqual(code, 0);
    assert.match(combined, /Unknown command/);
    assert.match(combined, /USAGE/);
  });

  it("helpText documents the preflight command and exit-4 llm contract", () => {
    const text = helpText();
    assert.match(text, /preflight/);
    assert.match(text, /exit\s*4/i);
    assert.match(text, /llm/i);
  });

  it("preflight exits 4 with error:llm when QWEN_API_KEY is unset", () => {
    let code = 0;
    let combined = "";
    const env = { ...process.env, LLM_API_KEY: "", QWEN_API_KEY: "", DASHSCOPE_API_KEY: "", ALIBABA_API_KEY: "" };
    try {
      execFileSync("bun", ["src/cmd/cli.ts", "preflight"], {
        cwd: root,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      code = e.status ?? 0;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.equal(code, 4, combined);
    assert.match(combined, /"error":\s*"llm"/);
    assert.match(combined, /"kind":\s*"missing-key"/);
    const stdout = (combined.match(/\{[\s\S]*\}/) ?? [""])[0];
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.error, "llm");
    // igflow reads one stdout JSON object; pretty-print breaks that parser.
    assert.equal(stdout.includes("\n"), false, "preflight JSON must be one line");
  });

  it("all/concurrent command is rejected", () => {
    let code = 0;
    let combined = "";
    try {
      execFileSync("bun", ["src/cmd/cli.ts", "all"], {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      code = e.status ?? 0;
      combined = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.notEqual(code, 0);
    assert.match(combined, /removed|multi-account/i);
  });
});
