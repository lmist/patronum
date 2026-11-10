---
title: Patronum product
description: Local Instagram collection workflows and product constraints.
---
# Product

## Platform

web

## Users

A local operator selects an Instagram profile and collects its media, analysis, and client knowledge. The [task resolver](./AGENTS.md) and [human guide](./HUMANS.md) define the supported workflows.

## Product Purpose

Patronum authenticates an Instagram account in local Chrome, collects a requested profile, downloads and deduplicates media, and analyzes content. The operator can optionally export a collected profile to a separate OKF wiki. Success means visible completion and readable outputs through the dashboard. See the [app operation contract](./AGENT_INSTRUCTIONS.md).

## Capabilities and Constraints

The [dashboard server](./src/dashboard/server.ts) controls account checks, isolated login profiles, collection launch, resume, cancel, saved-grid recognition, and cleanup preview. Bun serves the app; Go owns durable jobs. Every launch requires an explicit handle. All media types are included by default; download-only collections skip analysis and LLM readiness checks. Wiki export is an explicit action in Results and targets a separate folder. Credentials and browser profiles remain local. Results represent the latest files for a handle, not immutable per-run snapshots.

## Product Principles

- Preserve collection identity through navigation, reload, and recovery.
- Separate command completion from durable workflow completion.
- Put recovery beside its failure and keep full logs available.
- Preview cleanup before deleting history.

## Brand Commitments

Use the Vivid unity reference described in [the visual system](./DESIGN.md). Product terms and controls come from Patronum; no social, chat, billing, or medical features are inferred.

The Patronum logo is the Reliquary mark from Brilliant thistle in Paper: the capped variant is primary and the pointed variant is retained as an alternate. `bun run brand` regenerates the icons from `src/dashboard/brand/paper.svg`.
