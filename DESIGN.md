---
title: Patronum visual system
name: Patronum
description: Vivid unity tokens, materials, and responsive interface rules.
colors:
  primary: "#ffffff"
  background: "#111113"
  foreground: "#f5f5f5"
  card: "#ffffff0e"
  border: "#ffffff12"
  muted-foreground: "#b5b5bd"
  accent: "#a5b8ff"
  destructive: "#ffaaaa"
  success: "#9bdbb8"
  warning: "#ead091"
  input: "#55555e"
  composer: "#0a0a0a"
  composer-border: "#262626"
  header-surface: "#292b40"
typography:
  display:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: 1.75rem
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -.032em
  headline:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: 1.375rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -.025em
  title:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: 1rem
    fontWeight: 600
  body:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: .875rem
    lineHeight: 1.65
  label:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: .75rem
    fontWeight: 500
  reader:
    fontFamily: '"Inter Variable", Inter, system-ui, sans-serif'
    fontSize: .9375rem
    lineHeight: 1.8
rounded:
  sm: .75rem
  md: 1rem
  lg: 1.5rem
  xl: 2rem
  composer: 1.75rem
  pill: 9999px
spacing:
  field: 8px
  actions: 10px
  compact: 12px
  group: 16px
  inset: 20px
  stack: 24px
  surface: 25px
  graph: 32px
components:
  navigation:
    textColor: "{colors.foreground}"
---
# Design System: Patronum

## Overview

**Creative North Star: "Vivid unity"**

Vivid unity places clear Inter typography and white actions over a near-black canvas with blue and violet ambient light. Translucent surfaces carry that light into the workspace; their broad corners keep dense operational content calm. The visual authority is this document, implemented in the [dashboard stylesheet](./src/dashboard/web/styles.css).

Collections, recovery, and reading share this material language. The [product commitments](./PRODUCT.md) preserve explicit collection identity and visible workflow outcomes; the [dashboard surface](./src/dashboard/DESIGN.md) places those behaviors in the interface.

**Key Characteristics:**

- Document-height blue and violet ambient light.
- Translucent cards with broad corners and a shallow blue wash.
- White pill actions, readable muted text, and named status states.
- Inter for interface and reading, with larger and more open reader text.

## Colors

White is the primary action color. Blue and violet establish atmosphere, while blue also marks focus and running work. The palette and state assignments come from the [stylesheet](./src/dashboard/web/styles.css).

### Primary

White actions create the strongest contrast. The pale blue accent identifies interactive focus, reading links, and running progress.

### Neutral

Near-black canvas and composer surfaces anchor translucent cards. Foreground text carries primary information; muted foreground supports metadata without lowering its opacity. The header uses its solid slate surface, separate from the ambient canvas.

### Status

Success green, warning gold, and error pink supplement readable state labels. The [status component](./src/dashboard/web/components/feedback.tsx) pairs state text with an SVG icon.

**The Continuous Light Rule.** Keep ambient gradients attached to the document canvas so their scale follows the full page height. The two upper-corner radial gradients retain the Paper colors, 12% starting opacity, and transparent end stops. Their full expressions live in the [stylesheet](./src/dashboard/web/styles.css).

## Typography

Inter Variable is the shared interface and reading face, with Inter and system sans fallbacks. The [entry point](./src/dashboard/web/main.tsx) loads the font; the [stylesheet](./src/dashboard/web/styles.css) defines the hierarchy.

Workspace page titles use the display tier so the selected collection or section outranks the cards beneath it. Headlines are compact and semibold, titles step down to body-adjacent size, and labels form a smaller supporting tier. Body copy stays open enough for operational descriptions. Reader prose is larger, uses a more generous line height, and stops at 70ch. Logs use the browser's monospace face. Tabular numerals stabilize counts and durations.

## Layout

The desktop frame has a sticky header (68px), fixed jobs sidebar (304px), and flexible main workspace. The workspace has broad side insets (40px), a maximum content width (1180px), and a regular vertical stack (20px). The sidebar's job list scrolls independently; surfaces use content-driven heights. The [app layout](./src/dashboard/web/App.tsx) and [responsive stylesheet](./src/dashboard/web/styles.css) define these relationships.

**The Recovery Beside Status Rule.** Keep completion and recovery actions with the selected job heading, before its state machine or results. From 901px through 1100px, the sidebar narrows to 264px. At 900px and below, it becomes a collapsible Jobs list above the workspace; selecting a job closes the list, focuses the workspace, and returns the page to the top. At 560px and below, the state graph becomes vertical. At 540px and below, form columns stack. The supported canvas starts at 320px. See [sidebar behavior](./src/dashboard/web/state/sidebar.ts) and [selection behavior](./src/dashboard/web/state/app.tsx).

## Elevation & Depth

Depth combines translucent tonal layers, ambient light, and soft feed-card shadows. The header is solid; the composer is a darker inset surface. The [surface styles](./src/dashboard/web/styles.css) define the material, gradients, and shadows.

