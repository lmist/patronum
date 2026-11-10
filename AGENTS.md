---
title: Patronum — agent guide
description: How to work in this repository: the rules, where things are, and what to check when sign-in or collection misbehaves.
---
# Patronum — agent guide

Patronum signs one Instagram account in on local Chrome, collects a requested profile, downloads its media and analyzes it with Qwen. Bun drives the browser and the dashboard; Go runs durable jobs and the media tools.

## Jobs go through the dashboard

Drive the app so the app drives the job. Start, retry, resume and cancel collections in the dashboard UI and verify the result there. Shell commands and read-only API calls may inspect evidence; code changes and tests may repair the app. Do not run pipeline stages, mutate job state or call action endpoints directly to get a job through. If a control is missing or broken, fix the app, then use the control. A standalone command succeeding does not prove the app can finish the job. Only an explicit user request for direct CLI operation overrides this.

## Start a session

1. `git status --short`; preserve existing edits.
2. `./bin/bd prime` and `./bin/bd ready`. Claim a matching issue (`./bin/bd update <id> --claim`) or create one before changing code. Tracking rules: [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md); tracker problems: [docs/RESOLVERS.md](./docs/RESOLVERS.md). If `bin/bd` is absent run `make bd`. Never use Homebrew `bd` or `bd init --force`.
3. `./bin/patronum status --json`, then `./bin/patronum commands --json` for every command with its side effects. The [patronum skill](./.claude/skills/patronum/SKILL.md) covers day-to-day use.

Commit and push only when asked.

## Where things are

`./bin/patronum map` prints this from [the catalogue](./src/cmd/patronum-catalogue.ts).

| Folder | What it is for | Read first |
| --- | --- | --- |
| `src/sign-in` | Get one Instagram account logged in and prove it. | [login.ts](./src/sign-in/login.ts) |
| `src/collect` | Read a profile and list every post with its media. | [collect-profile.ts](./src/collect/collect-profile.ts) lists the steps |
| `src/saved` | The signed-in account's bookmarks and recommendations. | [bookmark-recommendations.ts](./src/saved/bookmark-recommendations.ts) |
| `src/api-map` | Record which Instagram routes and page controls exist. | [traffic-recorder.ts](./src/api-map/traffic-recorder.ts) |
| `src/browser` | Open and close local Chrome safely. | [stagehand.ts](./src/browser/stagehand.ts) |
| `src/llm` | Which model to use and whether it answers. | [qwen.ts](./src/llm/qwen.ts), [preflight.ts](./src/llm/preflight.ts) |
| `src/export` | Copy a finished profile into an external wiki. | [trinket.ts](./src/export/trinket.ts) |
| `src/dashboard` | Start jobs and show results. | [server.ts](./src/dashboard/server.ts) lists the URLs; [routes.ts](./src/dashboard/routes.ts) sends each to its file |
| `src/cmd` | Commands: flags, help, exit codes. No logic. | [patronum.ts](./src/cmd/patronum.ts) |
| `src/paths.ts` | Where every file lives on disk. | [paths.ts](./src/paths.ts), Go mirror [internal/home](./internal/home/home.go) |
| `cmd/`, `internal/` | Go: durable jobs, download, unique, analyze. | [job.go](./internal/flow/job.go) |

Rules that keep it readable:

- `src/cmd` files import from the folders above, never from each other.
- `src/browser` and `src/llm` import nothing Instagram-specific.
- Go and the dashboard start `src/cmd/cli.ts`, `src/cmd/scrape-profile.ts` and `src/cmd/map-network.ts` by path. Those paths, flags and exit codes (0 ok, 1 transient, 2 usage, 3 auth, 4 LLM) do not move.
- [job-store.ts](./src/dashboard/job-store.ts) is the only file that reads the job engine's SQLite format.

## Data and credentials

