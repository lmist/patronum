# patronum

`./bin/patronum` is the one command for this repository. Run it as `./bin/patronum` from the project directory you are already working in; do not `cd` to another checkout, including the folder a skill file was loaded from. Reach for it before reading source or calling the underlying programs.

## Start

```bash
./bin/patronum status --json      # ready? where is data kept? what is missing? what to do next
./bin/patronum commands --json    # every command: usage, examples, side effects
```

`status` reports credentials by presence only. Never print `.env` or a credential value.

## Look first: these only read local files

Add `--json` to any of them for one JSON document on stdout.

| Question | Command |
| --- | --- |
| Is this checkout set up? What should I do next? | `./bin/patronum status --json` (read `next`) |
| Which jobs ran? Which failed? | `./bin/patronum jobs --status ERROR --json` |
| Why did this job fail, and at which stage? | `./bin/patronum job <id> --json` (read `error`, `currentStage`, `logs`) |
| What was collected for a handle? Is it finished? | `./bin/patronum profile <handle> --json` |
| Where are a handle's files? Do they exist? | `./bin/patronum paths <handle> --json` (each entry has an `absolute` path; give that one) |
| What is each source folder for? Where do I start reading? | `./bin/patronum map` |
| Which tests cover the code I changed? | `./bin/patronum check` to list areas, then `./bin/patronum check <area>...` |

A handle is the bare name: `some_handle`, not `@some_handle` and not a URL.

To diagnose a failed job: `jobs --status ERROR --json`, then `job <id> --json`. Report the stage and the error text. Read the log folder it names only if the error is not enough.

## Where data is

Collected data, the job database, logs and the saved login are in the **home folder**, not the repository: `PATRONUM_HOME`, default `~/Documents/patronum`. `status` shows which is in use. Relative paths such as `data/profiles/...` are inside the home folder, not the repository. When someone asks where a file is, answer with the absolute path from `paths --json`; do not hard-code either location.

## Do: these start a real program

| Need | Command | Note |
| --- | --- | --- |
| Prove the model key works | `./bin/patronum preflight` | no browser; exit 4 names the problem |
| Check the saved Instagram login | `./bin/patronum session --check-only` | opens Chrome |
| Sign in | `./bin/patronum login` | opens Chrome; saves cookies |
| Open the dashboard | `./bin/patronum dashboard` | http://127.0.0.1:7799 |

Exit codes are the same everywhere: `0` ok, `1` failed (retry later), `2` usage, `3` Instagram sign-in, `4` model.

## Whether a Chrome window appears

| Started from | Window |
| --- | --- |
| A collection in the dashboard | hidden, unless "Show Chrome while collecting" is ticked in the form |
| The dashboard's Account page (check saved login, sign in, complete verification) | always shown, so a person can step in |
| The command line (`login`, `session`, `collect`, `map-api`) | shown, unless `.env` has `HEADLESS=true` |
| `./bin/patronum login --keep-open` | always shown; it is for finishing a verification by hand |

When someone asks to keep the browser out of their way, set `HEADLESS=true` in `.env` and say that the Account page still shows a window. Do not turn it on to get past a verification: a checkpoint needs the visible window.

## Rules

1. **Jobs go through the dashboard.** Starting, resuming, retrying and cancelling a collection are done in the dashboard UI. Do not run `./bin/patronum collect`, `flow run`, `flow resume`, `download`, `unique`, `analyze` or `map-api` to operate a job unless the user explicitly asked for direct command-line operation. Reading is always fine: `jobs`, `job`, `profile`, `flow list`, `flow status`, `flow doctor`.
2. **`saved --target` changes the Instagram account.** Use `saved --inspect` unless the user asked for saves.
3. **One browser at a time.** Commands that open Chrome share one saved login. Do not run two of them together.
4. **Stop on an Instagram rejection.** Do not retry in a loop, switch accounts or reset credentials to get around it.
5. **Do not delete `data/chrome-profile`** to fix a slow sign-in. Run `preflight` first; a model problem is not a cookie problem.
6. **An unknown command exits 2 and suggests the nearest name.** Use `./bin/patronum <command> --help` rather than guessing flags.
