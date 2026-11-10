#!/usr/bin/env bash
set -eu
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "iganalyze" >> "$IGFLOW_TEST_CALLS"
fi
handle="${IGFLOW_TEST_HANDLE:-fixture}"
dir="${IGFLOW_TEST_OUT:-}"
if [ -z "$dir" ]; then
  root="${IGFLOW_REPO_ROOT:-.}"
  dir="$root/data/analysis/${handle}"
fi
mkdir -p "$dir"
cat > "$dir/analysis.json" <<EOF
{"username":"${handle}","ok":2,"failed":0,"skipped":0,"total":2,"items":[{"status":"ok"},{"status":"ok"}]}
EOF
echo "fixture digest" > "$dir/style-digest.md"
printf '{"ok":true,"dir":"%s","analyzed":2,"failed":0,"skipped":0}\n' "$dir"
