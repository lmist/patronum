#!/usr/bin/env bash
set -eu
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "igunique" >> "$IGFLOW_TEST_CALLS"
fi
handle="${IGFLOW_TEST_HANDLE:-fixture}"
dir="${IGFLOW_TEST_OUT:-}"
if [ -z "$dir" ]; then
  root="${IGFLOW_REPO_ROOT:-.}"
  dir="$root/data/${handle}-unique"
fi
mkdir -p "$dir"
cat > "$dir/manifest.json" <<EOF
{"username":"${handle}","out":"${dir}","count_videos":1,"count_stills":2,"files":[{"dest":"a.mp4","kind":"video"},{"dest":"b.jpg","kind":"image"}],"stills":[{"dest":"a.jpg","kind":"still"},{"dest":"b2.jpg","kind":"still"}]}
EOF
printf '{"ok":true,"dir":"%s","unique":4,"videos":1,"stills":2,"images":1}\n' "$dir"
