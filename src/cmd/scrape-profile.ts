/**
 * scrape-profile command: flags, help text and exit codes.
 *
 * The work itself is in src/collect/ — start at collect-profile.ts.
 * The Go job engine and the dashboard start this file by path, so its
 * location, flags and exit codes are a contract:
 *   0 ok · 1 transient or Instagram rejection · 2 usage · 3 auth · 4 LLM
 *
 * Usage:
 *   bun src/cmd/scrape-profile.ts --url <profile_url> [--max N] [--out PATH]
 *     [--force-login] [--fresh] [--no-resume] [--scroll-rounds N]
 *     [--detail | --no-detail] [--skip-reels]
 */
import "dotenv/config";
import { isAuthError } from "../sign-in/auth-check.js";
import { HINT_LLM, isLlmError } from "../llm/preflight.js";
import { collectProfile } from "../collect/collect-profile.js";
import { DEFAULT_DETAIL_WORKERS } from "../collect/pool.js";
import { InstagramHttpRejectionError } from "../collect/rejections.js";

export function parseArgs(argv: string[]) {
  let url: string | undefined;
  let max = 120;
  let out: string | undefined;
  let wantHelp = false;
  let forceLogin = false;
  let skipLlmPreflight = false;
  let fresh = false;
  let resume = true;
  let scrollRounds: number | undefined;
  /** Open every post/reel for full media — default ON (mandatory completeness). */
  let detail = true;
  /** Skip Reels tab + reel/video items; keep image and carousel posts. */
  let skipReels = false;
  const envWorkers = Number(process.env.PATRONUM_DETAIL_WORKERS);
  let workers = Number.isFinite(envWorkers) && envWorkers >= 1
    ? Math.floor(envWorkers)
    : DEFAULT_DETAIL_WORKERS;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") url = argv[++i];
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a === "--max") max = Number(argv[++i]);
    else if (a.startsWith("--max=")) max = Number(a.slice("--max=".length));
    else if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--skip-llm-preflight") skipLlmPreflight = true;
    else if (a === "--force-login") forceLogin = true;
    else if (a === "--fresh") {
      fresh = true;
      resume = false;
    } else if (a === "--no-resume") resume = false;
    else if (a === "--resume") resume = true;
    else if (a === "--detail") detail = true;
    else if (a === "--no-detail") detail = false;
    else if (
      a === "--skip-reels" ||
      a === "--no-reels" ||
      a === "--posts-only"
    )
      skipReels = true;
    else if (a === "--reels" || a === "--include-reels") skipReels = false;
    else if (a === "--scroll-rounds") scrollRounds = Number(argv[++i]);
    else if (a.startsWith("--scroll-rounds="))
      scrollRounds = Number(a.slice("--scroll-rounds=".length));
    else if (a === "--workers" || a === "--detail-workers")
      workers = Number(argv[++i]);
    else if (a.startsWith("--workers="))
      workers = Number(a.slice("--workers=".length));
    else if (a.startsWith("--detail-workers="))
      workers = Number(a.slice("--detail-workers=".length));
    else if (a === "-h" || a === "--help") wantHelp = true;
  }

  if (!Number.isFinite(max) || max < 1) max = 120;
  max = Math.floor(max);
  if (scrollRounds !== undefined) {
    if (!Number.isFinite(scrollRounds) || scrollRounds < 1) scrollRounds = 8;
    scrollRounds = Math.floor(scrollRounds);
  }
  if (!Number.isFinite(workers) || workers < 1) workers = DEFAULT_DETAIL_WORKERS;
  workers = Math.floor(workers);

  return {
    url,
    max,
    out,
    wantHelp,
    forceLogin,
    skipLlmPreflight,
    fresh,
    resume,
    scrollRounds,
    detail,
    skipReels,
    workers,
  };
}

export function helpText(): string {
  return `patronum collect — collect one Instagram profile: header, grid, every post (local Stagehand)

USAGE
  patronum collect --url <profile_url> [options]

OPTIONS
  --url <url>          Profile URL (required)
  --max N              Cap items per tab (default: 120)
  --out PATH           Output JSON (default: data/profiles/<user>-profile.json)
  --skip-llm-preflight Skip provider readiness checks; later LLM calls may fail
  --force-login        Run full login before scrape (warm cookies)
  --fresh              Wipe existing profile JSON + data/media/<user>/ then scrape
  --resume             Merge into existing profile JSON (default)
  --no-resume          Overwrite profile JSON without merging (does not wipe media)
  --detail             Open every post/reel for full media (default: on)
  --no-detail          Skip per-item detail opens (grid-only, incomplete media)
  --skip-reels         Posts tab only; drop reels and standalone videos
                       (image + carousel posts). Aliases: --no-reels, --posts-only
  --workers N          Parallel detail tabs (default: 10)
  --detail-workers N   Alias of --workers
  --scroll-rounds N    Override scroll depth per tab
  -h, --help           Help

EXIT CODES
  0  ok — profile JSON written
  1  failure (retryable) — network hiccup, page shape drift, transient extract
  2  usage — missing/invalid CLI args
  3  auth — Instagram not authenticated (login/totp/checkpoint or login wall);
        non-retryable; no profile JSON is written. Run: patronum login
  4  llm — Qwen/LLM missing, key rejected, model absent, or quota exhausted;
        non-retryable. Run: patronum preflight
`;
}

async function main() {
  const { wantHelp, url, ...options } = parseArgs(process.argv.slice(2));

  if (wantHelp) {
    console.log(helpText());
    process.exit(0);
  }
  if (!url) {
    console.error("error: --url <profile_url> is required\n");
    console.error(helpText());
    process.exit(2);
  }

  await collectProfile({ url, ...options });
}

if (import.meta.main) {
  main().catch((err) => {
    if (isAuthError(err)) {
      // Non-retryable: no profile JSON is written or clobbered on auth failure.
      console.error(`[scrape] auth failure: ${err.message}`);
      console.log(
        JSON.stringify({
          ok: false,
          error: "auth",
          reason: err.evidence?.reason ?? err.message,
          state: err.state ?? "unknown",
          hint:
            "patronum login (fix IG_TOTP_SECRET or finish 2FA in the local Chrome), then re-run",
        }),
      );
      process.exit(3);
    }
    if (isLlmError(err)) {
      // Non-retryable: prior checkpoints on disk stay intact (real data);
      // partial:true is preserved so verify fails closed downstream.
      console.error(`[scrape] llm failure: ${err.message}`);
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
    if (err instanceof InstagramHttpRejectionError) {
      console.error(`[scrape] HTTP rejection: ${err.message}`);
      console.log(JSON.stringify({
        ok: false,
        retryable: false,
        error: "instagram_http_rejection",
        reason: err.message,
        transportError: err.transportError,
        httpStatus: err.httpStatus,
        retryAfter: err.retryAfter,
        hint: "Instagram rejected a post response. Wait, then retry the saved collection through the dashboard.",
      }));
      process.exit(1);
    }
    // Raw transport failures here may be Chrome/CDP, not Qwen. LLM callsites
    // classify provider failures through noteLlmError before reaching here.
    console.error("[scrape] error:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    console.log(
      JSON.stringify({
        ok: false,
        retryable: true,
        path: null,
        counts: {},
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
}
