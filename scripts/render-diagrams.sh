#!/usr/bin/env bash
# Render every docs/diagrams/src/*.mmd to docs/diagrams/*.svg with the
# project theme (dds-style: white bg, system font, bold labels, 4px strokes).
set -euo pipefail

cd "$(dirname "$0")/.."
DIA=docs/diagrams
MMDC="bunx --bun mmdc"

shopt -s nullglob
srcs=("$DIA"/src/*.mmd)
if [ ${#srcs[@]} -eq 0 ]; then
  echo "no .mmd sources in $DIA/src" >&2
  exit 1
fi

for src in "${srcs[@]}"; do
  name=$(basename "$src" .mmd)
  out="$DIA/$name.svg"
  echo "render $src -> $out"
  $MMDC \
    --input "$src" \
    --output "$out" \
    --configFile "$DIA/mermaid.config.json" \
    --puppeteerConfigFile "$DIA/puppeteer.config.json" \
    --backgroundColor '#ffffff' \
    --svgId "$name"
done
echo "done: ${#srcs[@]} diagram(s)"
