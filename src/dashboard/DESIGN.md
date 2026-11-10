---
title: Dashboard surface
description: Collection workspace layout, control destinations, and reading behavior.
target: src/dashboard/web
---
# Dashboard

## Direction

Keep an explicit collection at the center of collection, recovery, and reading. The [product](../../PRODUCT.md) defines the workflow and identity constraints. [Vivid unity](../../DESIGN.md) supplies Inter, near-black surfaces, broad translucent cards, white pill actions, and continuous blue/violet light.

The workspace sequence is job selection or collection creation, state-machine inspection, results, and reading. Recovery stays beside the selected job's status. The [app shell](./web/App.tsx) keeps Jobs, Account, Diagnostics, New collection, search, and parent job rows together in a persistent sidebar. Selecting a job opens its State machine; Results remains available as a secondary view. See [selection behavior](./web/state/selection.ts) and [job filtering](./web/features/collections/use-collections.ts).

## Layout and adaptation

The desktop frame uses a sticky header (68px), fixed jobs sidebar (304px), and flexible main workspace with no right context column. The sidebar's job rows scroll independently. New collection opens the composer in the main workspace; with no selection, the composer and a job-selection prompt are visible. See the [app shell](./web/App.tsx) and [collection controls](./web/features/collections/Collections.tsx).

From 901px through 1100px, the sidebar narrows to 264px. At 900px and below, the Jobs list becomes collapsible above the workspace. Selecting a job closes it, focuses the workspace, and scrolls to the page top. Navigation retains text labels and 44px targets. At 560px and below, the state graph becomes vertical; at 540px and below, form fields stack. Sources: [responsive styles](./web/styles.css), [sidebar state](./web/state/sidebar.ts), and [selection actions](./web/state/app.tsx).

The header keeps its solid slate color (RGB 41, 43, 64). The ambient gradients scale over document height. Feed cards retain translucent surfaces, broad corners, and a blue linear wash restricted to their top 128px. Shared tokens and material rules live in the [visual system](../../DESIGN.md); exact values live in the [stylesheet](./web/styles.css).

## Control destinations

| Controls | Destination | Implementation |
| --- | --- | --- |
| Job search, count, stable selection, keyboard selection | Jobs sidebar | [Collections](./web/features/collections/Collections.tsx) |
| Map Instagram APIs; result, log, and stop | Composer Troubleshooting; Account activity | [Composer](./web/features/collections/Collections.tsx), [mapping action](../cmd/map-network.ts), [Account](./web/features/account/Account.tsx) |
| Handle, post limit, media types, download or AI analysis | New collection composer | [Composer](./web/features/collections/Collections.tsx) |
| Saved-list retry, login session, concurrency, timeout | Collection settings | [Composer](./web/features/collections/Collections.tsx) |
| Saved login, fresh login, readiness, complete verification, current fresh session, stop browser | Account | [Account](./web/features/account/Account.tsx) |
| Action history, result, hint, log, download | Account activity | [Account](./web/features/account/Account.tsx) |
| Saved grid, model, refresh, preview, recognize, diagnostic download | Account image verification | [Verification](./web/features/verification/Verification.tsx) |
| State graph, stage output, steps, internals, selected step, error, child workflow | State machine and inspector | [Progress](./web/features/progress/Progress.tsx) |
| Resume, cancel, parent and recovery links | Job heading and State machine | [Shell](./web/App.tsx), [Progress](./web/features/progress/Progress.tsx) |
| Stage log, follow latest, download | State machine live activity | [Progress](./web/features/progress/Progress.tsx) |
| Post coverage, missing-media reasons, standalone trinket export | Results | [Coverage and export](./web/features/results/CoverageExport.tsx) |
| Media, analysis, wiki, all files, original files | Results and reader | [Results](./web/features/results/Results.tsx), [Reader](./web/features/reader/Reader.tsx) |
| Age, keep errors, cleanup preview, delete listed history, debug log | Diagnostics | [Diagnostics](./web/features/diagnostics/Diagnostics.tsx) |
| Refresh, connection, host, queues, last update | Header and Diagnostics | [Shell](./web/App.tsx), [Diagnostics](./web/features/diagnostics/Diagnostics.tsx) |

## States and reading

The state machine presents nine ordered nodes: Queued, six collection stages plus the legacy Knowledge stage, and Complete. Desktop follows a three-by-three snake with directional connectors; narrow screens preserve the same sequence in one vertical column. Error and cancellation branches describe alternate outcomes. Knowledge is skipped by collection jobs and retained for historical results. The stage nodes are selectable; selecting one updates its output inspector, execution-step selection, and stage log. Queue and Complete are terminal displays. Sources: [state model](./web/features/progress/fsm.ts), [State machine](./web/features/progress/Progress.tsx), and [inspector state](./web/features/progress/use-progress.ts).

Status pairs a label with an icon or stage marker. Request errors remain distinct from empty results, and previously loaded data remains visible during reconnection. Header connectivity describes the connection; collection status describes durable work. See [feedback](./web/components/feedback.tsx), [app state](./web/state/app.tsx), and the [workflow server](./server.ts).

The reader is deferred until an artifact is opened. It has an explicit close action, returns focus to its opener, and scrolls content within a bounded dialog. Markdown, structured data, images, and playable video share this reading surface. The original file remains available. See [Results](./web/features/results/Results.tsx), [Reader](./web/features/reader/Reader.tsx), and [reader state](./web/features/reader/use-reader.tsx).

Media is locally served collection data. Results show the latest artifacts for the selected handle, as defined by the [product constraints](../../PRODUCT.md) and [results resolver](./results.ts). The visual system frames this content without cropping it into uniform cards; see [media styles](./web/styles.css).

## Collection setup

The main form asks for the handle, post limit, media types, and goal. Defaults are 30 posts, all media, and download without analysis. Collection settings groups discovery versus saved-list retry, login session, and explicit limits: two browser tabs, four parallel downloads, two parallel analyses when enabled, and 30 minutes. Troubleshooting contains browser visibility, login rechecking, the analysis-mode LLM check override, and API mapping. Pipeline stage-skip switches remain CLI controls. Field errors appear beside their inputs and focus the first invalid field, opening its disclosure when necessary. The [form model](./web/features/collections/collection-form.ts) owns defaults, validation, and payload mapping.
