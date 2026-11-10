# Diagrams

Mermaid sources live in `src/*.mmd`; committed SVGs live here so GitHub
renders them without client-side Mermaid.

## Render

```bash
bun run diagrams        # or: make diagrams
```

Renders every `src/*.mmd` to `docs/diagrams/<name>.svg` via
`@mermaid-js/mermaid-cli` (`mmdc`, a devDependency; runs through
`bunx --bun mmdc`). Puppeteer uses the system Chrome at
`/Applications/Google Chrome.app` (see `puppeteer.config.json`), so no
bundled Chromium download is needed.

## Style

`mermaid.config.json` pins the house look (borrowed from the dds
`phx-envelope-fsm` diagram):

- white background, system font stack (`-apple-system, Segoe UI, ...`)
- bold 18px node labels, bold edge labels, slate-900 text (`#0f172a`)
- 4px node borders and edges, pastel fills with saturated strokes

Per-node palette (use `classDef` in each `.mmd`, see `src/session-fsm.mmd`):

| class  | fill      | stroke    | meaning (convention)    |
|--------|-----------|-----------|-------------------------|
| blue   | `#93c5fd` | `#3b82f6` | entry / initial         |
| green  | `#bbf7d0` | `#22c55e` | success / steady state  |
| purple | `#d8b4fe` | `#8b5cf6` | processing              |
| cyan   | `#a5f3fc` | `#06b6d4` | read / output           |
| amber  | `#fde68a` | `#f59e0b` | warning / manual step   |
| red    | `#fecaca` | `#ef4444` | terminal / destructive  |

Color the edges to match their source semantics with `linkStyle` (indices
follow edge declaration order). Dashed edges (`-.->`) mark exceptional or
manual paths.

## Add a diagram

1. Create `src/<name>.mmd` (start by copying `src/session-fsm.mmd`).
2. `bun run diagrams`.
3. Commit both the `.mmd` and the generated `.svg`.
4. Embed in docs with `![<title>](docs/diagrams/<name>.svg)`.
