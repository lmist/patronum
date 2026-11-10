---
title: Dashboard end-to-end scenarios
description: Acceptance scenarios for authentication, complete runs, recovery, results, and dashboard usability.
tags: [dashboard, testing]
---

# Dashboard end-to-end scenarios

Use a dedicated test directory for failure injection and a separate Chrome profile for cold login. Keep the normal saved session intact. A fixture pass validates the application contract; it does not prove that Instagram or the analysis provider accepted a live request.

## Acceptance scenarios

| Scenario | Dashboard actions | Expected result |
| --- | --- | --- |
| Cold login | Start an isolated login; inspect its activity; finish any requested verification | Authentication has explicit success or failure evidence. The normal saved session remains intact. |
| Warm login | Check the saved session | Authentication succeeds without entering credentials again. Expired authentication leads to a visible recovery action. |
| Blocked login | Exercise rejected credentials, expired cookies, and a verification checkpoint | No scrape starts while authentication is unproven. The reason, next action, and relevant log are visible. Rejected credentials are not repeatedly submitted. |
| Complete small run | Enter an explicit client, set the post limit to 3, run all stages | Readiness, scrape, verification, download, deduplication, and analysis complete without OpenKnowledge. Results belong to the selected client. |
| Optional wiki export | In Results, choose an external OKF wiki and click Export trinket box | The exported snapshot contains that profile's media, captions, analysis, and coverage. Repository files remain ordinary files. |
| Failed readiness | Use a missing/rejected provider key or unavailable session | Failure appears before scraping, names the failed requirement, and offers a recovery path. |
| Cancel and resume | Cancel active work; recover a failed or interrupted run | Cancellation reaches the subprocess. Resume retains completed checkpoints and re-executes the failed work. |
| Duplicate launch and reload | Double-click Run; reload during work; restart the dashboard | One operation launches. Current work and recorded launch outcomes remain discoverable. |
| Inspect results and logs | Open a completed run, per-post media, analysis, wiki, and each stage's log | Results are readable without opening a terminal. Logs distinguish stage, attempt, time, output, and failure; secrets are redacted. |
| Readability and accessibility | Use keyboard controls and a 390px-wide viewport; inspect loading, empty, error, and success states | Labels and status remain legible, focus is visible, controls fit the viewport, and errors do not depend on color alone. |

## Evidence

Browser assertions live in [dashboard UI tests](../../src/dashboard/ui.test.ts). HTTP contracts live in [dashboard server tests](../../src/dashboard/server.test.ts). Durable interruption and checkpoint behavior are exercised by [workflow recovery tests](../../cmd/igflow/recovery_test.go).

Record live outcomes separately from fixtures, including the selected profile, run identifier, terminal stage, and any external verification needed. Never include passwords, cookies, tokens, or verification codes in test reports.

## Verification evidence — 2026-09-06

- Live saved-session check: authenticated, `didLogin: false`.
- Live isolated cold login: one credential submission, then an image-selection reCAPTCHA Enterprise checkpoint. The saved session was preserved; the CAPTCHA was not submitted.
- [Durable dashboard integration](../../src/dashboard/durable.test.ts): actual dashboard HTTP actions, compiled Go workflow engine, and SQLite with fixture stage providers. A publish failure was resumed successfully; completed scrape/download/deduplication/analysis work ran once, and publishing ran twice. The recovered run retained its client and all seven completion states.
- Local stage logging: subprocess fixtures cover retries, cancellation, timeouts, startup errors, secret redaction, and output larger than 4 MiB. Focused race tests passed.

A fixture result is not a claim of live CAPTCHA recognition accuracy or a completed live Instagram collection.

## Image recognition checks

[Recognition tests](../../src/sign-in/captcha/recognition.test.ts) cover malformed observations, out-of-range or duplicate tile indices, stale/repeated observations, replacement scope, time limits, abstention, and secret-free diagnostics. [Capture tests](../../src/sign-in/captcha/capture.test.ts) include an opt-in real-browser nested-frame fixture; capture never clicks controls.

The direct Qwen adapter matched the expected selected set for three public fixture grids. The assembled 4×4 fixture is not a continuous-photo fragment challenge. Public validation tiles come from a dataset associated with the local classifier, so overlap with its training data is unknown. Local inference abstained on both 3×3 samples. The default remains Qwen.

The dashboard browser suite passed 14 scenarios with 76 assertions, including the saved-grid recognition control, proposal display, and diagnostic download using a fixture backend. Separately, the real dashboard recognition action called Qwen on the public 4×4 fixture and matched the expected set in 14.8 seconds. No live CAPTCHA was submitted.