- **Home.** Collected data, the job database, logs, the saved login and caches live in the home folder, not the repository: `PATRONUM_HOME`, default `~/Documents/patronum`. Paths such as `data/…` and `cache/…` below are inside it. The dashboard passes `PATRONUM_HOME` to every child. `IGDASH_ROOT` and `IGFLOW_REPO_ROOT` relocate code and data together and exist for tests.
- **Credentials.** `.env` holds `IG_USER`, `IG_PASS`, optional `IG_TOTP_SECRET`, `QWEN_API_KEY` (aliases `DASHSCOPE_API_KEY`, `ALIBABA_API_KEY`), and `AGENTMAIL_API_KEY` + `AGENTMAIL_ADDRESS` for emailed codes. Inspect presence, never print values, never commit them.
- **Cookies.** `data/chrome-profile/` is the saved login. Do not delete it to fix a slow sign-in; `--fresh-profile` is the deliberate reset. One browser may use it at a time.
- **Caches.** `cache/instagram-auth/` (login controls), `cache/instagram-ui-map.json` (profile controls) and `cache/instagram-api-map.json` (routes) are independent of cookies and safe to rebuild.
- **Client scope.** Every collection names its handle. Never invent a default client or reuse another client's handle.
- **Posts only.** `--skip-reels` on the collector, `-skip-reels` on the Go media tools. Images and carousels remain.

## When sign-in misbehaves

Run `./bin/patronum preflight` first: a model problem is not a cookie problem.

| Observation | Look at | Rule |
| --- | --- | --- |
| Key, quota or model error before Chrome | `patronum preflight`; [preflight.ts](./src/llm/preflight.ts) | Fix the model separately. Deleting cookies cannot help. |
| Chrome will not launch, or profile in use | Processes using `data/chrome-profile`; `createStagehand` | One owner per profile. Account → Close inactive collection browser releases an orphan once jobs stop. Startup allows 60 seconds. |
| Stops after "navigating" | URL and load state in `runLoginInSession` ([login.ts](./src/sign-in/login.ts)) | Tell a navigation failure from a loaded login or challenge page. |
| Waits before typing, or model schema error | `fillLoginForm`; [SDK patch](./scripts/patch-stagehand-aisdk.mjs) | Known login fields use the DOM, not the model. A passing preflight does not test structured browser actions. |
| Password entered, still on login | Visible form error | Do not resubmit rejected credentials. |
| `two_factor` / `codeentry` / method picker | Visible delivery method; `submitTotp`, `classifyPageByUrl` | A code-entry URL can mean email or authenticator. Check the page. |
| Image puzzle | `[captcha]` lines from `patronum login`; [browser.ts](./src/sign-in/captcha/browser.ts), [tile-agents.ts](./src/sign-in/captcha/tile-agents.ts), [frames.ts](./src/sign-in/captcha/frames.ts) | Keep the profile; prove sign-in afterwards with `patronum session --check-only`. Saved-capture recognition is read-only. |
| `challenge` / `auth_platform` / checkpoint | `inspectCheckpoint`, `probeCheckpointFrames` | Inspect child frames. A checkpoint is not always a puzzle. |
| Waiting for an emailed code | `submitEmailCheckpoint`; [agentmail.ts](./src/sign-in/agentmail.ts) | Poll only for mail sent after this attempt's own request. Never print bodies or codes. |
| Unknown delivery method after navigation | `classifyPage` | Re-read the URL after frame inspection; Instagram can move on to `accounts/onetap` meanwhile. |
| Says success, then a login wall | [auth-check.ts](./src/sign-in/auth-check.ts) `assertAuthenticated`; `preserveCookiesOnClose` | Prove sign-in after reopening the same profile. Chrome must flush cookies before cleanup. |
| Page controls changed | [prompts.ts](./src/sign-in/prompts.ts), [ui-map.ts](./src/api-map/ui-map.ts) | Invalid remembered controls are forgotten and rediscovered. Clear the cache, not the profile. |

## Things the code will not tell you

