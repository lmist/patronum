# Patronum — human guide

Patronum signs one Instagram account in on a **local Chrome**, keeps the cookies on disk, and uses that session to collect a profile, download its media and analyze it. You run it from a local dashboard.

---

## One-time setup

1. Install [Bun](https://bun.sh), Go, Chrome, `ffmpeg` and `ffprobe`.
2. `bun install`
3. `cp .env.example .env` and fill in:

```bash
QWEN_API_KEY=sk-sp-...
IG_USER=you@example.com
IG_PASS=your-password
# IG_TOTP_SECRET=...       only if the account uses an authenticator app
# AGENTMAIL_API_KEY=...    only if Instagram emails security codes
# AGENTMAIL_ADDRESS=...
```

4. `./bin/patronum status` tells you what is still missing.

Never commit `.env`. `bun run secrets:encrypt` and `bun run secrets:decrypt` keep an encrypted copy with age.

## Where your data goes

Everything Patronum collects or saves lives in one **home folder**, separate from the code:

```text
~/Documents/patronum/
  data/chrome-profile/           the saved Instagram login (cookies)
  data/profiles/<handle>-profile.json
  data/media/<handle>/           downloaded files, one folder per post
  data/<handle>-unique/          the best copy of each image and video
  data/analysis/<handle>/        what the model said about each file
  data/dbos/                     the job database and logs
  cache/                         remembered page controls and Instagram routes
```

To keep it somewhere else, set `PATRONUM_HOME` in `.env` or the environment. On a server, point it at the data volume:

```bash
PATRONUM_HOME=/srv/patronum
```

`./bin/patronum paths <handle>` lists one profile's files and whether each exists. `data/chrome-profile/` is your login: do not delete it to fix a slow sign-in. `cache/` is safe to delete; the next run rebuilds it.

---

## Commands

`./bin/patronum --help` lists everything. The ones you will use:

| Command | What it does |
| --- | --- |
| `./bin/patronum status` | Is everything set up? Shows the home folder, which credentials are present (never their values), tools, and whether the dashboard is running. |
| `./bin/patronum login` | Sign in to Instagram and save the cookies. `--keep-open` leaves Chrome open so you can finish a verification by hand; close it before running anything else. `--fresh-profile` wipes the saved login first. |
| `./bin/patronum session --check-only` | Is the saved login still good? `didLogin: false` means the cookies were reused. |
| `./bin/patronum preflight` | Ask the model one question to prove the key, model and quota work. No browser. |
| `./bin/patronum dashboard` | Build and open the dashboard at http://127.0.0.1:7799. |
| `./bin/patronum jobs`, `job <id>` | List jobs, or show one job's stages and a readable error. |
| `./bin/patronum profile <handle>` | What was collected for a profile and which later stages have run. |
| `./bin/patronum check <area>` | Run the tests for one part of the code. |

The older `bun run login`, `bun run session`, `bun run dash` and `go run ./cmd/igflow …` still work; `patronum` calls the same programs.

---

## Collecting a profile

Jobs are started, resumed and checked from the dashboard.

1. **Account → Check saved login.** If it has expired, **Sign in fresh** uses a separate Chrome profile and leaves the saved one alone; choose **Use this session for collection** once it checks out.
2. **Check readiness** tests the model connection.
3. **New collection:** enter the handle, a post limit, which media to keep, and what to do. The defaults are 30 posts, images, carousels and reels, and **Download media** without analysis.
4. Pick the job in the sidebar to see its stages: preflight, collect, verify, download, unique, analyze. Click a stage for its output and log.
5. **Cancel** stops a job. After fixing a failure, **Resume** keeps the finished stages and retries the rest.
6. **Results** shows the posts. **Update coverage** records which posts have media and analysis. **Export trinket box** copies the profile into an external OpenKnowledge wiki; install `ok` separately for that, and never turn this repository into a wiki.

Useful to know:

- **Whole profile:** raise the post limit above the account's post count and raise **Scroll rounds** in the advanced options.
- **Posts only:** **Images & carousels only** skips the Reels tab and video posts.
- **Model key expired:** leave **Download media** selected. Collection then skips analysis and the model checks.
- **Chrome left open after a failure:** **Account → Close inactive collection browser**. It will not interrupt a running job and it keeps your login.
- **Instagram rejects a request:** the job stops at the first rejection and keeps what it has. Wait before resuming. Do not switch accounts or reset credentials to get around it.

### When a job stops at once

| Problem | What you see | Fix, then Resume |
| --- | --- | --- |
| Instagram not signed in | error starts with `auth:` | `./bin/patronum login` |
| Model unavailable | error starts with `llm:` | fix `QWEN_API_KEY` or the plan; `./bin/patronum preflight` |
| Missing credentials | `missing env: IG_USER` | add them to `.env` |

### Exit codes

Collection, sign-in and the model check share one contract, which the job engine relies on:

| Code | Meaning | Retry? |
| --- | --- | --- |
| 0 | ok | – |
| 1 | failed: network, page changed, or Instagram rejected a request | yes, later |
| 2 | wrong arguments | no |
| 3 | Instagram is not signed in | no; sign in first |
| 4 | model key missing or rejected, model absent, or quota used up | no; fix the key |

A sign-in or model failure never overwrites a saved profile.

---

## When sign-in is slow or fails

Run `./bin/patronum preflight` first, then `./bin/patronum login`.

| What you see | Next step |
| --- | --- |
| Preflight exits 4 | Fix the key, model name, endpoint or quota it names. Deleting cookies will not help. |
| Preflight passes but login pauses before typing | Read the last progress line. Browser actions use the model separately from preflight. |
| Authenticator code requested | Set `IG_TOTP_SECRET`. |
| Email code requested | Set `AGENTMAIL_API_KEY` and `AGENTMAIL_ADDRESS`. Login reads the code Instagram sends after its own attempt. |
| Picture puzzle | `./bin/patronum login` tries it automatically; read the `[captcha]` lines. `--keep-open` lets you finish by hand. |
| Says success, then a collection hits a login wall | `./bin/patronum session --check-only`. A home page URL alone does not prove sign-in. |

**Image verification** in the dashboard lists saved puzzle captures and can run recognition on one. It proposes tile numbers and never clicks the saved capture. To use another vision provider set all three of `CAPTCHA_VISION_BASE_URL`, `CAPTCHA_VISION_API_KEY` and `CAPTCHA_VISION_MODEL`; a custom endpoint never receives the Qwen key.

If Instagram changes its login page and the remembered controls stop working, delete `cache/instagram-auth` in the home folder and sign in again. Keep `data/chrome-profile`.

---

## Saved/bookmarked dates

Instagram's `IGCrossAppSavesQuery` returns a `saved_time` for each saved post. The [query reference](./docs/reference/instagram-saved-timestamps.md) records the endpoint, variables, response fields and how to rediscover the query from an Android APK after a client update. There is no dashboard control for it yet. The original post's publication date is a different field.

Only when you explicitly want it, this reads the signed-in account's Explore recommendations and saves posts to its bookmarks. Give the real signed-in handle; there is no default:

```bash
./bin/patronum saved --account <handle> --inspect          # look only
./bin/patronum saved --account <handle> --target 2000      # saves posts: changes the account
./bin/patronum saved --account <handle> --reconcile-only   # confirm provisional saves after a rejection clears
```

It records each save under `data/bookmarks/` in the home folder and stops at the first Instagram rejection. Do not retry while Instagram still reports a limit.

---

## For developers

- **Code map:** `./bin/patronum map`, or the table in [README.md](./README.md). Agents use [AGENTS.md](./AGENTS.md).
- **Tests:** `./bin/patronum check` lists areas; `bun test src` and `go test ./...` run everything. Tests use a throwaway home folder, never yours.
- **Dashboard UI:** `bun run dash:dev` with the server running; `bun run dash:build` builds it; `bun run dash:serve` serves the last build.
- **Job engine:** `./bin/patronum flow doctor` must report `journalMode: wal`. Only one `run` or `resume` may hold the lock at a time; `list`, `status` and `steps` are always safe. See [durable jobs](./docs/reference/dbos-durable-workflows.md).
- **Logs:** `data/dbos/logs/<job-id>/` per job and `data/dbos/logs/_dash/igdash.log` for the dashboard, both in the home folder. Secrets are redacted.
- **Go debugger:** `make debug-setup` once, then `make debug-check`, `make debug-go` or `make debug-lldb`. `DEBUG_PACKAGE` and `DEBUG_TEST` pick another test.
- **Logos and icons:** `bun run brand`; see the [brand guide](./src/dashboard/brand/README.md).
- **Acceptance scenarios:** [dashboard scenarios](./docs/reference/dashboard-scenarios.md).
