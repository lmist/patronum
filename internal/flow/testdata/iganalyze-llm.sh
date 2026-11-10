#!/usr/bin/env bash
set -u
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "iganalyze" >> "$IGFLOW_TEST_CALLS"
fi
echo '{"ok":false,"error":"llm","reason":"quota 2056"}'
exit 4
