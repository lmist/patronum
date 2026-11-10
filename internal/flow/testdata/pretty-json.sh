#!/usr/bin/env bash
# pretty-json.sh: what `bun src/cmd/cli.ts preflight` actually prints on success
# (JSON.stringify(payload, null, 2)). lastJSONLine used to keep only the
# first "{" line and then classify as "exit 0 but no tail JSON".
set -eu
cat <<'EOF'
{
  "ok": true,
  "llm": {
    "model": "openai/qwen3.8-max",
    "baseUrl": "https://example.invalid/v1",
    "status": 200,
    "kind": "ok",
    "reason": "ok",
    "latencyMs": 12
  }
}
EOF
