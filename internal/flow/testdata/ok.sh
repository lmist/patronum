#!/usr/bin/env bash
# ok.sh: prints a couple of chatter lines then a tail JSON with ok:true.
# Used by exec_test.go to verify success classification and log tee.
set -eu
echo "scrape starting ${1:-unnamed}"
echo "scrape progress halfway" 1>&2
echo '{"ok":true,"path":"data/profiles/x-profile.json","counts":{"posts":3,"reels":1,"mediaUrls":9}}'
