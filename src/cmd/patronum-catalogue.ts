/**
 * What the `patronum` command knows: every command, the module map, and
 * which checks cover which part of the code. Data only; patronum.ts runs it.
 *
 * Adding a command, a folder or a test area means adding a row here, and
 * `patronum commands --json`, `patronum map` and `patronum check` pick it up.
 */

export type CommandEntry = {
  name: string;
  summary: string;
  /** inspect: reads local files only. run: starts another program. */
  kind: "inspect" | "run";
  usage: string;
  examples: string[];
  /** Opens Chrome against Instagram. Only one browser may use the profile at a time. */
  opensBrowser?: boolean;
  /** Writes files, starts jobs, or changes the Instagram account. */
  changesState?: boolean;
  /**
   * AGENTS.md says collection jobs are driven from the dashboard. Commands
   * marked here are for when the user explicitly asks for direct CLI operation.
   */
  dashboardFirst?: string;
  /** For run commands: the program that does the work. `bun` means this Bun binary. */
  runs?: string[];
};

export const EXIT_CODES = {
  0: "ok",
  1: "failed; safe to retry later (includes an Instagram HTTP rejection: wait first)",
  2: "usage error; fix the command",
  3: "Instagram sign-in failed; run `patronum login`",
  4: "model unavailable; run `patronum preflight`",
} as const;

