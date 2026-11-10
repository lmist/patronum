#!/usr/bin/env bash
set -eu
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "igdl" >> "$IGFLOW_TEST_CALLS"
fi
handle="${IGFLOW_TEST_HANDLE:-fixture}"
dir="${IGFLOW_TEST_OUT:-}"
if [ -z "$dir" ]; then
  root="${IGFLOW_REPO_ROOT:-.}"
  dir="$root/data/media/${handle}"
fi
mkdir -p "$dir"
cat > "$dir/manifest.json" <<EOF
{"username":"${handle}","outDir":"${dir}","total":3,"ok":3,"skipped":0,"failed":0,"results":[],"byUrl":{}}
EOF
printf '{"ok":true,"dir":"%s","downloaded":3,"skipped":0,"failed":0,"attempted":3}\n' "$dir"
