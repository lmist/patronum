#!/usr/bin/env bun
/**
 * Docs / resolver lint hook for Patronum.
 *
 * Smart "is a lint due?" logic:
 *  - Track PostToolUse edits to code the resolver table covers (and package.json / CLI).
 *  - Track edits to AGENTS.md / HUMANS.md.
 *  - Lint is DUE when resolver-relevant code changed and docs were not updated
 *    at or after that change (same session).
 *  - On UserPromptSubmit: inject additionalContext with the lint prompt (when due).
 *  - On Stop: surface the same prompt (and Claude-style block reason when due).
 *
 * stdin: agent harness hook event JSON (Claude / Cursor / compatible)
 * stdout: optional JSON envelope (additionalContext / decision)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(SCRIPT_DIR, "docs-resolver-lint.prompt.md");

const root =
  process.env.CLAUDE_PROJECT_DIR ||
  process.env.CURSOR_PROJECT_DIR ||
  process.env.AGENT_WORKSPACE_ROOT ||
  process.cwd();

const sessionId =
  process.env.CLAUDE_SESSION_ID ||
  process.env.CURSOR_SESSION_ID ||
  process.env.SESSION_ID ||
  "default";

const stateDir = join(root, ".agents", "state");
const statePath = join(stateDir, `docs-lint-${sessionId}.json`);

/** Paths always treated as docs (case-insensitive basename match). */
const DOC_BASENAMES = new Set([
  "agents.md",
  "humans.md",
  "claude.md",
  "agent.md",
]);

/** Paths that are noise for lint-due (never alone force a lint). */
const NOISE_RE =
  /(^|[\\/])(node_modules|dist|cache|data|\.git|\.agents[\\/]state|bun\.lock|package-lock\.json)([\\/]|$)/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function loadState() {
  if (!existsSync(statePath)) {
    return {
      codeHits: [],
      docHits: [],
      lastCodeAt: null,
      lastDocAt: null,
      clearedAt: null,
    };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {
      codeHits: [],
      docHits: [],
      lastCodeAt: null,
      lastDocAt: null,
      clearedAt: null,
    };
  }
}

function saveState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function loadPrompt() {
  try {
    return readFileSync(PROMPT_PATH, "utf8").trim();
  } catch {
    return "Lint AGENTS.md, HUMANS.md, and all paths in the AGENTS.md resolver table.";
  }
}

