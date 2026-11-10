#!/usr/bin/env bash
# auth.sh: TypeScript CLIs exit 3 to declare a login wall. exec.go must
# route this to CLIError{Retryable:false, Code:"auth"} regardless of
# whether a tail JSON is present.
set -u
echo '{"ok":false,"error":"auth"}'
exit 3
