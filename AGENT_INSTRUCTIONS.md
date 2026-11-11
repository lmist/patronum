# Agent instructions

This is the Beads tracking contract. Start in the [project task resolver](./AGENTS.md) for login, scraping, media, and durable jobs. Read this file when creating or claiming work; use the [Beads resolvers](./docs/RESOLVERS.md) when tracker setup or workflow structure needs attention.

This repo tracks work in **bd (beads)**. The generic `bd init` AGENTS block
is not enough here. Read this file, then look up rows in
[docs/RESOLVERS.md](docs/RESOLVERS.md). Do not invent a parallel tracker.

```bash
export PATH="$PWD/bin:$PATH"
bd prime
bd ready
```

`./bin/bd` is the `gastownhall/beads` **v1.2.1** release binary, installed by
mise and linked into place by `make bd`.
`./scripts/bd` execs that binary and refuses to fall through to Homebrew.

## Why this is not a prompt

Setup is not a linear checklist. Clones arrive in different states. The
replacement for "paste this prompt into a new agent" is:

1. Observe (`./scripts/bootstrap.sh` prints the observation).
2. Apply the matching row in `docs/RESOLVERS.md`.
3. Pour `bootstrap-beads` if setup work still needs a graph.
4. After that, `bd ready` is the prompt.

## Non-negotiables

- Drive the app so the app drives jobs to completion. Follow the [mandatory app-driven operation rule](./AGENTS.md#app-driven-job-operation--mandatory): diagnose with logs and read-only tools, repair code and test it, then use the dashboard UI to launch, retry, recover, and verify completion. Fix missing app controls instead of bypassing them with standalone stages or direct action API calls. Direct CLI operation requires an explicit user request.

- Use `bd` for all task tracking. No markdown TODOs as the system of record.
- Create or claim a bead **before** writing code.
- Never claim a bead whose type is `gate` or `molecule`. Filter them out.
- Never use `bd edit` (opens `$EDITOR`). Use `bd update` flags or `--description=-`.
- `bd dep add <this> <that>` means **this depends on that**.
- Persist insights with `bd remember`, not MEMORY.md.
- Do not commit `bin/bd` (platform-specific). Relink with `make bd`.
- Do not `git push` unless the user asked and `origin` exists.
- Prefer non-interactive flags (`cp -f`, `rm -f`, `BD_NON_INTERACTIVE=1`).

## Starting work

| Situation | Move |
| --- | --- |
| Ready real issue | `bd update <id> --claim` |
| Ready is a human gate | wait / `bd gate resolve` — do not claim |
| Nothing ready | `bd blocked` then file or unblock; do not freelance |
| Found extra work | `bd create … --deps discovered-from:<id>` |
| Repeatable multi-step | pour a formula from `.beads/formulas/` |
| One-shot patrol | `bd mol wisp …` and drive it with `--mol` |

Full tables: issue types, artifacts (formula/proto/molecule/wisp/gate/todo),
formula authoring, upgrades — `docs/RESOLVERS.md`.

## Formulas in this repo

| Formula | Pour when |
| --- | --- |
| `bootstrap-beads` | making beads work in a checkout |
| `feature` | new capability |
| `bug` | something broken |
| `story` | user-visible slice |
| `spike` | timeboxed unknown |
| `decision` | ADR |
| `chore` | tooling / deps / hygiene |
| `release` | version cut |
| `patrol` | ephemeral health loop (wisp this) |

```bash
bd formula list
bd formula show feature --json
bd mol pour feature --var name=… --dry-run
bd mol pour feature --var name=…
```

## Session close

1. `bd close` finished work; `bd create` leftovers.
2. `bd remember` anything the next session will need.
3. `make doctor` if you touched formulas or hooks.
4. Report `git status`. Commit only if asked. Never push unprompted.