/** Parse backtick paths and Path column cells from AGENTS.md resolver table. */
function resolverPathsFromAgents() {
  const agentsPath = join(root, "AGENTS.md");
  if (!existsSync(agentsPath)) return new Set();
  const text = readFileSync(agentsPath, "utf8");
  const paths = new Set();

  // Backtick paths like `src/cmd/cli.ts`
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const p = m[1].trim();
    if (
      p.startsWith("src/") ||
      p.endsWith(".ts") ||
      p.endsWith(".js") ||
      p.endsWith(".json") ||
      p.startsWith("cache/") ||
      p === "accounts.json" ||
      p.startsWith("data/")
    ) {
      // Drop trailing punctuation and globs of pure text
      const clean = p.replace(/[,;.]+$/, "");
      if (!clean.includes(" ")) paths.add(clean.replace(/\/$/, ""));
    }
  }

  // Table rows: | intent | `path` or path | notes |
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    const pathCell = cells[2] ?? "";
    const tick = pathCell.match(/`([^`]+)`/);
    const raw = (tick?.[1] ?? pathCell).trim();
    if (
      raw &&
      !/^path$/i.test(raw) &&
      !raw.startsWith("---") &&
      (raw.includes("/") || raw.endsWith(".ts") || raw.endsWith(".json"))
    ) {
      paths.add(raw.replace(/\/$/, "").split(/\s+/)[0]);
    }
  }

  // Always watch package scripts + CLI surface
  paths.add("package.json");
  paths.add("src/cmd/cli.ts");
  paths.add("src/cmd/cli.test.ts");

  return paths;
}

function normalizeRepoPath(p) {
  if (!p || typeof p !== "string") return null;
  let s = p.trim().replace(/^file:\/\//, "");
  // Drop Windows drive noise if any
  if (s.startsWith(root)) {
    s = relative(root, s);
  }
  s = s.replace(/\\/g, "/");
  // Un-absolute if under cwd
  if (s.startsWith("./")) s = s.slice(2);
  // Ignore absolute paths outside repo
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) {
    try {
      const rel = relative(root, s);
      if (rel.startsWith("..")) return null;
      s = rel.replace(/\\/g, "/");
    } catch {
      return null;
    }
  }
  return s || null;
}

function extractPathsFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const keys = [
    "file_path",
    "filePath",
    "path",
    "target_file",
    "targetFile",
    "file",
  ];
  const out = [];
  for (const k of keys) {
    const v = toolInput[k];
    if (typeof v === "string") {
      const n = normalizeRepoPath(v);
      if (n) out.push(n);
    }
  }
  // Multi-edit / batch
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) {
      if (typeof f === "string") {
        const n = normalizeRepoPath(f);
        if (n) out.push(n);
      } else if (f && typeof f === "object") {
        for (const k of keys) {
          if (typeof f[k] === "string") {
            const n = normalizeRepoPath(f[k]);
            if (n) out.push(n);
          }
        }
      }
    }
  }
  // Shell writes: best-effort
  if (typeof toolInput.command === "string") {
    const cmd = toolInput.command;
    for (const m of cmd.matchAll(
      /(?:^|[\s'"=])((?:src|scripts|\.agents)\/[\w./-]+\.(?:ts|js|mjs|md|json)|(?:AGENTS|HUMANS|package)\.[\w]+)/g,
    )) {
      const n = normalizeRepoPath(m[1]);
      if (n) out.push(n);
    }
  }
  return [...new Set(out)];
}

function isDocPath(rel) {
  const base = rel.split("/").pop()?.toLowerCase() ?? "";
  return DOC_BASENAMES.has(base);
}

function isNoise(rel) {
  return NOISE_RE.test(rel);
}

function isResolverRelevant(rel, resolverPaths) {
  if (isNoise(rel)) return false;
  if (isDocPath(rel)) return false;

  // Exact or prefix match against resolver table paths
  for (const rp of resolverPaths) {
    const r = rp.replace(/\\/g, "/");
    if (rel === r) return true;
    if (r.endsWith("/") && rel.startsWith(r)) return true;
    if (rel.startsWith(r + "/")) return true;
    // Directory listed as file parent
    if (r.endsWith("/*") && rel.startsWith(r.slice(0, -1))) return true;
  }

  // New/changed TypeScript under src/ or scripts/ is always agent-surface
  if (rel.startsWith("src/") && /\.(ts|js|mjs)$/.test(rel)) return true;
  if (rel.startsWith("scripts/") && !rel.includes("/hooks/docs-resolver-lint"))
    return true;
  if (rel === "package.json" || rel === "tsconfig.json") return true;

  return false;
}

function pushUnique(arr, item, max = 40) {
  if (!arr.includes(item)) arr.push(item);
  while (arr.length > max) arr.shift();
}

function isLintDue(state) {
  if (!state.codeHits?.length) return false;
  // Explicitly cleared after a successful docs pass this session
  if (
    state.clearedAt &&
    state.lastCodeAt &&
    Date.parse(state.clearedAt) >= Date.parse(state.lastCodeAt)
  ) {
    return false;
  }
  if (!state.lastDocAt) return true;
  if (!state.lastCodeAt) return false;
  // Due if last code change is strictly after last doc change
  return Date.parse(state.lastCodeAt) > Date.parse(state.lastDocAt);
}

function markFromPaths(paths) {
  const state = loadState();
  const resolverPaths = resolverPathsFromAgents();
  const now = new Date().toISOString();
  let code = false;
  let docs = false;

  for (const p of paths) {
    if (isNoise(p)) continue;
    if (isDocPath(p)) {
      docs = true;
      pushUnique(state.docHits, p);
    } else if (isResolverRelevant(p, resolverPaths)) {
      code = true;
      pushUnique(state.codeHits, p);
    }
  }

  if (code) state.lastCodeAt = now;
  if (docs) {
    state.lastDocAt = now;
    // Editing docs after code counts as addressing the lint
    if (state.lastCodeAt && Date.parse(now) >= Date.parse(state.lastCodeAt)) {
      state.clearedAt = now;
    }
  }

  saveState(state);
  return { state, code, docs, due: isLintDue(state) };
}

function eventName(payload) {
  const raw = (
    payload.hookEventName ||
    payload.event ||
    process.env.AGENT_HOOK_EVENT ||
    process.env.HOOK_EVENT ||
    ""
  ).toString();
  // Normalize UserPromptSubmit / post_tool_use / post-tool-use → user_prompt_submit
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function buildDueMessage(state) {
  const prompt = loadPrompt();
  const hits = (state.codeHits || []).slice(-12).join(", ") || "(unknown)";
  const header = [
    "⚠️ DOCS LINT DUE (Patronum)",
    `Resolver-relevant code changed without a matching docs update: ${hits}`,
    "Update AGENTS.md + HUMANS.md (and resolver table paths) before finishing.",
    "",
  ].join("\n");
  return `${header}${prompt}`;
}

function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const ev = eventName(payload);
  const toolName = (payload.toolName || payload.tool_name || "").toString();
  const toolInput = payload.toolInput || payload.tool_input || payload.input || {};

  // --- Post tool use: track edits ---
  if (ev.includes("post_tool_use") || ev === "afterfileedit") {
    const paths = extractPathsFromToolInput(toolInput);
    // Also try toolName-specific nesting
    if (!paths.length && toolInput.new_string !== undefined) {
      // search_replace without path is useless; ignore
    }
    if (paths.length) {
      const { due, code, docs } = markFromPaths(paths);
      // Keep quiet on success path — only log when something relevant happened
      if (code || docs) {
        console.error(
          `[docs-lint] tracked code=${code} docs=${docs} due=${due} paths=${paths.join(",")}`,
        );
      }
    }
    process.exit(0);
  }

  // --- Pre tool use: no block ---
  if (ev.includes("pre_tool_use")) {
    console.log(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }

  const state = loadState();
  const due = isLintDue(state);

  // --- User prompt: inject context when due ---
  if (ev.includes("user_prompt") || ev.includes("before_submit")) {
    if (due) {
      const msg = buildDueMessage(state);
      // Claude Code / compatible harnesses
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: msg,
          },
          // Some runners also honor top-level additionalContext
          additionalContext: msg,
        }),
      );
    }
    process.exit(0);
  }

  // --- Stop: remind / optional block-with-reason (Claude may honor decision) ---
  if (ev === "stop" || ev.endsWith("_stop") || ev === "subagent_stop") {
    if (due) {
      const msg = buildDueMessage(state);
      console.error(msg);
      // Claude Code Stop: block ends the "done" signal and feeds reason back
      console.log(
        JSON.stringify({
          decision: "block",
          reason: msg.slice(0, 8000),
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: msg.slice(0, 8000),
          },
        }),
      );
      process.exit(0);
    }
    process.exit(0);
  }

  // --- Session end: drop state file (optional hygiene) ---
  if (ev.includes("session_end")) {
    try {
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch {
      // ignore
    }
    process.exit(0);
  }

  // Unknown event: no-op
  process.exit(0);
}

main();
