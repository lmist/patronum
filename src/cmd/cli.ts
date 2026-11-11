import { CaptchaSolveError } from "../sign-in/captcha/solver.js";
import "dotenv/config";
import { isAuthError } from "../sign-in/auth-check.js";
import { MissingCredentialsError, getAccount } from "../sign-in/accounts.js";
import { loginInstagram } from "../sign-in/login.js";
import { openAuthenticatedSession } from "../sign-in/session.js";
import {
  HINT_LLM,
  LlmError,
  isLlmError,
  pingLlm,
} from "../llm/preflight.js";
import { resolveChromeProfileDir } from "../browser/stagehand.js";
import { MODEL_ROLES, resolveQwenApiKey, resolveQwenBaseUrl, resolveQwenModelName, resolveVideoFormat, type ModelRole } from "../llm/qwen.js";

/** Human- and agent-readable CLI help (also printed for unknown commands). */
export function helpText(): string {
  return `patronum login | session | preflight — sign one Instagram account in (local Stagehand)

USAGE
  patronum login [--keep-open] [--fresh-profile]
  patronum session [--check-only]
  patronum preflight

COMMANDS
  help, -h, --help     Show this help
  login                Full password (+ TOTP if configured) login; persist cookies
  session              Open local Chrome with stored profile; login if needed
  start                Same as session (default when no command given)
  preflight            Check each model role (no Chrome): browser with text, vision
                       with an image, video with a short video. Exit 0 on ok, exit 4 on
                       missing/bad key, bad model, exhausted quota, or unreachable.

OPTIONS
  --check-only         Check saved session without logging in (session/start only)
  --fresh-profile      Wipe local Chrome profile before login (login only)
  --keep-open          Leave visible Chrome open for manual verification (login only).
                       Close that window before running another browser command.

ENV (in .env)
  LLM_API_KEY          Key for an OpenAI-compatible endpoint (required; or QWEN_API_KEY)
  LLM_BASE_URL         That endpoint (or QWEN_BASE_URL; default: Qwen Token Plan)
  LLM_MODEL            Model for every role (or QWEN_MODEL; default qwen3.8-max)
  LLM_MODEL_BROWSER    Model that drives Chrome: text, structured output
  LLM_MODEL_VISION     Model that reads image puzzles: image input
  LLM_MODEL_VIDEO      Model that analyzes media: image and video input
  LLM_VIDEO_FORMAT     How video is attached: video_url (Qwen), file, image_url
  IG_USER / IG_PASS    Instagram credentials (required)
  IG_TOTP_SECRET       Authenticator secret (optional, if 2FA enabled)
  AGENTMAIL_API_KEY    Email checkpoint API key (optional)
  AGENTMAIL_ADDRESS    Inbox receiving Instagram email codes (optional)
  PATRONUM_CHROME_PROFILE_DIR  Optional isolated Chrome profile path
  PATRONUM_AUTH_CACHE_DIR      Optional isolated action cache path
  HEADLESS=true        Run Chrome headless (default: visible window)

EXAMPLES
  patronum preflight
  patronum login
  patronum login --fresh-profile
  patronum session --check-only

OUTPUT
  JSON with ok, user, sessionId, liveUrl (local profile path), didLogin
  Exit 0 on success; login/session exit 3 on auth failure, 1 on runtime failure.
  preflight exits 4 on any LLM problem (missing/bad key, bad model, quota,
  unreachable). patronum collect follows the extended contract:
  0 ok · 1 retryable · 2 usage · 3 auth (non-retryable) · 4 llm (non-retryable).

DATA
  .env                     Credentials (gitignored — do not commit)
  data/chrome-profile/     Local Chrome user-data (cookies; gitignored)
  cache/instagram-auth/    Stagehand action cache (safe to delete)

See HUMANS.md for a plain-language guide.
See AGENTS.md for the agent resolver table (intent → file → symbol).
`;
}

function parseArgs(argv: string[]) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift()! : "start";
  let forceFreshProfile = false;
  let keepOpen = false;
  let checkOnly = false;
  let wantHelp = false;

  if (
    command === "help" ||
    command === "-h" ||
    command === "--help" ||
    command === "usage"
  ) {
    wantHelp = true;
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--fresh-profile" || a === "--new-context") {
      // --new-context kept as alias for old muscle memory
      forceFreshProfile = true;
    } else if (a === "--check-only") {
      checkOnly = true;
    } else if (a === "--keep-open") {
      keepOpen = true;
    } else if (a === "-h" || a === "--help") {
      wantHelp = true;
    }
  }

  return { command, forceFreshProfile, keepOpen, checkOnly, wantHelp };
}

