# Patronum

Sign one Instagram account in on a local Chrome, collect a profile's posts, download the media, keep the best copy of each file, and describe it with a vision model. A local dashboard starts the jobs and shows the results.

This repository is a template. There is no default client: every collection names the handle it is for.

## Quick start

```bash
bun install
cp .env.example .env          # fill in QWEN_API_KEY, IG_USER, IG_PASS
./bin/patronum status         # says what is still missing
./bin/patronum login          # sign in once; cookies are saved
./bin/patronum dashboard      # http://127.0.0.1:7799 — start a collection here
```

`./bin/patronum --help` lists every command. People read [HUMANS.md](./HUMANS.md); agents start at [AGENTS.md](./AGENTS.md).

## Where things are

| Place | What is in it |
| --- | --- |
| this repository | code, `node_modules`, `.env` |
| the home folder | everything Patronum collects or saves: profiles, media, analysis, the job database, logs, the saved login |

The home folder is `~/Documents/patronum`. Set `PATRONUM_HOME` to put it somewhere else, for example a data volume on a server. `./bin/patronum paths <handle>` shows the files for one profile.

## Code map

`./bin/patronum map` prints this with the file to read first in each folder.

```text
src/sign-in      get one Instagram account logged in and prove it
src/collect      read a profile and list every post (start at collect-profile.ts)
src/saved        the signed-in account's bookmarks
src/api-map      record which Instagram routes and page controls exist
src/browser      open and close local Chrome safely
src/llm          which model to use and whether it answers
src/export       copy a finished profile into an external wiki
src/dashboard    the local web app that starts jobs and shows results
src/cmd          commands: flags, help, exit codes
src/paths.ts     where every file lives on disk
cmd/, internal/  Go: durable jobs, download, unique, analyze
```

## Checks

```bash
./bin/patronum check                 # list the areas
./bin/patronum check types collect   # run the tests for some of them
bun test src && go test ./...        # everything
```
