#!/usr/bin/env bash
# scrape-loginwall.sh: non-retryable auth failure (exit 3).
set -u
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "scrape" >> "$IGFLOW_TEST_CALLS"
fi
echo '{"ok":false,"error":"auth","reason":"login wall"}'
exit 3
