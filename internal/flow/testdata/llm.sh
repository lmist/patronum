#!/usr/bin/env bash
# llm.sh: TypeScript CLIs exit 4 when Qwen/LLM preflight fails. Maps to
# CLIError{Retryable:false, Code:"llm"}.
set -u
echo '{"ok":false,"error":"llm"}'
exit 4
