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

Jobs belong to a local server, which `run`, `resume` and `cancel` start on demand; `./bin/patronum server status` shows it and `./bin/patronum server stop` stops it. Only one browser job runs at a time: if the server answers that a browser action is already running, wait for that job rather than starting another.

## Where data is

Collected data, the job database, logs and the saved login are in the **home folder**, not the repository: `PATRONUM_HOME`, default `~/Documents/patronum`. `status` shows which is in use. Relative paths such as `data/profiles/...` are inside the home folder, not the repository. When someone asks where a file is, answer with the absolute path from `paths --json`; do not hard-code either location.

## Do: these start a real program

| Need | Command | Note |
| --- | --- | --- |
| Prove the model key works | `./bin/patronum preflight` | no browser; exit 4 names the problem |
| Check the saved Instagram login | `./bin/patronum session --check-only` | runs Chrome, hidden |
| Sign in | `./bin/patronum login` | runs Chrome, hidden; saves cookies |
| Collect a profile | `./bin/patronum run <handle> --max 30 --wait` | add `--analyze` to describe the media; exit 0 when the job finished |
| Retry a failed job | `./bin/patronum resume <job-id> --wait` | restarts at the step that failed |
| Stop a running job | `./bin/patronum cancel <job-id>` | |
| Watch jobs and browse results | `./bin/patronum dashboard` | http://127.0.0.1:7799; its buttons do the same as the three commands above |

Exit codes are the same everywhere: `0` ok, `1` failed (retry later), `2` usage, `3` Instagram sign-in, `4` model.

## Whether a Chrome window appears

Chrome runs hidden by default, from the command line and from the dashboard. A window opens only when a person has to act or asks for it:

| Case | Window |
| --- | --- |
| `./bin/patronum login --keep-open`, or "Complete verification" in the dashboard | always shown; it is for finishing a checkpoint by hand |
| "Show Chrome while collecting" ticked in the New collection form | shown for that job |
| `HEADLESS=false` in `.env` | shown for every command-line run and for the dashboard's sign-in checks |

If a hidden sign-in stops at a checkpoint, do not retry it hidden: use `login --keep-open` so the person can complete it.

## Rules

1. **Jobs go through the server.** Use `run`, `resume` and `cancel` (or the dashboard's buttons, which send the same requests). Do not run `./bin/patronum collect`, `download`, `unique`, `analyze`, `map-api`, `flow run` or `flow resume` to get a job through unless the user explicitly asked for that single stage. Reading is always fine: `jobs`, `job`, `profile`, `flow list`, `flow status`, `flow doctor`.
2. **`saved --target` changes the Instagram account.** Use `saved --inspect` unless the user asked for saves.
3. **One browser at a time.** Commands that open Chrome share one saved login. Do not run two of them together.
4. **Stop on an Instagram rejection.** Do not retry in a loop, switch accounts or reset credentials to get around it.
5. **Do not delete `data/chrome-profile`** to fix a slow sign-in. Run `preflight` first; a model problem is not a cookie problem.
6. **An unknown command exits 2 and suggests the nearest name.** Use `./bin/patronum <command> --help` rather than guessing flags.