export const COMMANDS: CommandEntry[] = [
  // ——— look, don't touch ———
  {
    name: "commands", kind: "inspect",
    summary: "List every command with its usage, examples and side effects.",
    usage: "patronum commands [--json]",
    examples: ["patronum commands --json"],
  },
  {
    name: "map", kind: "inspect",
    summary: "Show what each source folder is for and which file to read first.",
    usage: "patronum map [--json]",
    examples: ["patronum map", "patronum map --json"],
  },
  {
    name: "status", kind: "inspect",
    summary: "Is this checkout ready? Where data is kept, credentials present (never printed), tools installed, saved login, job database, dashboard.",
    usage: "patronum status [--json]",
    examples: ["patronum status --json"],
  },
  {
    name: "paths", kind: "inspect",
    summary: "Where collected files live inside the home folder (PATRONUM_HOME, default ~/Documents/patronum), and which exist. Give a handle for that profile's files.",
    usage: "patronum paths [<handle>] [--json]",
    examples: ["patronum paths", "patronum paths some_handle --json"],
  },
  {
    name: "profile", kind: "inspect",
    summary: "Summarise a collected profile: post counts, how many posts are unfinished, which later stages have output.",
    usage: "patronum profile <handle> [--json]",
    examples: ["patronum profile some_handle --json"],
  },
  {
    name: "jobs", kind: "inspect",
    summary: "List collection jobs from the job database, newest first.",
    usage: "patronum jobs [--status PENDING|ENQUEUED|SUCCESS|ERROR|CANCELLED] [--handle <handle>] [--limit N] [--json]",
    examples: ["patronum jobs --status ERROR --json", "patronum jobs --handle some_handle --limit 5"],
  },
  {
    name: "job", kind: "inspect",
    summary: "Show one job: its stages, the stage it is on, and a readable error if it failed.",
    usage: "patronum job <workflow-id> [--json]",
    examples: ["patronum job ig:some_handle:1794331812 --json"],
  },
  {
    name: "skill", kind: "inspect", changesState: true,
    summary: "The guide agents follow for this command. show prints it; setup installs a short SKILL.md that points agents at it.",
    usage: "patronum skill [show | status | setup | remove] [--user] [--force] [--json]",
    examples: ["patronum skill show", "patronum skill status", "patronum skill setup", "patronum skill setup --user"],
  },
  {
    name: "check", kind: "run",
    summary: "Run the tests that cover one part of the code. With no area, list the areas.",
    usage: "patronum check [<area>...] [--json]",
    examples: ["patronum check", "patronum check collect", "patronum check types sign-in --json"],
  },

  // ——— sign in ———
  {
    name: "preflight", kind: "run",
    summary: "Ask the model one question to prove the key, model name and quota work. No browser.",
    usage: "patronum preflight",
    examples: ["patronum preflight"],
    runs: ["bun", "src/cmd/cli.ts", "preflight"],
  },
  {
    name: "session", kind: "run", opensBrowser: true,
    summary: "Open Chrome with the saved login and report whether it is still signed in.",
    usage: "patronum session [--check-only]",
    examples: ["patronum session --check-only"],
    runs: ["bun", "src/cmd/cli.ts", "session"],
  },
  {
    name: "login", kind: "run", opensBrowser: true, changesState: true,
    summary: "Sign in to Instagram with the account in .env and save the cookies.",
    usage: "patronum login [--keep-open] [--fresh-profile]",
    examples: ["patronum login", "patronum login --keep-open"],
    runs: ["bun", "src/cmd/cli.ts", "login"],
  },
  {
    name: "captcha", kind: "run",
    summary: "Inspect image-verification recognition: readiness, or recognise a saved capture.",
    usage: "patronum captcha status | recognize --observation <file> --backend local|vision",
    examples: ["patronum captcha status"],
    runs: ["bun", "src/sign-in/captcha/cli.ts"],
  },

  // ——— do the work ———
  {
    name: "dashboard", kind: "run", changesState: true,
    summary: "Build and serve the local dashboard at http://127.0.0.1:7799. This is how jobs are started, resumed and checked.",
    usage: "patronum dashboard",
    examples: ["patronum dashboard"],
    runs: ["bun", "run", "dash"],
  },
  {
    name: "collect", kind: "run", opensBrowser: true, changesState: true,
    summary: "Collect one profile into data/profiles/<handle>-profile.json.",
    usage: "patronum collect --url https://www.instagram.com/<handle> [--max N] [--skip-reels] [--no-detail] [--fresh]",
    examples: ["patronum collect --help", "patronum collect --url https://www.instagram.com/some_handle --max 30"],
    dashboardFirst: "Start a collection from the dashboard: New collection.",
    runs: ["bun", "src/cmd/scrape-profile.ts"],
  },
  {
    name: "map-api", kind: "run", opensBrowser: true, changesState: true,
    summary: "Record which Instagram routes a profile page uses, into cache/instagram-api-map.json.",
    usage: "patronum map-api --handle <handle> [--surface profile|saved]",
    examples: ["patronum map-api --handle some_handle"],
    dashboardFirst: "Dashboard: New collection → Troubleshooting → Map APIs.",
    runs: ["bun", "src/cmd/map-network.ts"],
  },
  {
    name: "saved", kind: "run", opensBrowser: true, changesState: true,
    summary: "Inspect the signed-in account's Explore recommendations; with --target, save posts to its bookmarks.",
    usage: "patronum saved --account <handle> --inspect | --target <count> | --reconcile-only",
    examples: ["patronum saved --account some_handle --inspect"],
    dashboardFirst: "--target changes the Instagram account. Use it only when the user asked for it.",
    runs: ["bun", "src/cmd/bookmark-recommendations.ts"],
  },
  {
    name: "flow", kind: "run", changesState: true,
    summary: "The durable job engine: run, resume, list, status, steps, doctor.",
    usage: "patronum flow <igflow arguments>",
    examples: ["patronum flow --help", "patronum flow doctor", "patronum flow list --status pending"],
    dashboardFirst: "Reading (list, status, steps, doctor) is fine. Start and resume jobs from the dashboard.",
    runs: ["go", "run", "./cmd/igflow"],
  },
  {
    name: "download", kind: "run", changesState: true,
    summary: "Download the media a collected profile points at, into data/media/<handle>/.",
    usage: "patronum download -in data/profiles/<handle>-profile.json -out data/media/<handle>",
    examples: ["patronum download -h"],
    dashboardFirst: "The dashboard runs this as a job stage.",
    runs: ["go", "run", "./cmd/igdl"],
  },
  {
    name: "unique", kind: "run", changesState: true,
    summary: "Keep the best copy of each image and video, into data/<handle>-unique/.",
    usage: "patronum unique -in data/profiles/<handle>-profile.json -media data/media/<handle> -out data/<handle>-unique",
    examples: ["patronum unique -h"],
    dashboardFirst: "The dashboard runs this as a job stage.",
    runs: ["go", "run", "./cmd/igunique"],
  },
  {
    name: "analyze", kind: "run", changesState: true,
    summary: "Describe each image and video with the model, into data/analysis/<handle>/.",
    usage: "patronum analyze -profile data/profiles/<handle>-profile.json -media data/media/<handle> -out data/analysis/<handle>",
    examples: ["patronum analyze -h"],
    dashboardFirst: "The dashboard runs this as a job stage.",
    runs: ["go", "run", "./cmd/iganalyze"],
  },
];

export type ModuleEntry = {
  path: string;
  /** What it is for, in one sentence. */
  purpose: string;
  /** The file to read first. */
  start: string;
  language: "TypeScript" | "Go";
};

