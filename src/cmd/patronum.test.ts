import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../paths.js";
import { CHECKS, COMMANDS, MODULES } from "./patronum-catalogue.js";
import { LOGO } from "./patronum-logo.js";
import { commandList, overview, parseFlags, suggest } from "./patronum.js";
import { skillGuide, skillStatus, skillStub, skillTarget } from "./patronum-skill.js";

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

describe("patronum skill", () => {
  it("only names commands that exist", () => {
    const names = new Set(COMMANDS.map((command) => command.name));
    const mentioned = [...skillGuide().matchAll(/\.\/bin\/patronum ([a-z][a-z-]*)/g)].map((match) => match[1]!);
    expect(mentioned.length).toBeGreaterThan(8);
    for (const name of mentioned) expect(names.has(name)).toBe(true);
  });

  it("keeps the checked-in SKILL.md equal to the stub the command writes", () => {
    const { path, command } = skillTarget("project");
    expect(readFileSync(path, "utf8")).toBe(skillStub(command));
    expect(skillStub(command)).toContain("./bin/patronum skill show");
    expect(skillStatus().find((install) => install.scope === "project")?.state).toBe("current");
  });

  it("prints the guide and reports where the stub is installed", async () => {
    const shown = await run("skill", "show");
    expect(shown.stdout).toContain("Jobs go through the server");
    const status = JSON.parse((await run("skill", "status", "--json")).stdout);
    expect(status.installs.map((install: { scope: string }) => install.scope)).toEqual(["project", "user"]);
    expect((await run("skill", "nope", "--json")).exitCode).toBe(2);
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

  it("lists every command with its usage, an example and its side effects", async () => {
    const result = await run("commands");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd()).toBe(commandList());
    expect(commandList()).not.toBe(overview());
    for (const command of COMMANDS) {
      expect(commandList()).toContain(`  Usage:        ${command.usage}`);
      expect(commandList()).toContain(`  Example:      ${command.examples[0]}`);
    }
    expect(commandList().match(/Side effects:/g)?.length).toBe(COMMANDS.length);
  });

  it("starts, resumes and cancels jobs as a client of the server", async () => {
    // A port nothing listens on, and a home with no job database: no server is contacted or started.
    const env = { ...process.env, IGDASH_PORT: "9", PATRONUM_HOME: join(REPO_ROOT, "src/dashboard/.test-no-such-home") };
    const cli = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    };
    const parsed = parseFlags(["some_handle", "--max", "5", "--analyze", "--wait"], ["max"], ["analyze", "wait", "skip-reels"]);
    expect(parsed.rest).toEqual(["some_handle"]);
    expect(parsed.values.max).toBe("5");
    expect(parsed.on).toEqual({ analyze: true, wait: true });

    const badHandle = await cli("run", "https://www.instagram.com/some_handle");
    expect(badHandle.exitCode).toBe(2);
    expect(badHandle.stderr).toContain("not a valid Instagram handle");
    const badLimit = await cli("run", "some_handle", "--max", "0", "--json");
    expect(badLimit.exitCode).toBe(2);
    expect(JSON.parse(badLimit.stdout).message).toContain("Post limit");
    expect((await cli("resume", "not-a-job-id")).exitCode).toBe(2);

    // A well-formed id with no such job is refused before any request is sent.
    const missing = await cli("resume", "ig:some_handle:1794331812", "--json");
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, error: "not_applicable", status: null });
    expect((await cli("cancel", "ig:some_handle:1794331812")).exitCode).toBe(1);

    const status = await cli("server", "status", "--json");
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, running: false, url: "http://127.0.0.1:9" });
    expect((await cli("server", "sideways")).exitCode).toBe(2);
  });

  it("builds the same request as the dashboard's New collection form", async () => {
    const { runRequest } = await import("./patronum-jobs.js");
    const download = await runRequest({ handle: "some_handle", analyze: false, skipReels: false, showBrowser: false, forceLogin: false, allFrames: false });
    expect(download.body).toMatchObject({ handle: "some_handle", max: 30, "skip-analyze": true, "skip-llm-preflight": true, "skip-reels": false, "show-browser": false, "detail-workers": 2, "dl-workers": 4, timeout: "30m" });
    const analyze = await runRequest({ handle: "some_handle", max: "5", analyze: true, skipReels: true, showBrowser: true, forceLogin: false, allFrames: true });
    expect(analyze.body).toMatchObject({ max: 5, "skip-analyze": false, "skip-llm-preflight": false, "skip-reels": true, "show-browser": true, "all-frames": true });
    expect((await runRequest({ handle: "some_handle", max: "0", analyze: false, skipReels: false, showBrowser: false, forceLogin: false, allFrames: false })).body).toBeUndefined();
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
    expect(result.stdout).toContain("patronum collect --url");
  });
});