**The Shallow Light Rule.** Feed-card light fades within the top 128px; the rest of the card remains translucent. Feed surfaces use a vertical blue gradient with 18%, 9%, and transparent stops, plus two soft black shadows. Do not replace this treatment with a radial card glow or flatten the document ambient field into a viewport-sized layer.

## Shapes

Broad card corners, a slightly tighter composer and reader, rounded media windows, and pill actions make the recurring silhouettes. Fields and small controls use tighter corners. Thin translucent borders describe surface edges without competing with text. Media is contained inside its frame and keeps its complete content visible. See the [shape and media styles](./src/dashboard/web/styles.css).

## Components

The reusable controls are defined in [button](./src/dashboard/web/components/ui/button.tsx), [input](./src/dashboard/web/components/ui/input.tsx), and [surface styles](./src/dashboard/web/styles.css).

- **Buttons:** White primary, translucent secondary, quiet ghost, outline, error-tinted destructive, and underlined link variants. Shared buttons maintain 44px minimum targets; secondary and ghost states gain tonal emphasis on hover. Focus has a visible accent ring, and disabled controls become dimmer.
- **Fields:** Dark fill, visible neutral stroke, compact rounded corners, and labels above. Form fields retain a 44px minimum height; phone input text grows to 1rem. Selects drop the platform arrow for a muted chevron, and checkboxes are rounded squares that fill white with a dark check, matching the primary action.
- **Disclosures:** Text disclosures share one chevron that turns a quarter when the section opens; platform markers are hidden.
- **Count chips:** Small outlined pills beside collection headings. They communicate quantity without becoming a competing action. Result counts reuse the same pill.
- **Stat tiles:** Post coverage reads as a row of bordered tiles with a large tabular number over a small label. Complete takes the success color; partial, pending, and failed take warning or error only when their count is above zero.
- **Segmented controls:** The sidebar sections and the Results / State machine switch share one pill-shaped track. The current segment gains a brighter translucent fill and a hairline inset stroke.
- **Navigation:** Jobs, Account, and Diagnostics share the sidebar with New collection, search, and selectable job rows. Job rows lead with a round status chip tinted by state and end with the run duration; rows are separated by space, not rules. The selected job gains a blue tint and inset stroke. **The Label First Rule.** Keep navigation text labels and 44px targets at every width. See the [navigation implementation](./src/dashboard/web/App.tsx).
- **Feed cards:** Translucent surfaces use the shallow light treatment, generous insets, contained media, and wrapping actions. The [results surface](./src/dashboard/web/features/results/Results.tsx) keeps captions and artifacts together.
- **State machine:** Nine nodes form a three-by-three snake: Queued, six collection stages, the legacy Knowledge stage, and Complete. Knowledge is skipped by collection jobs; wiki export is a separate Results action. Stage nodes use rounded rectangles; terminals use broader corners. Each node carries a faint two-digit step number so the order stays legible where the snake reverses. Color and text distinguish state: finished states take a shallow success tint and their outgoing connector turns green, unreached states recede, a dashed edge marks skipped stages, and an accent outline marks selection. Above the graph, a seven-segment stage meter mirrors the stage count beside the job heading. Error and cancellation branches remain beneath the graph. **The State to Evidence Rule.** Selecting a stage updates its output inspector and activity log together. See the [graph model](./src/dashboard/web/features/progress/fsm.ts), [graph surface](./src/dashboard/web/features/progress/Progress.tsx), and [inspector behavior](./src/dashboard/web/features/progress/use-progress.ts).
- **Reader:** A bounded dialog with fixed header and independently scrolling body. Its content is loaded on demand; closing returns focus to the opening control. Markdown uses the reader type tier, structured data remains legible, and original files remain available. See the [reader](./src/dashboard/web/features/reader/Reader.tsx), [reader state](./src/dashboard/web/features/reader/use-reader.tsx), and [deferred results reader](./src/dashboard/web/features/results/Results.tsx).

- **Error banner:** Recovery advice leads in foreground text beside an alert icon; the raw error follows in smaller monospace so the next step reads before the stack detail.

Color transitions and the slight pressed-button movement provide restrained feedback. Running work is the only continuous motion: its stage dot and meter segment pulse, and loading icons spin. The reduced-motion rule removes transitions and animations. Source: [motion styles](./src/dashboard/web/styles.css).

## Do's and Don'ts

These guardrails follow the [product principles](./PRODUCT.md), [app structure](./src/dashboard/web/App.tsx), and [visual implementation](./src/dashboard/web/styles.css).

### Do:

- Do preserve the document-height ambient field and the solid header surface.
- Do keep recovery with the selected job heading and its status.
- Do let cards grow with their content and keep original media contained.
- Do preserve visible keyboard focus and return reader focus to its opener.
- Do preserve graph order when the state machine stacks vertically.

### Don't:

- Don't infer workflow completion from a connected header indicator.
- Don't replace navigation labels with icons at narrow widths.
- Don't crop collection media to force equal-height cards.
- Don't apply decorative motion when reduced motion is requested.
