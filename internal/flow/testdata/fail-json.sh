#!/usr/bin/env bash
# fail-json.sh: exits 1 but prints a well-formed tail JSON marking a
# deliberate CLI failure (login wall). Exercises the non-retryable
# branch driven by ok:false.
set -u
echo "diagnostic pre-json line" 1>&2
echo '{"ok":false,"error":"login wall detected"}'
exit 1
