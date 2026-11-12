/**
 * patronum — the one command for this repository.
 *
 *   patronum commands --json   everything it can do, machine-readable
 *   patronum map               what each folder is for
 *   patronum status --json     is this checkout ready
 *
 * Inspect commands read local files only and print one JSON document with
 * --json. Run commands hand over to the existing entry points and pass their
 * output and exit code straight through. The list lives in
 * patronum-catalogue.ts.
 *
 * Exit codes: 0 ok · 1 failed · 2 usage · 3 sign-in · 4 model.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { DATA_HOME, HOME_ENV, REPO_ROOT, defaultDataHome, inHome, inRepo, layout } from "../paths.js";
import { API_KEY_NAMES } from "../llm/qwen.js";
import { needsDetailEnrichment } from "../collect/resume.js";
import { CHECKS, COMMANDS, EXIT_CODES, MODULES, type CommandEntry } from "./patronum-catalogue.js";
import { logoWith } from "./patronum-logo.js";
import { installSkill, removeSkill, skillGuide, skillStatus, type SkillScope } from "./patronum-skill.js";

const HANDLE = /^[A-Za-z0-9._]{1,40}$/;
const JOB_STATUSES = ["PENDING", "ENQUEUED", "SUCCESS", "ERROR", "CANCELLED"];
const DASHBOARD_URL = `http://127.0.0.1:${process.env.IGDASH_PORT ?? 7799}`;

class UsageError extends Error {
  constructor(message: string, readonly hint?: string) { super(message); }
}

type Flags = { json: boolean; help: boolean; user: boolean; force: boolean; values: Record<string, string>; rest: string[] };

/** Split inspect-command arguments into --json, --help, --name value pairs and the rest. */
export function parseFlags(argv: string[], valued: string[] = []): Flags {
  const flags: Flags = { json: false, help: false, user: false, force: false, values: {}, rest: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--json") flags.json = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--user") flags.user = true;
    else if (arg === "--force") flags.force = true;
    else if (arg.startsWith("--") && valued.includes(arg.slice(2).split("=")[0]!)) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const value = inline ?? argv[++index];
      if (value == null) throw new UsageError(`--${name} needs a value`);
      flags.values[name] = value;
    } else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else flags.rest.push(arg);
  }
  return flags;
}

/** The closest command names to a mistyped one. */
export function suggest(name: string, names: string[] = COMMANDS.map((command) => command.name)): string[] {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length]!;
  };
  return names
    .map((candidate) => ({ candidate, score: candidate.startsWith(name) || name.startsWith(candidate) ? 0 : distance(name, candidate) }))
    .filter(({ score }) => score <= 2)
    .sort((a, b) => a.score - b.score)
    .map(({ candidate }) => candidate)
    .slice(0, 3);
}

