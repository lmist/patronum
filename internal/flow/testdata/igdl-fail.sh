#!/usr/bin/env bash
# Non-retryable download failure used by resume-from-ERROR recovery.
set -u
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "igdl" >> "$IGFLOW_TEST_CALLS"
fi
echo '{"ok":false,"error":"download refused"}'
exit 1
