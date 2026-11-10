import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../paths.js";
import { CHECKS, COMMANDS, MODULES } from "./patronum-catalogue.js";
import { LOGO } from "./patronum-logo.js";
import { overview, parseFlags, suggest } from "./patronum.js";

const CLI = join(REPO_ROOT, "src/cmd/patronum.ts");

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

describe("patronum catalogue", () => {
  it("names every command once and gives each a usage line and an example", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(command.usage.startsWith(`patronum ${command.name}`)).toBe(true);
      expect(command.examples.length).toBeGreaterThan(0);
      expect(command.summary.length).toBeGreaterThan(10);
    }
  });

  it("points run commands at programs that exist", () => {
    for (const command of COMMANDS.filter((candidate) => candidate.runs)) {
      const [program, ...rest] = command.runs!;
      const target = program === "bun" ? rest.find((part) => part.endsWith(".ts")) : rest.find((part) => part.startsWith("./"));
      if (target) expect(existsSync(join(REPO_ROOT, target))).toBe(true);
    }
  });

  it("maps only folders and start files that exist", () => {
    for (const module of MODULES) {
      for (const path of module.path.split(" + ")) expect(existsSync(join(REPO_ROOT, path))).toBe(true);
      expect(existsSync(join(REPO_ROOT, module.start))).toBe(true);
    }
  });

  it("maps every source folder", () => {
    const mapped = new Set(MODULES.flatMap((module) => module.path.split(" + ")));
    for (const folder of ["sign-in", "collect", "saved", "api-map", "browser", "llm", "export", "dashboard", "cmd"]) {
      expect(mapped.has(`src/${folder}`)).toBe(true);
    }
  });

  it("checks only test paths that exist", () => {
    for (const check of CHECKS) {
      for (const argv of check.commands) {
        for (const part of argv.filter((value) => value.startsWith("src/"))) expect(existsSync(join(REPO_ROOT, part))).toBe(true);
      }
    }
  });
});

describe("patronum command line", () => {
  it("opens the overview with the logo and keeps it out of JSON output", async () => {
    expect(overview().startsWith(LOGO.split("\n")[0]!)).toBe(true);
    expect(overview()).toContain("patronum");
    const json = await run("commands", "--json");
    expect(json.stdout).not.toContain("█");
  });

  it("lists every command in the overview", () => {
    const text = overview();
    for (const command of COMMANDS) expect(text).toContain(`  ${command.name}`);
  });

  it("separates flags, values and positional arguments", () => {
    expect(parseFlags(["some_handle", "--json"])).toMatchObject({ json: true, rest: ["some_handle"] });
    expect(parseFlags(["--status", "ERROR", "--limit=3"], ["status", "limit"]).values).toEqual({ status: "ERROR", limit: "3" });
    expect(() => parseFlags(["--nope"])).toThrow("unknown option --nope");
    expect(() => parseFlags(["--limit"], ["limit"])).toThrow("--limit needs a value");
  });

  it("suggests the nearest command for a typo", () => {
    expect(suggest("colect")).toContain("collect");
    expect(suggest("stat")).toContain("status");
    expect(suggest("zzzzzz")).toEqual([]);
  });

  it("prints one JSON document for commands --json", async () => {
    const result = await run("commands", "--json");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.commands.map((command: { name: string }) => command.name)).toEqual(COMMANDS.map((command) => command.name));
    expect(parsed.exitCodes["3"]).toContain("sign-in");
  });

  it("exits 2 with a JSON error and a suggestion for an unknown command", async () => {
    const result = await run("colect", "--json");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: "usage", hint: "did you mean: collect?" });
  });

  it("rejects a handle that is a URL", async () => {
    const result = await run("profile", "https://www.instagram.com/x", "--json");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).message).toContain("not a valid Instagram handle");
  });

  it("reports credentials by presence only", async () => {
    const result = await run("status", "--json");
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    for (const value of Object.values(parsed.credentials)) expect(typeof value).toBe("boolean");
    for (const secret of [process.env.IG_PASS, process.env.QWEN_API_KEY].filter((value): value is string => !!value && value.length > 5)) {
      expect(result.stdout).not.toContain(secret);
    }
  });

  it("passes a run command's help and exit code through", async () => {
    const result = await run("collect", "--help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("scrape-profile");
  });
});