function print(flags: { json: boolean }, data: unknown, text: () => string): void {
  console.log(flags.json ? JSON.stringify(data, null, 2) : text());
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

function commandHelp(command: CommandEntry): string {
  const lines = [`patronum ${command.name} — ${command.summary}`, "", `Usage: ${command.usage}`, "", "Examples:", ...command.examples.map((example) => `  ${example}`)];
  lines.push("", `Side effects: ${sideEffects(command)}`);
  if (command.dashboardFirst) lines.push(`Dashboard first: ${command.dashboardFirst}`);
  if (command.runs) lines.push(`Runs: ${command.runs.join(" ")}`);
  return lines.join("\n");
}

export function overview(): string {
  const section = (title: string, kind: CommandEntry["kind"]) => [title, table(COMMANDS.filter((command) => command.kind === kind).map((command) => [`  ${command.name}`, command.summary]))];
  return [
    logoWith(["patronum", "collect an Instagram profile,", "download its media, and analyze it."]),
    "",
    "Usage: patronum <command> [options]     (also: bun run patronum -- <command>)",
    "",
    ...section("Look (reads local files only; add --json for one JSON document):", "inspect"),
    "",
    ...section("Do (hands over to the real program; output and exit code pass through):", "run"),
    "",
    "Start here:  patronum status      then  patronum map",
    "Everything:  patronum commands --json",
    "One command: patronum <command> --help",
    "",
    `Exit codes: ${Object.entries(EXIT_CODES).map(([code, meaning]) => `${code} ${meaning.split(";")[0]}`).join(" · ")}`,
    "Jobs are started and resumed from the dashboard (patronum dashboard); see AGENTS.md.",
  ].join("\n");
}

// ——— inspect commands ———

function sideEffects(command: CommandEntry): string {
  const effects = [command.opensBrowser && "runs Chrome (hidden unless HEADLESS=false)", command.changesState && "changes files or account state"].filter(Boolean);
  return effects.length ? effects.join("; ") : "none";
}

/** Every command with its usage, an example and its side effects. The overview is `patronum --help`. */
export function commandList(): string {
  const entry = (command: CommandEntry) => [
    `${command.name} — ${command.summary}`,
    `  Usage:        ${command.usage}`,
    `  Example:      ${command.examples[0]}`,
    `  Side effects: ${sideEffects(command)}`,
    ...(command.dashboardFirst ? [`  Dashboard:    ${command.dashboardFirst}`] : []),
  ].join("\n");
  const section = (title: string, kind: CommandEntry["kind"]) => [title, "", COMMANDS.filter((command) => command.kind === kind).map(entry).join("\n\n")];
  return [
    ...section("LOOK (reads local files only; add --json for one JSON document)", "inspect"),
    "",
    ...section("DO (hands over to the real program; output and exit code pass through)", "run"),
    "",
    `Exit codes: ${Object.entries(EXIT_CODES).map(([code, meaning]) => `${code} ${meaning.split(";")[0]}`).join(" · ")}`,
    "Short overview: patronum --help     Machine-readable: patronum commands --json",
  ].join("\n");
}

function showCommands(flags: Flags): void {
  print(flags, { ok: true, exitCodes: EXIT_CODES, commands: COMMANDS }, commandList);
}

function showMap(flags: Flags): void {
  print(flags, { ok: true, modules: MODULES }, () => [
    table([["WHERE", "WHAT IT IS FOR"], ...MODULES.map((module) => [module.path, module.purpose])]),
    "",
    "Read first:",
    table(MODULES.map((module) => [`  ${module.path}`, module.start])),
  ].join("\n"));
}

function onPath(program: string): boolean {
  return Bun.which(program) != null;
}

async function dashboardHealth(): Promise<{ running: boolean; url: string }> {
  try {
    const response = await fetch(`${DASHBOARD_URL}/api/health`, { signal: AbortSignal.timeout(700) });
    return { running: response.ok, url: DASHBOARD_URL };
  } catch {
    return { running: false, url: DASHBOARD_URL };
  }
}

async function showStatus(flags: Flags): Promise<void> {
  const present = (...names: string[]) => names.some((name) => !!process.env[name]?.trim());
  const credentials = {
    model: present(...API_KEY_NAMES),
    instagramUser: present("IG_USER"),
    instagramPassword: present("IG_PASS"),
    authenticatorSecret: present("IG_TOTP_SECRET"),
    emailCodes: present("AGENTMAIL_API_KEY") && present("AGENTMAIL_ADDRESS"),
  };
  const tools = { bun: Bun.version, go: onPath("go"), ffmpeg: onPath("ffmpeg"), ffprobe: onPath("ffprobe"), bd: existsSync(inRepo("bin/bd")) };
  const chromeProfile = inHome(process.env.PATRONUM_CHROME_PROFILE_DIR || layout.chromeProfile);
  const files = {
    envFile: existsSync(inRepo(".env")),
    savedLogin: existsSync(chromeProfile),
    jobDatabase: existsSync(process.env.IGDASH_DB ?? inHome(layout.jobsDb)),
    dashboardBuild: existsSync(inRepo("src/dashboard/dist/index.html")),
    dependencies: existsSync(inRepo("node_modules")),
  };
  const dashboard = await dashboardHealth();
  const next: string[] = [];
  if (!files.dependencies) next.push("bun install");
  if (!credentials.model) next.push("set LLM_API_KEY, LLM_BASE_URL and LLM_MODEL in .env (or QWEN_API_KEY for the Qwen Token Plan), then: patronum preflight");
  if (!credentials.instagramUser || !credentials.instagramPassword) next.push("set IG_USER and IG_PASS in .env");
  if (!files.savedLogin && credentials.instagramUser) next.push("patronum login");
  if (!tools.go || !tools.ffmpeg || !tools.ffprobe) next.push("install go, ffmpeg and ffprobe for the media stages");
  if (!dashboard.running) next.push("patronum dashboard");
  const ready = credentials.model && credentials.instagramUser && credentials.instagramPassword && files.dependencies;
  const home = {
    path: DATA_HOME,
    exists: existsSync(DATA_HOME),
    source: process.env[HOME_ENV]?.trim() ? HOME_ENV : "default",
    default: defaultDataHome(),
    // A checkout from before the home existed keeps its data inside the repository.
    dataLeftInRepository: DATA_HOME !== REPO_ROOT && existsSync(inRepo("data/profiles")),
  };
  if (home.dataLeftInRepository) next.push(`data from before the home folder is still in ${REPO_ROOT}/data; move data/ and cache/ into ${DATA_HOME}, or set ${HOME_ENV}=${REPO_ROOT}`);
  print(flags, { ok: true, ready, root: REPO_ROOT, home, credentials, tools, files, dashboard, next }, () => {
    const mark = (value: unknown) => (value ? "yes" : "no ");
    return [
      `Repository  ${REPO_ROOT}`,
      `Home        ${home.path}  (${home.source === "default" ? `default; set ${HOME_ENV} to change` : `from ${HOME_ENV}`}${home.exists ? "" : "; not created yet"})`,
      `Ready       ${ready ? "yes" : "no"}`,
      "",
      "Credentials (presence only)",
      ...Object.entries(credentials).map(([name, value]) => `  ${mark(value)} ${name}`),
      "Tools",
      ...Object.entries(tools).map(([name, value]) => `  ${mark(value)} ${name}${typeof value === "string" ? ` ${value}` : ""}${name === "bd" ? "  (issue tracker; only for working on the code)" : ""}`),
      "Files",
      ...Object.entries(files).map(([name, value]) => `  ${mark(value)} ${name}`),
      `Dashboard   ${dashboard.running ? `running at ${dashboard.url}` : "not running"}`,
      ...(next.length ? ["", "Next:", ...next.map((step) => `  ${step}`)] : []),
    ].join("\n");
  });
}

function requireHandle(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError("a handle is required", usage);
  if (!HANDLE.test(value)) throw new UsageError(`"${value}" is not a valid Instagram handle`, "letters, digits, dots and underscores only; no @ and no URL");
  return value;
}

function showPaths(flags: Flags): void {
  const handle = flags.rest[0] ? requireHandle(flags.rest[0], "patronum paths [<handle>]") : undefined;
  const entry = (path: string) => ({ path, absolute: inHome(path), exists: existsSync(inHome(path)) });
  const shared = {
    chromeProfile: entry(process.env.PATRONUM_CHROME_PROFILE_DIR || layout.chromeProfile), authCache: entry(layout.authCache), uiMap: entry(layout.uiMap), apiMap: entry(layout.apiMap),
    profilesDir: entry(layout.profilesDir), jobsDb: entry(layout.jobsDb), jobLogs: entry(layout.jobLogs),
    captchaCaptures: entry(layout.captchaCaptures), bookmarksDir: entry(layout.bookmarksDir),
  };
  const forHandle = handle && {
    profileJson: entry(layout.profileJson(handle)), networkDir: entry(layout.networkDir(handle)),
    mediaDir: entry(layout.mediaDir(handle)), mediaManifest: entry(layout.mediaManifest(handle)),
    uniqueDir: entry(layout.uniqueDir(handle)), uniqueManifest: entry(layout.uniqueManifest(handle)),
    analysisDir: entry(layout.analysisDir(handle)), analysisJson: entry(layout.analysisJson(handle)),
    knowledgeDir: entry(layout.knowledgeDir(handle)), bookmarkProgress: entry(layout.bookmarkProgress(handle)),
  };
  print(flags, { ok: true, home: DATA_HOME, shared, ...(forHandle ? { handle, profile: forHandle } : {}) }, () => {
    const rows = (group: Record<string, { absolute: string; exists: boolean }>) => Object.entries(group).map(([name, value]) => [`  ${name}`, value.exists ? "exists " : "missing", value.absolute]);
    return [`Home: ${DATA_HOME}`, "", "Shared", table(rows(shared)), ...(forHandle ? ["", `Profile ${handle}`, table(rows(forHandle))] : ["", "Add a handle for one profile's files: patronum paths <handle>"])].join("\n");
  });
}

function showProfile(flags: Flags): void {
  const handle = requireHandle(flags.rest[0], "patronum profile <handle>");
  const path = layout.profileJson(handle);
  if (!existsSync(inHome(path))) {
    print(flags, { ok: false, error: "not_collected", handle, path, hint: "Start a collection from the dashboard: patronum dashboard" },
      () => `No collected profile for ${handle} (${path} is missing).\nStart a collection from the dashboard: patronum dashboard`);
    process.exitCode = 1;
    return;
  }
  const profile = JSON.parse(readFileSync(inHome(path), "utf8")) as Record<string, any>;
  const posts: any[] = Array.isArray(profile.posts) ? profile.posts : [];
  const reels: any[] = Array.isArray(profile.reels) ? profile.reels : [];
  const unfinished = [...posts, ...reels].filter((item) => needsDetailEnrichment(item)).map((item) => item.shortcode).filter(Boolean);
  const stages = {
    collected: true,
    downloaded: existsSync(inHome(layout.mediaManifest(handle))),
    unique: existsSync(inHome(layout.uniqueManifest(handle))),
    analyzed: existsSync(inHome(layout.analysisJson(handle))),
  };
  const summary = {
    ok: true, handle, path, absolutePath: inHome(path),
    username: profile.username ?? null, scrapedAt: profile.scrapedAt ?? null, partial: profile.partial === true,
    counts: { posts: posts.length, reels: reels.length, profilePosts: profile.counts?.posts ?? null, followers: profile.counts?.followers ?? null },
    unfinished: { count: unfinished.length, shortcodes: unfinished.slice(0, 20) },
    notes: Array.isArray(profile.notes) ? profile.notes.length : 0,
    stages,
  };
  print(flags, summary, () => [
    `${summary.username ?? handle}  (${inHome(path)})`,
    `Collected   ${summary.scrapedAt ?? "unknown"}${summary.partial ? "  PARTIAL" : ""}`,
    `Posts       ${posts.length} posts, ${reels.length} reels (profile says ${summary.counts.profilePosts ?? "?"})`,
    `Unfinished  ${unfinished.length}${unfinished.length ? `: ${unfinished.slice(0, 8).join(", ")}${unfinished.length > 8 ? ", …" : ""}` : ""}`,
    `Stages      ${Object.entries(stages).map(([name, done]) => `${name} ${done ? "yes" : "no"}`).join(" · ")}`,
  ].join("\n"));
}

async function openJobs() {
  // The dashboard's server files sit outside the root typecheck, so this is loaded by path.
  const jobStore = "../dashboard/job-store";
  const store = await import(jobStore);
  const db = store.openDb();
  return { store, db };
}

async function showJobs(flags: Flags): Promise<void> {
  const limit = flags.values.limit == null ? 20 : Number(flags.values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a whole number of 1 or more");
  if (flags.values.handle) requireHandle(flags.values.handle, "patronum jobs --handle <handle>");
  if (flags.values.status != null) {
    const status = flags.values.status.toUpperCase();
    if (!JOB_STATUSES.includes(status)) throw new UsageError(`unknown job status "${flags.values.status}"`, `use one of: ${JOB_STATUSES.join(", ")}`);
    flags.values.status = status;
  }
  const { store, db } = await openJobs();
  if (!db) {
    print(flags, { ok: true, jobs: [], note: "no job database yet; no job has run in this checkout" }, () => "No job database yet; no job has run in this checkout.");
    return;
  }
  try {
    const jobs = store.listWorkflows(db, { status: flags.values.status, handle: flags.values.handle, limit, parentsOnly: true })
      .map((job: any) => ({ id: job.id, handle: job.handle, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt }));
    print(flags, { ok: true, jobs }, () => jobs.length
      ? table([["ID", "HANDLE", "STATUS", "CREATED"], ...jobs.map((job: any) => [job.id, job.handle || "-", job.status, job.createdAt ? new Date(Number(job.createdAt)).toISOString() : "-"])])
      : "No matching jobs.");
  } finally { db.close(); }
}

async function showJob(flags: Flags): Promise<void> {
  const id = flags.rest[0];
  if (!id) throw new UsageError("a workflow id is required", "list ids with: patronum jobs");
  const { store, db } = await openJobs();
  const notFound = (hint: string, text: string) => {
    print(flags, { ok: false, error: "not_found", id, hint }, () => text);
    process.exitCode = 1;
  };
  if (!db) return notFound("no job has run in this checkout; start one from the dashboard: patronum dashboard", `No job with id ${id}: no job has run in this checkout yet.\nStart one from the dashboard: patronum dashboard`);
  try {
    const job = store.getWorkflow(db, id);
    if (!job) return notFound("patronum jobs", `No job with id ${id}. List ids with: patronum jobs`);
    const steps = store.getSteps(db, id);
    const events = store.getEvents(db, id) as Record<string, unknown>;
    const childSteps = steps.flatMap((step: any) => step.childWorkflowId ? store.getSteps(db, step.childWorkflowId) : []);
    const derived = store.deriveStages([...steps, ...childSteps], events as any, job.status);
    const error = store.displayErrorText(events, steps, job);
    // Knowledge is retired: show it only for an old job that actually ran it.
    const stages = (Object.values(derived.stages) as any[])
      .filter((stage) => stage.name !== "knowledge" || stage.state !== "idle")
      .map((stage) => ({ name: stage.name, state: stage.state }));
    print(flags, { ok: true, job: { id: job.id, handle: job.handle, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt }, currentStage: derived.currentStage, stages, error, logs: `${layout.jobLogs}/${id}` },
      () => [`${job.id}  ${job.status}  ${job.handle || ""}`, `Stage  ${derived.currentStage ?? "-"}`, table(stages.map((stage) => [`  ${stage.name}`, stage.state])), ...(error ? ["", `Error: ${error}`] : []), `Logs   ${layout.jobLogs}/${id}`].join("\n"));
  } finally { db.close(); }
}

function showSkill(flags: Flags): void {
  const [action = "status"] = flags.rest;
  const scopes: SkillScope[] = flags.user ? ["user"] : ["project"];
  if (action === "show") {
    print(flags, { ok: true, guide: skillGuide() }, skillGuide);
    return;
  }
  if (action === "setup" || action === "remove") {
    const results = scopes.map((scope) => (action === "setup" ? installSkill(scope, flags.force) : removeSkill(scope)));
    const blocked = results.filter((result) => result.state === "foreign");
    print(flags, { ok: blocked.length === 0, action, results }, () => results.map((result) =>
      result.state === "foreign"
        ? `left alone  ${result.path}\n            it was not written by patronum${action === "setup" ? "; add --force to replace it" : ""}`
        : `${action === "setup" ? "installed " : "removed   "}  ${result.path}`).join("\n"));
    if (blocked.length) process.exitCode = 1;
    return;
  }
  if (action !== "status") throw new UsageError(`unknown skill action "${action}"`, "use: patronum skill show | status | setup | remove");
  const installs = skillStatus();
  print(flags, { ok: true, installs }, () => [
    table([["WHERE", "STATE", "PATH"], ...installs.map((install) => [install.scope, install.state, install.path])]),
    "",
    "show    print the guide          setup   install the stub (--user for ~/.claude)          remove  take it away",
  ].join("\n"));
}

// ——— run commands ———

function program(argv: string[]): string[] {
  return argv[0] === "bun" ? [process.execPath, ...argv.slice(1)] : argv;
}

async function hand(command: CommandEntry, args: string[]): Promise<number> {
  const askingForHelp = args.some((arg) => arg === "--help" || arg === "-h");
  if (command.dashboardFirst && !askingForHelp) console.error(`[patronum] ${command.name}: ${command.dashboardFirst} Direct use is for when the user asked for it.`);
  const child = Bun.spawn([...program(command.runs!), ...args], { cwd: REPO_ROOT, stdio: ["inherit", "inherit", "inherit"] });
  return child.exited;
}

async function runChecks(flags: Flags): Promise<number> {
  if (!flags.rest.length) {
    print(flags, { ok: true, areas: CHECKS }, () => ["Areas (run with: patronum check <area>...)", table(CHECKS.map((check) => [`  ${check.area}`, check.covers]))].join("\n"));
    return 0;
  }
  const chosen = flags.rest.map((area) => {
    const check = CHECKS.find((candidate) => candidate.area === area);
    if (!check) throw new UsageError(`unknown check area "${area}"`, `areas: ${CHECKS.map((candidate) => candidate.area).join(", ")}`);
    return check;
  });
  const results: Array<{ area: string; command: string; ok: boolean; exitCode: number; seconds: number }> = [];
  for (const check of chosen) {
    for (const argv of check.commands) {
      const started = Date.now();
      // With --json the test output goes to stderr so stdout stays one JSON document.
      const child = Bun.spawn(program(argv), { cwd: REPO_ROOT, stdio: ["ignore", flags.json ? 2 : "inherit", "inherit"] });
      const exitCode = await child.exited;
      results.push({ area: check.area, command: argv.join(" "), ok: exitCode === 0, exitCode, seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
  }
  const ok = results.every((result) => result.ok);
  print(flags, { ok, results }, () => ["", table([["AREA", "RESULT", "SECONDS", "COMMAND"], ...results.map((result) => [result.area, result.ok ? "pass" : `FAIL (${result.exitCode})`, String(result.seconds), result.command])])].join("\n"));
  return ok ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const topic = name === "help" ? COMMANDS.find((command) => command.name === args[0]) : undefined;
    console.log(topic ? commandHelp(topic) : overview());
    return 0;
  }
  const wantsJson = args.includes("--json");
  try {
    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (!command) {
      const close = suggest(name);
      throw new UsageError(`unknown command "${name}"`, close.length ? `did you mean: ${close.join(", ")}?` : "list commands with: patronum commands");
    }
    if (command.runs) {
      // Real programs own their flags, including --help.
      return await hand(command, args);
    }
    const valued = name === "jobs" ? ["status", "handle", "limit"] : [];
    const flags = parseFlags(args, valued);
    if (flags.help) { console.log(commandHelp(command)); return 0; }
    switch (name) {
      case "commands": showCommands(flags); break;
      case "map": showMap(flags); break;
      case "status": await showStatus(flags); break;
      case "paths": showPaths(flags); break;
      case "profile": showProfile(flags); break;
      case "jobs": await showJobs(flags); break;
      case "job": await showJob(flags); break;
      case "skill": showSkill(flags); break;
      case "check": return await runChecks(flags);
    }
    return Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (wantsJson) console.log(JSON.stringify({ ok: false, error: "usage", message: error.message, hint: error.hint ?? null }, null, 2));
    else console.error(`patronum: ${error.message}${error.hint ? `\n${error.hint}` : ""}\nHelp: patronum --help`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
