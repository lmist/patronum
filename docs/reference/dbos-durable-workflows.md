---
title: DBOS durable workflows (igflow)
description: Invariants, skill map, and operating model for cmd/igflow on SQLite WAL.
tags:
  - dbos
  - igflow
  - durable
---
# DBOS durable workflows (igflow)

Durable Instagram scrape jobs run on the DBOS **Go** SDK (v1.3.0) with a **SQLite system database in WAL mode** at `data/dbos/patronum.sqlite` in the home folder (`PATRONUM_HOME`, default `~/Documents/patronum`). TypeScript Stagehand scrape is a subprocess step. This repo does not link `@dbos-inc/dbos-sdk` (Postgres-only).

Verification: `go run ./cmd/igflow doctor` must report `journalMode: "wal"`.

## Invariants

1. One host per Chrome profile. `igflow run` / `igflow resume` take `data/dbos/igflow.lock`. A second `run` for the same live handle attaches as a **client** (`RetrieveWorkflow` + `GetResult`) instead of stealing the lock.
2. Workflow ID is `ig:<handle>:<unix-seconds>` unless `--workflow-id` is given. Dedup ID is the handle on queue `ig-jobs` (`DeduplicationPolicyReturnExisting`).
3. Scrape is a **child workflow** on `ig-scrape` with global concurrency 1 (one Chrome at a time). Download / unique / analyze run as parent steps wrapping existing CLIs so `igflow resume` can retry a failed exec.
4. Fail closed before Chrome: missing Instagram cookies or LLM → job ERROR, igflow exit 5. Scrape-profile exit 3 = auth, 4 = llm (non-retryable).
5. Every derived path contains the handle (`data/profiles/<h>-profile.json`, `data/media/<h>/`, `data/<h>-unique/`, `data/analysis/<h>/`).
6. DBOS `ResumeWorkflow` skips SUCCESS and ERROR rows. `igflow resume <id>` on an ERROR job **forks** from the first failed step (new workflow id, copied successful steps).
7. Collection jobs finish after analysis and do not require OpenKnowledge. The retired Knowledge stage is marked skipped, including for legacy job inputs. Results offers an explicit OKF wiki export to an external folder; `--skip-kb` remains a deprecated compatibility flag.

## Commands

```bash
go run ./cmd/igflow run --handle <h> [--skip-reels] [--skip-download] [--skip-unique] [--skip-analyze] [--skip-kb]
go run ./cmd/igflow status <workflowId>
go run ./cmd/igflow list [--status error] [--handle <h>]
go run ./cmd/igflow steps <workflowId>
go run ./cmd/igflow resume <workflowId>
go run ./cmd/igflow cancel <workflowId>
go run ./cmd/igflow doctor
go run ./cmd/igflow gc --older-than 30d --dry-run
make igflow-recovery
```

Exit codes: 0 ok · 1 job failed · 2 usage · 3 host lock held (and nothing to attach) · 4 database error · 5 precondition (auth / llm / missing env or tool).

## Skill map

Vendored at `.claude/skills/dbos-golang/references/`:

| Concern | File |
| --- | --- |
| Config, SQLite URL, WAL | `lifecycle-config.md` |
| Child handles, recovery on Launch | `workflow-background.md` |
| Resume / cancel / fork | `workflow-control.md` |
| Timeouts | `workflow-timeout.md` |
| Determinism | `workflow-determinism.md` |
| Step retries | `step-retries.md` |
| Queue concurrency | `queue-concurrency.md` |
| Dedup | `queue-deduplication.md` |
| Events / streams | `comm-events.md`, `comm-streaming.md` |
| Client vs host | `client-setup.md` |
| Tests | `test-setup.md` |
| ApplicationVersion | `advanced-application-versions.md` |

Do not bump `ApplicationVersion` (`0.1.0`) without a decision. Changing it is a deployment event.

## Recovery

- Kill the host mid-scrape → relaunch with the same `--workflow-id` (or `resume`) → scrape step re-runs (`--resume` merges the TS checkpoint); later stages run once.
- A failed Knowledge publish resumes from that parent step; completed scrape and media stages are copied into the fork.
- `IGFLOW_TEST_CRASH_AFTER=<stage>` is a one-shot marker used by `make igflow-recovery`.
- Logs: `data/dbos/logs/<workflow-id>/<stage>.log`.
