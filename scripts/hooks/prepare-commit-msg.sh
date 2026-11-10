#!/usr/bin/env bash
# If BD_ISSUE is set, prefix the commit subject with the bead id.
set -euo pipefail
msg_file="${1:-}"
[[ -n "$msg_file" && -f "$msg_file" ]] || exit 0
[[ -n "${BD_ISSUE:-}" ]] || exit 0

# Skip merge/squash generated messages
kind="${2:-}"
case "$kind" in
  merge|squash|commit) exit 0 ;;
esac

subject="$(head -n1 "$msg_file")"
case "$subject" in
  "${BD_ISSUE}:"*|"${BD_ISSUE} "*) exit 0 ;;
esac

tmp="$(mktemp)"
{ printf '%s: %s\n' "$BD_ISSUE" "$subject"; tail -n +2 "$msg_file"; } >"$tmp"
mv "$tmp" "$msg_file"
