# Beads resolvers

For Instagram login, project commands, source files, and test selection, use the [project task and symptom resolvers](../AGENTS.md). This file covers the tracker only.

Agents do not follow a linear setup prompt. The world is not deterministic:
a clone may lack its repo-local `bd`, have a stale Homebrew `bd`, or have a
half-init `.beads/`. **Observe, then look up the row.** Apply only that row.

Source of work types: [beads workflows](https://beads.gascity.com/workflows)
and `bd types` on the repo-local binary (`./bin/bd`, currently **v1.2.1**).

Always invoke beads as:

```bash
export PATH="$PWD/bin:$PATH"    # or: ./scripts/bd <cmd>
bd <cmd> --json                 # machines
```

Never use `/opt/homebrew/bin/bd` or `~/.local/bin/bd` in this repo.

---

## 0. Session start

| You observe | Do this |
| --- | --- |
| No executable `bin/bd` | `make bd` (downloads the pinned release) |
| `bin/bd` exists, no `.beads/metadata.json` | `BD_NON_INTERACTIVE=1 ./bin/bd init --non-interactive --role maintainer -p pt --skip-agents --init-if-missing` |
| `.beads/` exists but `bd info` fails | `./bin/bd bootstrap --yes` (never `bd init --force`) |
| `bd` on PATH is not `./bin/bd` | `export PATH="$PWD/bin:$PATH"` and ignore the "multiple binaries" warning |
| Formulas missing / `bd formula list` empty | copy from git; then `./scripts/check-formulas.sh` |
| Hooks lack PATRONUM markers | `make hooks` |
| Database healthy | `bd prime` then `bd ready` — do **not** re-init |

Chicken-and-egg: you cannot pour a bead until `bin/bd` exists. That is the
only job of `scripts/bootstrap.sh`. After it succeeds, work lives in beads.

To (re)materialize the setup graph itself:

```bash
bd mol pour bootstrap-beads --var prefix=pt
bd ready --mol <id>
```

If an open issue already has label `bootstrap`, do not pour a second copy.

---

## 1. What kind of work is this?

Pick the **artifact** first (how it lives), then the **issue type** (what it is).

### Artifact resolver (workflows)

| You have | Artifact | Command | Do not |
| --- | --- | --- | --- |
| A one-line thought you must not lose | **todo** (task bead) | `bd todo add "…"` | markdown TODOs, Hermes `todo` tool as the system of record |
| A bug found while doing something else | **bug** + `discovered-from` | `bd create -t bug --deps discovered-from:<current>` | bury it in the current bead's notes |
| A user-facing slice of value | **story** | `bd create -t story` or pour `story` | inflate it into an epic on day one |
| New capability, multi-step, will recur | **formula** → **molecule** | write `.beads/formulas/X.formula.toml`, then `bd mol pour X` | re-plan the DAG by hand every time |
| Same shape, no audit value (patrol, health) | **wisp** | `bd mol wisp X` or `bd create --ephemeral` | expect it on plain `bd ready` — wisps are hidden there |
| Anything we must explain later | **pour** (persistent molecule) | `bd mol pour X` | wisp it |
| Large body with children | **epic** / molecule root | `bd create -t epic` or pour | put all the work on the epic itself |
| Timeboxed unknown | **spike** | pour `spike` | open an unbounded research epic |
| "Should we do X this way?" | **decision** | pour `decision` | a Slack thread |
| Maintenance, deps, tooling | **chore** | pour `chore` or `bd create -t chore` | disguise it as a feature |
| Something broken | **bug** | pour `bug` | a task named "fix …" |
| New functionality | **feature** | pour `feature` | a pile of untitled tasks |
| Named completion line, no work of its own | **milestone** | `bd create -t milestone` | stuff implementation into it |
| Waiting on a **person** | **human gate** | `[steps.gate] type = "human"` or `bd gate create --type=human --blocks <id>` | a fake "wait" task an agent will claim |
| Waiting on a **clock** | **timer gate** | `[steps.gate] type = "timer"` `timeout = "30m"` (literal, no `d` unit) | `timeout = "{{var}}"` — it becomes zero |
| Waiting on **CI / PR** | **gh:run / gh:pr gate** | `[steps.gate] type = "gh:run"` | poll in a loop |
| Waiting on **another bead** | **bead gate** (v1.2.1) | `[steps.gate] type = "bead"` | a `needs` edge to work outside this graph |
| Waiting on **another step in this graph** | **needs** | `needs = ["design"]` | a gate |
| Repeatable release / review / feature pipeline | **formula** | author, `bd formula show --json`, then pour | trust the TOML you typed — trust `--json` |

### Issue type resolver (`bd types`)

| Type | Use when | Default priority | Formula |
| --- | --- | --- | --- |
| `bug` | Broken behavior, regression | 1 | `bug` |
| `feature` | New capability | 2 | `feature` |
| `task` | Tests, docs, refactor, glue | 2 | (todo, or a step inside a molecule) |
| `chore` | Tooling, deps, repo hygiene | 3 | `chore` |
| `epic` | Span of children, no single diff | 2 | (root of a poured formula) |
| `story` | User-visible slice | 2 | `story` |
| `spike` | Timeboxed investigation | 2 | `spike` |
| `decision` | ADR that other work should cite | 2 | `decision` |
| `milestone` | A finish line, contains no work | 2 | — |

Priority: `0` critical, `1` high, `2` medium, `3` low, `4` backlog.

### Persistence resolver

| Need | Use |
| --- | --- |
| Survives clones, PRs, blame | `bd mol pour` / normal beads |
| Throwaway operational loop | `bd mol wisp` / `--ephemeral` |
| Template others will instantiate | formula file in `.beads/formulas/` + optional `bd cook --persist` proto |
| Session scratch | nothing — if it matters, it is a bead |

---

## 2. How to start work

| You observe | Do this |
| --- | --- |
| `bd ready` shows a real step (not `gate` / `molecule`) | `bd update <id> --claim` |
| Ready list is a gate titled `Gate: human` | **do not claim it** — `bd human` / wait for `bd gate resolve` |
| Ready list is a timer/gh gate | `bd gate check` then re-read ready |
| Only wisps exist and `bd ready` is empty | `bd todo` or `bd ready --mol <wisp-root>` |
| Nothing ready, things blocked | `bd blocked` — file a bead or resolve a gate; do not invent parallel work |
| You discovered extra work | `bd create … --deps discovered-from:<current>` then keep going |
| Two beads are the same | `bd duplicate <loser> <winner>` |

Claim is required before a non-trivial commit. The extra pre-commit hook
enforces this. Bypass with `PATRONUM_SKIP_CLAIM=1` or `BD_ISSUE=<id>`.

### Molecule ready filter

`bd ready --mol <id>` lists the **root** and **gates** as ready. Filter:

```bash
bd ready --mol <id> --json | python3 -c "
import sys, json
d = json.load(sys.stdin)
skip = {'gate', 'molecule'}
items = d.get('steps') or d.get('issues') or d
if isinstance(items, dict):
    items = items.get('issues') or items.get('steps') or []
for s in items:
    i = s.get('issue', s)
    t = i.get('issue_type') or i.get('type')
    if t in skip: continue
    print(i.get('priority'), i.get('id'), i.get('title'))
"
```

---

## 3. Formula authoring (when you add a workflow)

Mandatory loop — unknown TOML keys are dropped in silence:

```bash
bd formula show <name> --json     # what the parser kept
bd mol pour <name> --dry-run      # what would actually be created
./scripts/check-formulas.sh
```

| Rule | Why |
| --- | --- |
| `formula` + `version >= 1` required | validation fails otherwise |
| Step `type` is `task\|bug\|feature\|epic\|chore` | anything else becomes `task` silently (`human` is not a type) |
| Human waits are `[steps.gate]` on the **previous** `[[steps]]` | `[steps.foo.gate]` is ignored |
| `needs = ["earlier"]` means this step **requires** earlier | `bd dep add <this> <that>` — dependent first |
| `{{var}}` substitutes in title/description/notes/assignee/gate `await_id` | **not** in `labels` or gate `timeout` |
| Loop vars use `{n}` (single braces) | not `{{n}}` |
| `condition` is evaluated at pour, not cook | preview with `--dry-run`, not `bd cook` |
| If step B must not run when optional A is skipped | give B the **same** `condition`, do not rely on `needs = ["A"]` |

Search paths: `.beads/formulas/` (this repo), then `~/.beads/formulas/`.

---

## 4. Session close

This repo is conservative about git: **do not push** unless the user asked
and `origin` exists.

| Step | Command |
| --- | --- |
| File leftovers | `bd create` / `bd todo add` |
| Close finished work | `bd close <id> --reason "…"` |
| Unclaim abandoned | `bd unclaim <id>` |
| Persist an insight | `bd remember "…" --key <slug>` |
| Quality | `make doctor` if you touched formulas/hooks |
| Git | report `git status`; commit only if asked |
| Handoff | next ready id + one sentence of context |

Do not use `bd edit`. Use `bd update --description=-` via stdin for messy text.

---

## 5. Upgrade beads

Pinned: **`gastownhall/beads` release v1.2.1**.

| You want | Do |
| --- | --- |
| Reinstall current pin | `make bd` |
| Move the pin | `make BEADS_VERSION=<tag> bd` and update `BEADS_VERSION` in the Makefile |
| After any binary change | `make hooks` (shims mention the version) |

---

## 6. File map

| Path | Role |
| --- | --- |
| `scripts/install-bd.sh` | downloads and verifies the pinned release artifact |
| `bin/bd` | verified release binary (gitignored) |
| `scripts/bd` | wrapper that refuses PATH fallback |
| `scripts/bootstrap.sh` | pre-bd resolver |
| `.beads/formulas/` | the workflows |
| `docs/RESOLVERS.md` | this file |
| `AGENT_INSTRUCTIONS.md` | beads agent contract |
| `AGENTS.md` | Patronum resolver map (plus beads pointer) |
