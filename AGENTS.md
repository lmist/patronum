---
title: Patronum — task and code resolvers
description: Route project tasks and login symptoms to commands, evidence, source files, and checks.
---
# Patronum — task and code resolvers

Patronum authenticates one Instagram account in local Chrome, scrapes a requested profile, downloads media, and analyzes it with Qwen. Bun owns browser automation; Go owns media tools and durable jobs. Start with the task table, then read only the relevant subsystem. Commands run from the repository root. Sources: [CLI](./src/cmd/cli.ts), [browser factory](./src/browser/stagehand.ts), [job CLI](./cmd/igflow/main.go).

## App-driven job operation — mandatory

Drive the app so the app drives the job to completion. For job troubleshooting, recovery, retries, and completion, use the dashboard UI to launch and control the workflow and verify its visible final status and outputs. Shell commands and read-only API calls may inspect evidence; code changes and tests may repair the app or its workers. Do not run pipeline stages, retry analysis, publish the wiki, mutate job state, or call action endpoints directly to bypass the UI. If a required control is missing or broken, fix the app, then exercise that control through the UI. A successful standalone command is not proof that the app can complete the job. Only an explicit user request for direct CLI operation overrides this rule. The command tables below are references, not permission to bypass this rule. See the [dashboard server](./src/dashboard/server.ts), [UI](./src/dashboard/web/App.tsx), and [human guide](./HUMANS.md).

## Start a session

1. Run `git status --short`; preserve existing edits.
2. Run `./bin/bd prime` and `./bin/bd ready`. Claim a matching issue with `./bin/bd update <id> --claim`, or create one for the requested work. Do this before code changes.
3. Run `./bin/patronum status --json` to see whether the checkout is ready, and `./bin/patronum commands --json` for every command with its side effects.
4. Pick a row below. Read the [Beads contract](./AGENT_INSTRUCTIONS.md) for tracking rules; use [Beads resolvers](./docs/RESOLVERS.md) only for tracker/setup problems.

If `bin/bd` is absent, run `make bd`. If its database is unhealthy, use `./bin/bd bootstrap --yes`. Never use Homebrew `bd` or `bd init --force`. Commit and push only when requested.

## Module map

Each folder has one purpose. `./bin/patronum map` prints this table from [the catalogue](./src/cmd/patronum-catalogue.ts); add a row there when a folder is added.

| Folder | What it is for | Read first |
| --- | --- | --- |
| `src/sign-in` | Get one Instagram account logged in and prove it. | [login.ts](./src/sign-in/login.ts) |
| `src/collect` | Read a profile and list every post with its media. | [collect-profile.ts](./src/collect/collect-profile.ts) lists the steps in order |
| `src/saved` | The signed-in account's bookmarks and recommendations. | [bookmark-recommendations.ts](./src/saved/bookmark-recommendations.ts) |
| `src/api-map` | Record which Instagram routes and page controls exist. | [traffic-recorder.ts](./src/api-map/traffic-recorder.ts) |
| `src/browser` | Open and close local Chrome safely. | [stagehand.ts](./src/browser/stagehand.ts) |
| `src/llm` | Which model to use and whether it answers. | [qwen.ts](./src/llm/qwen.ts), [preflight.ts](./src/llm/preflight.ts) |
| `src/export` | Copy a finished profile into an external wiki. | [trinket.ts](./src/export/trinket.ts) |
| `src/dashboard` | Start jobs and show results. | [server.ts](./src/dashboard/server.ts) lists the URLs; [routes.ts](./src/dashboard/routes.ts) sends each to its file |
| `src/cmd` | Commands: flags, help, exit codes. No logic. | [patronum.ts](./src/cmd/patronum.ts) |
| `src/paths.ts` | Where every file lives on disk. | [paths.ts](./src/paths.ts); Go mirror in [job.go](./internal/flow/job.go) |
| `cmd/`, `internal/` | Go: durable jobs, download, unique, analyze, video probing. | [job.go](./internal/flow/job.go) |

