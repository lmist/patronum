#!/usr/bin/env bash
# After checkout/merge, remind the agent to reclaim or inspect ready work.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
export PATH="$ROOT/bin:$PATH"
[[ -x "$ROOT/bin/bd" && -f "$ROOT/.beads/metadata.json" ]] || exit 0
echo "patronum: bd ready (post-checkout)" >&2
"$ROOT/bin/bd" ready 2>/dev/null | head -20 >&2 || true
exit 0
