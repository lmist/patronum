#!/usr/bin/env bash
set -euo pipefail
marker=${IGFLOW_TEST_ANALYZE_FAIL_ONCE:?}
if [[ ! -e "$marker" ]]; then
  : > "$marker"
  if [[ -n "${IGFLOW_TEST_CALLS:-}" ]]; then printf 'iganalyze\n' >> "$IGFLOW_TEST_CALLS"; fi
  printf '{"ok":false,"error":"llm","reason":"fixture first analysis failed"}\n'
  exit 4
fi
exec bash "$(dirname "$0")/iganalyze-ok.sh"
