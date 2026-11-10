#!/usr/bin/env bash
set -eu
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "verify" >> "$IGFLOW_TEST_CALLS"
fi
echo '{"ok":true,"real":true,"evidence":"fixture verify"}'