async function main() {
  const { command, forceFreshProfile, keepOpen, checkOnly, wantHelp } = parseArgs(
    process.argv.slice(2),
  );

  if (wantHelp) {
    console.log(helpText());
    return;
  }

  if (command === "all" || command === "concurrent") {
    console.error(
      "[patronum] multi-account concurrent mode was removed. Use login/session for the single account in .env",
    );
    process.exit(1);
  }

  if (command === "preflight") {
    let apiKey: string;
    try {
      apiKey = resolveQwenApiKey(process.env);
    } catch (err) {
      const llm = new LlmError(
        "missing-key",
        err instanceof Error ? err.message : String(err),
      );
      console.log(
        JSON.stringify({
          ok: false,
          error: "llm",
          kind: llm.kind,
          reason: llm.message,
          hint: HINT_LLM,
        }),
      );
      process.exit(4);
    }
    const baseUrl = resolveQwenBaseUrl(process.env);
    const videoFormat = resolveVideoFormat(process.env);
    const probes = { browser: "text", vision: "image", video: "video" } as const;
    // Roles that share a model are still checked separately: each sends different input.
    const results = await Promise.all(MODEL_ROLES.map(async (role: ModelRole) => {
      const ping = await pingLlm({
        apiKey, baseUrl, model: resolveQwenModelName(process.env, role),
        probe: probes[role], videoFormat, timeoutMs: role === "browser" ? 10_000 : 60_000,
      });
      return { role, ping };
    }));
    const describe = ({ ping }: (typeof results)[number]) => ({
      model: ping.model,
      baseUrl: ping.baseUrl,
      status: ping.status,
      kind: ping.kind ?? (ping.ok ? "ok" : "unreachable"),
      reason: ping.reason,
      latencyMs: ping.latencyMs,
    });
    const failed = results.find((result) => !result.ping.ok);
    const payload = {
      ok: !failed,
      ...(failed ? { error: "llm", kind: failed.ping.kind ?? "unreachable" } : {}),
      // `llm` is the role that failed, or the browser role: igflow reads this object.
      llm: describe(failed ?? results[0]!),
      roles: Object.fromEntries(results.map((result) => [result.role, describe(result)])),
      videoFormat,
      ...(failed ? { hint: HINT_LLM, reason: `${failed.role} model: ${failed.ping.reason}` } : {}),
    };
    // Compact: igflow classifies the last stdout JSON object. Pretty-print
    // made lastJSONLine keep only the opening "{" and die as "no tail JSON".
    console.log(JSON.stringify(payload));
    process.exit(failed ? 4 : 0);
  }

  if (command === "login") {
    const account = getAccount();
    console.log(`[patronum] command=${command} account=${account.user}`);
    const result = await loginInstagram(account, { forceFreshProfile, keepOpen });
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: "login",
          user: account.user,
          sessionId: result.sessionId,
          liveUrl: result.liveUrl,
          profileDir: result.profileDir,
          loggedInAs: result.loggedInAs,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "session" || command === "start") {
    const account = getAccount();
    console.log(`[patronum] command=${command} account=${account.user}`);
    const result = await openAuthenticatedSession(account, {
      loginIfNeeded: !checkOnly,
    });
    console.log(
      JSON.stringify(
        {
          ok: result.loggedIn,
          command,
          user: account.user,
          sessionId: result.sessionId,
          liveUrl: result.liveUrl,
          profileDir: result.profileDir,
          detail: result.detail,
          ...(!result.loggedIn ? { error: "auth", hint: "Use Sign in or Open login browser, complete verification, close Chrome, then Check session." } : {}),
          didLogin: result.didLogin,
        },
        null,
        2,
      ),
    );
    if (!result.loggedIn) process.exit(3);
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(helpText());
  process.exit(1);
}

/** True when this file is the process entry (Bun `import.meta.main` or Node argv). */
function isCliEntry(): boolean {
  if (import.meta.main === true) return true;
  if (import.meta.main === false) return false;
  const arg = process.argv[1];
  if (!arg) return false;
  return (
    arg.endsWith("/cli.ts") ||
    arg.endsWith("/cli.js") ||
    arg.endsWith("src/cmd/cli.ts") ||
    arg.endsWith("src/cmd/cli.js")
  );
}

if (isCliEntry()) {
  main().catch((err) => {
    if (isLlmError(err)) {
      console.error(`[patronum] llm failure: ${err.message}`);
      console.log(
        JSON.stringify({
          ok: false,
          error: "llm",
          kind: err.kind,
          reason: err.message,
          hint: HINT_LLM,
        }),
      );
      process.exit(4);
    }
    const reason = err instanceof Error ? err.message : String(err);
    const automatic = err instanceof CaptchaSolveError;
    const manual = !automatic && /captcha|puzzle|checkpoint|verification|2fa/i.test(reason);
    console.log(JSON.stringify({
      ok: false,
      error: isAuthError(err) || manual || automatic ? "auth" : "runtime",
      reason,
      profileDir: resolveChromeProfileDir(),
      browserOpen: process.argv.includes("--keep-open"),
      ...(isAuthError(err) ? { state: err.state } : {}),
      ...(manual ? { state: "checkpoint", manualRequired: true } : {}),
      ...(automatic ? { state: "checkpoint", manualRequired: false, captcha: err.result } : {}),
      hint: err instanceof MissingCredentialsError
        ? "Set IG_USER and IG_PASS in .env, then run: patronum login"
        : automatic
        ? "Automatic verification stopped. Inspect the CAPTCHA diagnostics and retry after resolving the reported cause."
        : manual
        ? "Use Open login browser, complete verification in Chrome, close that window, then Check session."
        : "Review the error and configuration, close any Chrome window using this profile, then retry.",
    }));
    if (isAuthError(err) || manual || automatic) process.exit(3);
    process.exit(1);
  });
}