| Area | Contract |
| --- | --- |
| Collecting | Every auth check goes through `stagehandAuthProbe` ([open-profile.ts](./src/collect/open-profile.ts)). Posts open in raw CDP tabs ([cdp-detail.ts](./src/collect/cdp-detail.ts)); a lost tab is replaced before that worker's next attempt. `isSameDetailPost` matches by shortcode because `/reel/X/` redirects to `/reels/X/`. Metrics are recorded only when stated. An empty owned-media harvest keeps grid URLs unverified instead of failing the run. |
| Instagram says no | [rejections.ts](./src/collect/rejections.ts): stop on the first rejected response, keep what was captured, wait before another collection. Never infer a 429 without a status, reset credentials for it, or use other accounts or proxies to get around it. |
| Cached profile query | Only observed profile queries may be replayed, and session-bound request material stays in memory. A rebuilt cached query that returns a malformed answer is dropped and posts are opened directly ([read-posts-from-api.ts](./src/collect/read-posts-from-api.ts)). Validate response data, not just HTTP 200. |
| Mapping routes | Dashboard: New collection → Troubleshooting → Map APIs, result under Account → Activity. Traces go to `data/network/<handle>/`. |
| Skipping the model check | `--skip-llm-preflight` (dashboard: Download media) skips both readiness pings. Credential presence, sign-in and tools are still checked; analysis and browser inference still need a working key. |
| Verify stage | [verify.go](./internal/flow/verify.go) rejects a partial profile. `session.didLogin: false` only means saved cookies were reused. |
| Resume | Resuming an ERROR job forks from the first failed step. A failed collect stage is replayed as recorded, so start a new collection to retry it; the saved profile is reused. See [durable jobs](./docs/reference/dbos-durable-workflows.md). |
| Unique media | [ownership.go](./cmd/igunique/ownership.go): `collectPostMedia` identifies post-owned media; `mediaOwnershipVersion: 1` marks verified rows and older rows reopen. Identical content shares one file. Retired output moves to `data/<handle>-unique-archive/`. |
| Analysis | [iganalyze](./cmd/iganalyze/main.go) checkpoints every result atomically, stops scheduling on a provider-wide failure, and drains in-flight work. |
| Dashboard defaults | [collection-form.ts](./src/dashboard/web/features/collections/collection-form.ts): 30 posts, all media, download only, 2 browser tabs, 4 downloads, 2 analyses, 30 minutes. CLI defaults are separate. |
| Results | [results.ts](./src/dashboard/results.ts) matches cover URLs to local files before ranking by resolution. Coverage ([coverage.ts](./src/dashboard/coverage.ts)) records every post, including ones without media. Wiki export is opt-in and targets an external folder; this repository is never a wiki. |
| Saved dates | [instagram-saved-timestamps.md](./docs/reference/instagram-saved-timestamps.md): `saved_time` comes from `IGCrossAppSavesQuery`. `patronum saved --target` changes the account and needs an explicit request; after a rejection, `--reconcile-only` must confirm provisional saves first. |
| Look and feel | [PRODUCT.md](./PRODUCT.md) and [DESIGN.md](./DESIGN.md). Logos: `bun run brand`, then `bun run dash:build`. |
| Go debugger | `make debug-setup`, then `make debug-check`, `make debug-go` or `make debug-lldb`. |

## Checks

`./bin/patronum check` lists the areas; `./bin/patronum check <area>...` runs them. Tests use a throwaway home ([test-home.ts](./src/test-home.ts)), never the operator's. Off unless asked for:

| What | Command |
| --- | --- |
| Image verification in a real browser | `PATRONUM_CAPTCHA_BROWSER_TEST=1 bun test src/sign-in/captcha/browser.test.ts src/sign-in/captcha/capture.test.ts` |
| Cookie persistence in real Chrome | `PATRONUM_LOGIN_BROWSER_TEST=1 bun test src/browser/stagehand.browser.test.ts` |
| Media ownership against a saved scrape | `IGUNIQUE_SAVED_SCRAPE_TEST=1 go test ./cmd/igunique -run TestSavedScrapeOwnership -v` |
| Job crash recovery | `make igflow-recovery` |
| The skill's evals | [evals/README.md](./.claude/skills/patronum/evals/README.md) |

## Finishing

Update this file and [HUMANS.md](./HUMANS.md) when a command, rule or contract changes ([docs hook](./scripts/hooks/docs-resolver-lint.prompt.md)). Run the relevant checks, close finished issues, and report the changed files. Pi and OpenCode are unused: never add `.pi/` or `.opencode/` material.
