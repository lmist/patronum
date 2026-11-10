#!/usr/bin/env bash
# crash.sh: emits noise then exits non-zero with no tail JSON. Simulates
# a mid-run crash so exec_test.go can assert the retryable branch.
set -u
echo "about to crash" 1>&2
echo "no json here either"
exit 137