export const MODULES: ModuleEntry[] = [
  { path: "src/sign-in", language: "TypeScript", start: "src/sign-in/login.ts",
    purpose: "Get one Instagram account logged in and prove it: password, authenticator and email codes, image verification." },
  { path: "src/collect", language: "TypeScript", start: "src/collect/collect-profile.ts",
    purpose: "Read a profile and list every post with its media. collect-profile.ts lists the steps in order." },
  { path: "src/saved", language: "TypeScript", start: "src/saved/bookmark-recommendations.ts",
    purpose: "Work with the signed-in account's own bookmarks and Explore recommendations." },
  { path: "src/api-map", language: "TypeScript", start: "src/api-map/traffic-recorder.ts",
    purpose: "Record which Instagram routes and page controls exist so collection can reuse them." },
  { path: "src/browser", language: "TypeScript", start: "src/browser/stagehand.ts",
    purpose: "Open and close local Chrome safely, keeping cookies." },
  { path: "src/llm", language: "TypeScript", start: "src/llm/preflight.ts",
    purpose: "Which model to use and whether it answers." },
  { path: "src/export", language: "TypeScript", start: "src/export/trinket.ts",
    purpose: "Copy a finished profile into an external wiki." },
  { path: "src/dashboard", language: "TypeScript", start: "src/dashboard/server.ts",
    purpose: "Local web app that starts jobs and shows results. server.ts lists the URLs; web/App.tsx is the UI." },
  { path: "src/cmd", language: "TypeScript", start: "src/cmd/patronum.ts",
    purpose: "Commands: flags, help text and exit codes. No logic of their own. Go and the dashboard start these files by path." },
  { path: "src/paths.ts", language: "TypeScript", start: "src/paths.ts",
    purpose: "Where every file the app reads or writes lives on disk." },
  { path: "cmd/igflow + internal/flow", language: "Go", start: "internal/flow/job.go",
    purpose: "Run a collection as a durable job: preflight, collect, verify, download, unique, analyze. Survives crashes." },
  { path: "cmd/igdl + internal/igdl", language: "Go", start: "internal/igdl/igdl.go",
    purpose: "Download the media a collected profile points at." },
  { path: "cmd/igunique", language: "Go", start: "cmd/igunique/main.go",
    purpose: "Keep the best copy of each image and video." },
  { path: "cmd/iganalyze", language: "Go", start: "cmd/iganalyze/main.go",
    purpose: "Describe each image and video with the model." },
  { path: "internal/videoprobe", language: "Go", start: "internal/videoprobe/videoprobe.go",
    purpose: "Does this file contain real video, and how much." },
];

export type CheckEntry = {
  area: string;
  covers: string;
  /** Each inner array is one program and its arguments. `bun` means this Bun binary. */
  commands: string[][];
};

export const CHECKS: CheckEntry[] = [
  { area: "types", covers: "TypeScript types for the app and the dashboard UI", commands: [["bun", "run", "typecheck"]] },
  { area: "sign-in", covers: "login, saved session, auth evidence, email codes, image verification", commands: [["bun", "test", "src/sign-in"]] },
  { area: "collect", covers: "profile collection steps, post reading, resume", commands: [["bun", "test", "src/collect", "src/cmd/scrape-profile.test.ts"]] },
  { area: "api-map", covers: "traffic recorder, UI map, API mapping command", commands: [["bun", "test", "src/api-map", "src/cmd/map-network.test.ts"]] },
  { area: "saved", covers: "Explore recommendations and saved-date parsing", commands: [["bun", "test", "src/saved"]] },
  { area: "browser", covers: "Chrome start-up, model wiring, cookie persistence", commands: [["bun", "test", "src/browser/stagehand.test.ts"]] },
  { area: "llm", covers: "model settings and readiness check", commands: [["bun", "test", "src/llm"]] },
  { area: "export", covers: "wiki export", commands: [["bun", "test", "src/export"]] },
  { area: "cli", covers: "the patronum and auth commands", commands: [["bun", "test", "src/cmd/cli.test.ts", "src/cmd/patronum.test.ts"]] },
  { area: "dashboard", covers: "dashboard server routes, coverage, results, a full fixture job (not the browser UI test)",
    commands: [["bun", "test", "src/dashboard/server.test.ts", "src/dashboard/coverage.test.ts", "src/dashboard/results.test.ts", "src/dashboard/durable.test.ts"]] },
  { area: "dashboard-ui", covers: "the dashboard in a real browser; needs agent-browser and a fresh build",
    commands: [["bun", "run", "dash:build"], ["bun", "test", "src/dashboard/ui.test.ts"]] },
  { area: "go", covers: "job engine, download, unique, analyze, video probing",
    commands: [["go", "test", "./cmd/...", "./internal/..."]] },
  { area: "fresh-install", covers: "what a new user sees: clones this checkout's HEAD into a temp folder and runs the quick start with no credentials",
    commands: [["bash", "scripts/fresh-install-check.sh"]] },
];