Rules that keep it readable: `src/cmd` files import from the folders above, never from each other. `src/browser` and `src/llm` import nothing from Instagram-specific folders. Go and the dashboard start `src/cmd/cli.ts`, `src/cmd/scrape-profile.ts` and `src/cmd/map-network.ts` by path, so those paths, flags and exit codes do not move.

## Task resolver

| Need | First command / evidence | Continue in |
| --- | --- | --- |
| Learn commands or configure credentials | `./bin/patronum --help`, `./bin/patronum status --json` (presence only, never values) | [Human guide](./HUMANS.md), [accounts.ts](./src/sign-in/accounts.ts) |
| Skip a failing LLM readiness ping | New collection → What to do → Download media (default); analysis mode exposes Troubleshooting → Skip the LLM readiness check | `--skip-llm-preflight` persists `JobInput.SkipLLMPreflight` and skips workflow and scraper pings. Credential presence, Instagram auth, and tools remain checked; analysis and browser inference still need a working key. Start a new collection to change inputs. |
| Check the LLM independently of Instagram | `bun src/cmd/cli.ts preflight` → `ok`, HTTP status, latency, failure kind | [preflight.ts](./src/llm/preflight.ts): `pingLlm`, `isProviderError`; [stagehand.ts](./src/browser/stagehand.ts): Qwen resolvers |
| Reuse saved Instagram cookies | `bun run session` → `ok`, `didLogin` | [session.ts](./src/sign-in/session.ts): `openAuthenticatedSession` |
| Diagnose slow or failed login | Run preflight, then `bun run login`; use the last progress line and page state | Login symptom resolver below; [login.ts](./src/sign-in/login.ts): `runLoginInSession` |
| Scrape one profile | `bun run scrape-profile -- --help`; supply `--url https://www.instagram.com/<handle>` | Flags: [scrape-profile.ts](./src/cmd/scrape-profile.ts) `helpText`; steps: [collect-profile.ts](./src/collect/collect-profile.ts); post shape: [post-shape.ts](./src/collect/post-shape.ts) `isReelOrVideoPost` |
| Run / resume / inspect a durable pipeline | `go run ./cmd/igflow --help` or `bun run igflow -- --help` | [igflow CLI](./cmd/igflow/main.go): `runCLI`; [job stages](./internal/flow/job.go); [scrape child](./internal/flow/stage_scrape.go); [verify](./internal/flow/verify.go); [media stages](./internal/flow/stage_media.go); [reference](./docs/reference/dbos-durable-workflows.md) |
| Verify rejects `session.didLogin: false` | [VerifyProfile](./internal/flow/verify.go), [session helper](./src/sign-in/ensure-session.ts) | `didLogin` records a new login; false means saved cookies were reused. New scrapes emit `session.authenticated`; legacy completed `ok: true` scrapes accept either boolean `didLogin`. Resume the failed job after updating the verifier. |
| Job died / WAL check | `go run ./cmd/igflow list --status pending` then `resume <id>`; `doctor` → `journalMode: wal` | [igflow doctor](./internal/flow/doctor.go); [durable reference](./docs/reference/dbos-durable-workflows.md) |
| Watch or launch jobs in a local UI | `bun run dash` → http://127.0.0.1:7799 ; wiki export is a separate opt-in action in Results | [dashboard server](./src/dashboard/server.ts), [UI](./src/dashboard/web/App.tsx), logs `data/dbos/logs/_dash/igdash.log` |
| Download / deduplicate / analyze existing scrape | `go run ./cmd/igdl -h`, `go run ./cmd/igunique -h`, `go run ./cmd/iganalyze -h` | Media resolver below |
| Export a profile to a wiki | Results → Export trinket box; choose an external OKF wiki | [exporter](./src/export/trinket.ts); [external wiki adapter](./src/export/open-knowledge.ts) |
| Discover or refresh Instagram API / GraphQL routes | Dashboard **New collection → Troubleshooting → Map APIs**, then **Account → Activity**; sanitized cache `cache/instagram-api-map.json`, traces `data/network/<handle>/` | [Mapping action](./src/cmd/map-network.ts), [traffic recorder](./src/api-map/traffic-recorder.ts), [GraphQL reader](./src/collect/graphql-profile.ts). Keep session-bound templates in memory; only observed profile queries may be replayed. Validate response data, not just HTTP 200. |
| Recover the authenticated account's bookmark dates | Native `IGCrossAppSavesQuery` → `xfb_cross_app_saves_infinite_scroll.edges[].node.saved_time` (Unix seconds) | [Verified query reference](./docs/reference/instagram-saved-timestamps.md). Confirm the account, match by `content_url` shortcode, keep `content_id` separate from media `pk`, and check pagination. Publication and request timestamps are not bookmark timestamps. |
| Rediscover a Saved-time query after an Instagram client update | `python3 scripts/discover-instagram-saved-query.py path/to/instagram.apk --apksig-jar path/to/apksig.jar` | [Discovery procedure](./docs/reference/instagram-saved-timestamps.md#rediscover-from-an-apk). Verifies the signer against Instagram asset links, then finds Saved query paths selecting `saved_time` from the client registry and Pando metadata. Live account validation is still required. |
| Inspect or directly save the authenticated account's Explore recommendations | `bun src/cmd/bookmark-recommendations.ts --account <handle> --inspect`; only on explicit direct-CLI request, `--target <count>` | [Human guide](./HUMANS.md#savedbookmarked-dates), [runner](./src/cmd/bookmark-recommendations.ts), [API parser](./src/saved/bookmark-recommendations.ts). Personalized Explore REST supplies candidates; native GraphQL confirms saves and paginates `saved_time`. Per-account checkpoint `data/bookmarks/recommendations-<handle>.json` prevents duplicate mutations. Stop on the first provider rejection; after it clears, `--reconcile-only` must confirm provisional saves before resuming. |
| Map Instagram UI / read notifications | `bun run map`, `bun run map:deep`, `bun run notifications` | [map-elements.ts](./src/cmd/map-elements.ts), [map-deep.ts](./src/cmd/map-deep.ts), [log-notifications.ts](./src/cmd/log-notifications.ts) |
| Inspect image-verification recognition | `bun src/sign-in/captcha/cli.ts status`; dashboard Image verification | [Recognition](./src/sign-in/captcha/recognition.ts), [per-tile agents](./src/sign-in/captcha/tile-agents.ts), [capture](./src/sign-in/captcha/capture.ts); saved-grid proposals are read-only, while [login verification](./src/sign-in/captcha/browser.ts) opens and submits current challenges |
| Set up / verify Go debugging | `make debug-setup`, then `make debug-check`; interactive: `make debug-go` or `make debug-lldb` | [runner](./scripts/debug-go.mjs), [breakpoint check](./scripts/debug-go-smoke.dlv), [editor launch](./.vscode/launch.json). Defaults to isolated `TestSelectPostMedia`; `DEBUG_PACKAGE` / `DEBUG_TEST` select other tests. macOS Developer Tools access is machine-wide; live jobs remain dashboard-driven. |
| Check changes | `./bin/patronum check` lists areas; `./bin/patronum check types collect` runs them. Everything: `bun test src`, `bun run typecheck`; Go changes: test the affected package | Test resolver below |

## Login symptom resolver

| Observation | Inspect next | Rule |
| --- | --- | --- |
| Missing key / quota / model error before Chrome | `bun src/cmd/cli.ts preflight`; [Qwen config](./src/browser/stagehand.ts), [provider error classification](./src/llm/preflight.ts) | Resolve LLM failures independently; deleting cookies cannot fix them |
| Chrome cannot launch / profile already in use | Processes using `data/chrome-profile`; [createStagehand](./src/browser/stagehand.ts); [socket probe patch](./scripts/patch-stagehand-local-ws.mjs) | One browser owner per profile. Account → Close inactive collection browser releases an orphan only after jobs stop. Local startup allows 60 seconds; the postinstall socket patch keeps cleanup errors handled. |
| Stops after “navigating” | Current page URL, load state, and navigation timing in [runLoginInSession](./src/sign-in/login.ts) | Distinguish navigation failure from a loaded login/challenge page |
| Waits before typing / model schema error | Optional banner handling and `fillLoginForm` in [login.ts](./src/sign-in/login.ts); [SDK patch](./scripts/patch-stagehand-aisdk.mjs) | Measure observe/act calls; a successful preflight does not test structured browser actions |
| Password entered but still on login | Visible form error and submit control; `fillLoginForm` | Do not repeatedly submit rejected credentials |
| `two_factor` / `codeentry` / method picker | Visible delivery method; `submitTotp`, `classifyPageByUrl` | A code-entry URL can mean email or authenticator; check the UI |
| Interactive CAPTCHA / image verification | `bun run login` attempts bounded automatic verification; inspect `[captcha]` phase, tile latency, and reason | [Browser solver](./src/sign-in/captcha/browser.ts), [per-tile agents](./src/sign-in/captcha/tile-agents.ts), [frame recovery](./src/sign-in/captcha/frames.ts); retain the profile and prove auth with `bun run session` |
| `challenge` / `auth_platform` / checkpoint | `inspectCheckpoint`, `probeCheckpointFrames`, frame controls in [login.ts](./src/sign-in/login.ts) | Inspect child frames; a checkpoint is not automatically a CAPTCHA |
| Waiting for an Instagram email / code entry without resend | [login.ts](./src/sign-in/login.ts): `fillLoginForm`, `submitEmailCheckpoint`; [agentmail.ts](./src/sign-in/agentmail.ts): `fetchLatestInstagramCode` | Carry the request timestamp from this login or CAPTCHA into email polling; resumed code entry requires a fresh request. Never print bodies or codes |
| Code-entry inspection reports an unknown delivery method after navigation | [login.ts](./src/sign-in/login.ts): `classifyPage` | Re-read the current URL after frame inspection; Instagram can advance to `accounts/onetap` while the probe runs |
| Reports success but saved session or scrape sees a login wall | [auth-check.ts](./src/sign-in/auth-check.ts): `assertAuthenticated`; [stagehand.ts](./src/browser/stagehand.ts): `preserveCookiesOnClose`; [session helper](./src/sign-in/ensure-session.ts) | Prove authentication after reopening the same profile. Graceful Chrome shutdown must flush cookies before SDK cleanup |
| HTTP response rejected during collection | [rejections.ts](./src/collect/rejections.ts): `InstagramHttpRejectionError`; dashboard failed-stage message | Stop on the first rejection, preserve the affected post and completed captures, and wait before another dashboard collection using the saved list. Never infer 429 without a status, reset credentials for this error, or use alternate accounts/proxies to evade it. |
| UI selectors changed | [prompts.ts](./src/sign-in/prompts.ts), [profile UI map](./src/api-map/ui-map.ts), action cache | Profile controls reuse validated CSS/XPath templates in `cache/instagram-ui-map.json`; invalid targets are forgotten and rediscovered. Known-absent optional controls skip inference. Retain the Chrome profile; selector caches are independent of cookies. |

## Resolver table

| Intent | Path | Symbol / contract |
| --- | --- | --- |
| One command for everything; machine-readable catalogue | [src/cmd/patronum.ts](./src/cmd/patronum.ts), [catalogue](./src/cmd/patronum-catalogue.ts) | `COMMANDS`, `MODULES`, `CHECKS`; inspect commands print one JSON document with `--json`; run commands pass output and exit code through |
| Agent skill for the command, with evals | [SKILL.md](./.claude/skills/patronum/SKILL.md), [evals](./.claude/skills/patronum/evals/README.md) | Six cases, each run with and without the skill in a fixture workspace. Re-run after changing the skill, the catalogue or an inspect command's output. |
| Auth command routing, help, result JSON | [src/cmd/cli.ts](./src/cmd/cli.ts) | `main`, `parseArgs`, `helpText` |
| Browser lifecycle, cache/profile paths | [src/browser/stagehand.ts](./src/browser/stagehand.ts) | `createStagehand`, `resolveChromeProfileDir`, `resolveAuthCacheDir` |
| Model key, base URL, model name | [src/llm/qwen.ts](./src/llm/qwen.ts) | `resolveQwenApiKey`, `resolveQwenBaseUrl`, `resolveQwenModelName` |
| Where files live | [src/paths.ts](./src/paths.ts), [internal/home](./internal/home/home.go) | Code is in the repository (`REPO_ROOT`, `inRepo`); everything collected or saved is in the home (`DATA_HOME`, `inHome`, `layout`). The home is `PATRONUM_HOME`, default `~/Documents/patronum`. Go mirrors it in `home.Dir` and `flow.HomeDir`. The dashboard passes `PATRONUM_HOME` to every child. `IGDASH_ROOT` / `IGFLOW_REPO_ROOT` relocate code and data together and exist for tests. |
| Standard form / optional UI / checkpoint readiness | [src/sign-in/login.ts](./src/sign-in/login.ts) | `fillLoginForm`, `dismissCookieBanner`, `dismissPostLoginModals`, `waitForCheckpointFrames`; DOM first, no model calls for known controls |
| Open a session for scrape/map callers | [src/sign-in/ensure-session.ts](./src/sign-in/ensure-session.ts) | `ensureAuthenticatedSession`; caller closes browser |
| Prove auth / classify auth failure | [src/sign-in/auth-check.ts](./src/sign-in/auth-check.ts) | `assertAuthenticated`, `AuthError`, `isAuthError` |
| Email security code retrieval | [src/sign-in/agentmail.ts](./src/sign-in/agentmail.ts) | `fetchLatestInstagramCode`, `extractInstagramCode` |
| Stable LLM instructions and variables | [src/sign-in/prompts.ts](./src/sign-in/prompts.ts) | `ACT_TYPE_*`, variable helpers; secrets stay out of prompts |
| Collecting a profile | Flags: [scrape-profile.ts](./src/cmd/scrape-profile.ts) `helpText`. Steps in order: [collect-profile.ts](./src/collect/collect-profile.ts). Workers: [pool.ts](./src/collect/pool.ts) | Every auth check uses `stagehandAuthProbe` (open-profile.ts) for context cookies. Posts open in raw CDP tabs ([cdp-detail.ts](./src/collect/cdp-detail.ts)); a timed-out or lost tab is replaced before that worker's next attempt. `navigateDetailPage` waits for evidence of the exact post, and `isSameDetailPost` matches by shortcode because `/reel/X/` redirects to `/reels/X/`. Metrics (`likeCount`, `commentCount`, `playCount`, `viewCount`, `videoDurationSec`) are recorded only when stated. An empty owned-media harvest keeps grid URLs unverified instead of failing the run. |
| Download variants per post | [cmd/igdl/main.go](./cmd/igdl/main.go) | `reorganizeOutDir`, `destRelPath` → `data/media/<handle>/<shortcode>/` |
| Pick unique high-resolution media | [unique CLI](./cmd/igunique/main.go), [ownership selection](./cmd/igunique/ownership.go), [post extraction](./src/collect/post-media.ts) | `collectPostMedia` identifies post media on article, dialog, and no-article carousel pages; `mediaOwnershipVersion: 1` records verified extraction and older rows reopen. An empty owned harvest keeps grid URLs unverified and does not fail the scrape. `selectPostMedia` resolves assets via the download manifest before ranking; identical content shares a file with per-post manifest references. `archiveSuperseded` moves retired output to `data/<handle>-unique-archive/`. Recover via a new dashboard collection; legacy videos/carousels require recollection. |
| Analyze images and videos | [cmd/iganalyze/main.go](./cmd/iganalyze/main.go) | `collectJobs` / `hasVideoPackets` select owned, readable media; `analyzeOne` sends image_url / native video_url. `runPool` atomically checkpoints every result, stops scheduling on persistence or provider-wide auth/exhausted-quota failure, and drains in-flight work. `loadPriorOK` merges item checkpoints with the aggregate for recovery. Outputs: `data/analysis/<handle>/`. |
| Durable job status and recovery | [cmd/igflow/main.go](./cmd/igflow/main.go), [internal/flow/job.go](./internal/flow/job.go) | `runCLI` (`LoadDotEnv` then host), `resumeHandle`; use status/list/steps before retrying a job |
| Collection form defaults and validation | [Form model](./src/dashboard/web/features/collections/collection-form.ts), [hook](./src/dashboard/web/features/collections/use-collections.ts) | Explicit dashboard defaults: 30 posts, all media, download only, 2 browser tabs, 4 downloads, 2 analyses when enabled, 30m. Goal controls analysis/preflight flags; saved-list retry preserves completed work. CLI defaults are independent. |
| Local job dashboard | [server.ts](./src/dashboard/server.ts) (URL list, boot), [routes.ts](./src/dashboard/routes.ts), [job-store.ts](./src/dashboard/job-store.ts) (only reader of the engine's SQLite format), [launcher.ts](./src/dashboard/launcher.ts), [job-actions.ts](./src/dashboard/job-actions.ts), [account-actions.ts](./src/dashboard/account-actions.ts), [exports.ts](./src/dashboard/exports.ts), [files.ts](./src/dashboard/files.ts), [settings.ts](./src/dashboard/settings.ts), [React UI](./src/dashboard/web/App.tsx), [state](./src/dashboard/web/state/app.tsx), [log.ts](./src/dashboard/log.ts) | `bun run dash` builds Vite assets and serves `/`; `bun run dash:dev` develops the UI; six collection stages; external OKF wiki export is opt-in. |
| Job sidebar and state machine | [sidebar](./src/dashboard/web/state/sidebar.ts), [selection](./src/dashboard/web/state/selection.ts), [FSM model](./src/dashboard/web/features/progress/fsm.ts), [progress](./src/dashboard/web/features/progress/Progress.tsx) | Selecting a job opens its FSM, returns the workspace to the top, and focuses it; state nodes select stage output and logs. |
| Post-by-post coverage and standalone export | [coverage](./src/dashboard/coverage.ts), [exporter](./src/export/trinket.ts), [coverage controls](./src/dashboard/web/features/results/CoverageExport.tsx) | Results → Update coverage persists every post/reel shortcode, missing assets, cached analysis, partial analysis, and reasons in app-owned SQLite tables. Export trinket box copies an OKF snapshot and local media to an initialized external wiki, with coverage JSON and SQLite. |
| Dashboard media and reader | [results](./src/dashboard/results.ts), [feed](./src/dashboard/web/features/results/Results.tsx), [reader](./src/dashboard/web/features/reader/Reader.tsx) | Match profile cover URLs to local download variants before resolution ranking; preserve shortcode IDs; verify video packets; artifacts are latest per handle. |
| Logo variants and browser assets | `bun run brand`, then `bun run dash:build` | [Brand sources](./src/dashboard/brand/README.md), [generator](./scripts/brand.mjs); capped default and pointed alternate from Paper. |
| Dashboard visual contract | [product](./PRODUCT.md), [design](./DESIGN.md), [surface brief](./src/dashboard/DESIGN.md) | Paper Vivid unity anchors; Tailwind tokens and Base UI-backed shadcn; local Inter. |
| Scrape / verify / media stages | [stage_scrape.go](./internal/flow/stage_scrape.go), [verify.go](./internal/flow/verify.go), [stage_media.go](./internal/flow/stage_media.go) | `ScrapeStage`, `VerifyProfile`, `DownloadMedia`, `UniqueMedia`, `AnalyzeMedia` |
| Workflow preflight / subprocess exits | [internal/flow/stage_preflight.go](./internal/flow/stage_preflight.go), [internal/flow/dotenv.go](./internal/flow/dotenv.go), [internal/flow/exec.go](./internal/flow/exec.go) | `runCLI` → `LoadDotEnv`; `RunPreflight` / `checkEnv`; scrape exits 0 ok, 1 transient, 2 usage, 3 auth, 4 LLM |
| DBOS durable-workflow notes | [docs/reference/dbos-durable-workflows.md](./docs/reference/dbos-durable-workflows.md) | SQLite WAL, host vs client, ERROR fork-resume |
| Resolver documentation hook | [scripts/hooks/docs-resolver-lint.mjs](./scripts/hooks/docs-resolver-lint.mjs) | [refresh contract](./scripts/hooks/docs-resolver-lint.prompt.md) |

## Test resolver

`./bin/patronum check` lists the areas and what each covers; `./bin/patronum check <area>...` runs them (`--json` for a summary). Areas: `types`, `sign-in`, `collect`, `api-map`, `saved`, `browser`, `llm`, `export`, `cli`, `dashboard`, `dashboard-ui`, `go`. Tests run in a throwaway home ([test-home.ts](./src/test-home.ts)), never the operator's.

Extra checks that are off unless asked for:

| What | Command |
| --- | --- |
| Image verification in a real browser | `PATRONUM_CAPTCHA_BROWSER_TEST=1 bun test src/sign-in/captcha/browser.test.ts src/sign-in/captcha/capture.test.ts` |
| Cookie persistence in real Chrome | `PATRONUM_LOGIN_BROWSER_TEST=1 bun test src/browser/stagehand.browser.test.ts` |
| Media ownership against a saved scrape | `IGUNIQUE_SAVED_SCRAPE_TEST=1 go test ./cmd/igunique -run TestSavedScrapeOwnership -v` |
| Job crash recovery | `make igflow-recovery` |
| Dashboard preview alias | `IGDASH_UI_PATH=/redesign/ bun test src/dashboard/ui.test.ts` |

## Runtime and data boundaries

- **Runtime:** Bun (pinned in [package.json](./package.json)); Stagehand 3.7.0 drives local Chrome. Qwen defaults and env overrides live in [qwen.ts](./src/llm/qwen.ts). No Browserbase cloud session and no MiniMax runtime.
- **Credentials:** `.env` contains `IG_USER`, `IG_PASS`, optional `IG_TOTP_SECRET`, and `QWEN_API_KEY` (aliases: `DASHSCOPE_API_KEY`, `ALIBABA_API_KEY`). Email checkpoints use `AGENTMAIL_API_KEY` + `AGENTMAIL_ADDRESS`. `igflow` loads `.env` at startup (`LoadDotEnv`; existing env wins); Bun CLIs use `dotenv/config`. Inspect **presence**, never print values. Never commit plaintext secrets.
- **Home:** collected data, the job database, logs, the saved login and caches live in the home folder, not the repository: `PATRONUM_HOME`, default `~/Documents/patronum`. Paths below such as `data/…` and `cache/…` are inside it. `./bin/patronum status` shows which home is in use.
- **Cookies:** `data/chrome-profile/` is persistent auth state. Do not delete it to debug a slow login. `--fresh-profile` deliberately starts over.
- **Action cache:** `cache/instagram-auth/` stores selector inference, independently of cookies.
- **Client scope:** every IG workflow needs `username` (aliases: `user`, `handle`, `profile_url`, `url`). Never invent a default client or reuse another client's handle.
- **Posts only:** `--skip-reels` on the scrape CLI, `-skip-reels` on Go media tools, `skip_reels: true` on dashboard jobs. Images and carousels remain. Job defaults: 10 detail tabs, 8 downloads, 4 analyses.
- **Docs:** ordinary repository Markdown; edit files directly. This repository is not an OpenKnowledge project. OpenKnowledge applies only to an explicitly requested external OKF wiki export. Stagehand's own docs index: https://docs.stagehand.dev/llms.txt.
- **Harnesses:** Pi and OpenCode are unused. Never install `.pi/` or `.opencode/` skills, MCP servers, plugins, or project directories.
- **Completion:** refresh affected resolver rows and [human commands](./HUMANS.md), run relevant checks, close finished beads, report the changed files. Tracking details: [session close](./AGENT_INSTRUCTIONS.md).
