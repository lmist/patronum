#!/usr/bin/env bash
# empty.sh: exits 0 without a tail JSON marker. exec.go treats this as
# a contract violation (non-retryable) — a deploy bug, not a flake.
set -u
echo "hello"
echo "world" 1>&2
