#!/usr/bin/env bash
# scrape-block.sh: sleep so a second job's scrape child stays ENQUEUED.
set -eu
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "scrape-start" >> "$IGFLOW_TEST_CALLS"
fi
sleep "${IGFLOW_TEST_SLEEP:-3}"
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "scrape-end" >> "$IGFLOW_TEST_CALLS"
fi
exec "$(dirname "$0")/scrape-ok.sh"
