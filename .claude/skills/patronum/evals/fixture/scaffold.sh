#!/bin/sh
# Build the workspace one eval agent runs in. The runner starts this script
# with the agent's (empty) workspace as the working directory, outside the
# sandbox; the agent itself cannot read the real repository.
#
# The workspace becomes a small copy of the checkout: the patronum command,
# the source it needs, the agent-facing docs, and a fixture home folder with
# made-up jobs and profiles. No real data and no real credentials go in.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../../../../.." && pwd)
work=$(pwd)

mkdir -p bin node_modules
cp "$repo/bin/patronum" bin/patronum
cp "$repo/package.json" "$repo/tsconfig.json" "$repo/README.md" "$repo/HUMANS.md" "$repo/AGENTS.md" "$repo/CLAUDE.md" .
# Source without tests, the web UI or build output.
(cd "$repo" && find src -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' \) \
  ! -name '*.test.ts' ! -path 'src/dashboard/web/*' ! -path 'src/dashboard/dist/*' ! -path 'src/dashboard/.test-*' -print) |
  while IFS= read -r file; do mkdir -p "$(dirname "$file")"; cp "$repo/$file" "$file"; done
# The inspect commands need only these two packages.
cp -R "$repo/node_modules/dotenv" "$repo/node_modules/zod" node_modules/

bun "$repo/.claude/skills/patronum/evals/fixture/make-home.ts" "$work/home" >/dev/null

# Fixture settings: a home inside the workspace, placeholder Instagram
# credentials, and no model key (the readiness case expects that gap).
cat > .env <<ENV
PATRONUM_HOME=$work/home
IG_USER=fixture_account
IG_PASS=fixture-password-do-not-print
LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
QWEN_API_KEY=
DASHSCOPE_API_KEY=
ALIBABA_API_KEY=
ENV
