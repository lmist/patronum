#!/usr/bin/env bash
# scrape-flaky.sh: first call exits 1 with no JSON (retryable); later calls
# succeed like scrape-ok.sh.
set -eu
n=0
if [ -n "${IGFLOW_TEST_CALLS:-}" ] && [ -f "$IGFLOW_TEST_CALLS" ]; then
  n=$(grep -c '^scrape$' "$IGFLOW_TEST_CALLS" || true)
fi
if [ -n "${IGFLOW_TEST_CALLS:-}" ]; then
  echo "scrape" >> "$IGFLOW_TEST_CALLS"
fi
if [ "$n" -lt 1 ]; then
  echo "transient scrape failure" >&2
  exit 1
fi
# Success path (do not exec scrape-ok.sh: that would double-count).
handle="${IGFLOW_TEST_HANDLE:-fixture}"
out="${IGFLOW_TEST_OUT:-}"
if [ -z "$out" ]; then
  root="${IGFLOW_REPO_ROOT:-.}"
  out="$root/data/profiles/${handle}-profile.json"
fi
mkdir -p "$(dirname "$out")"
cat > "$out" <<EOF
{
  "ok": true,
  "username": "${handle}",
  "partial": false,
  "notes": ["fixture scrape"],
  "session": {"didLogin": true, "account": "test@example.com"},
  "posts": [
    {"type": "image", "shortcode": "aaa111", "permalink": "https://www.instagram.com/p/aaa111/", "mediaUrls": ["https://cdn.example/a.jpg"], "thumbnailUrl": "https://cdn.example/t.jpg"},
    {"type": "carousel", "shortcode": "bbb222", "permalink": "https://www.instagram.com/p/bbb222/", "mediaUrls": ["https://cdn.example/b1.jpg", "https://cdn.example/b2.jpg"]}
  ],
  "reels": [],
  "stats": {"postCount": 2, "reelCount": 0, "mediaUrlCount": 3}
}
EOF
printf '{"ok":true,"path":"%s","counts":{"posts":2,"reels":0,"mediaUrls":3}}\n' "$out"
