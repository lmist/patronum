#!/usr/bin/env bash
# Install Patronum the way a new user does and check what they see.
#
#   scripts/fresh-install-check.sh [source]
#
# Clones `source` (default: this checkout, so the committed HEAD) into a temp
# folder, then runs the quick start with an empty .env, a throwaway
# PATRONUM_HOME and a spare dashboard port. Nothing touches your real home
# folder or Instagram: the one job it starts fails at preflight for want of
# credentials, which is the point.
#
# Every assertion is named. On failure the clone is kept for inspection.
# Also reachable as: patronum check fresh-install
set -uo pipefail

SOURCE="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WORK="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/patronum-fresh.XXXXXX")" && pwd)"
CLONE="$WORK/patronum"
PORT="${FRESH_INSTALL_PORT:-17799}"
URL="http://127.0.0.1:$PORT"
failures=()
passes=0

# A new user has none of these.
unset LLM_API_KEY LLM_BASE_URL LLM_MODEL LLM_MODEL_BROWSER LLM_MODEL_VISION LLM_MODEL_VIDEO LLM_VIDEO_FORMAT QWEN_API_KEY DASHSCOPE_API_KEY ALIBABA_API_KEY IG_USER IG_PASS IG_PASSWORD IG_TOTP_SECRET \
  INSTAGRAM_USER INSTAGRAM_PASS INSTAGRAM_TOTP_SECRET AGENTMAIL_API_KEY AGENTMAIL_ADDRESS \
  IGDASH_ROOT IGDASH_DB IGFLOW_REPO_ROOT PATRONUM_CHROME_PROFILE_DIR DBOS_SYSTEM_DATABASE_URL
export PATRONUM_HOME="$WORK/home" IGDASH_PORT="$PORT"

pass() { passes=$((passes + 1)); printf '  ok    %s\n' "$1"; }
fail() { failures+=("$1"); printf '  FAIL  %s\n        %s\n' "$1" "${2:-}"; }
# check NAME COMMAND...: passes when the command succeeds.
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name" "failed: $*"; fi; }
# run COMMAND...: sets $out (stdout+stderr) and $code.
run() { out="$("$@" 2>&1)"; code=$?; }
has() { grep -qE -- "$1" <<<"$out"; }
p() { ./bin/patronum "$@"; }

stop_dashboard() {
  local pids; pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] && kill $pids 2>/dev/null
  [[ -n "${dashboard_pid:-}" ]] && kill "$dashboard_pid" 2>/dev/null
  return 0
}
trap stop_dashboard EXIT

echo "Fresh install of $SOURCE"
echo "  clone $CLONE"
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is in use; set FRESH_INSTALL_PORT to a free one" >&2; exit 2
fi

echo "Install"
check "git clone" git clone --quiet "$SOURCE" "$CLONE"
cd "$CLONE" || exit 1
check "bun install" bun install
check "cp .env.example .env" cp .env.example .env

echo "README and .env.example"
check "README quick start begins with git clone" grep -q 'git clone https://github.com/lmist/patronum.git' README.md
check "README quick start enters the folder" grep -qE '^cd patronum' README.md
check "README tells contributors about direnv allow" grep -q 'direnv allow' README.md
check ".env.example offers the model endpoint and per-role models" bash -c "grep -q '^LLM_API_KEY=' .env.example && grep -q '^LLM_BASE_URL=' .env.example && grep -q 'LLM_MODEL_VIDEO' .env.example && grep -q 'LLM_VIDEO_FORMAT' .env.example"
check ".env.example marks the AgentMail keys optional" bash -c "grep -B3 '^#* *AGENTMAIL_ADDRESS=' .env.example | grep -qi optional"

echo "status"
run p status --json
[[ $code -eq 0 ]] && pass "status exits 0" || fail "status exits 0" "exit $code"
[[ "$(jq -r '.ready' <<<"$out")" == false ]] && pass "status says not ready" || fail "status says not ready" "$out"
[[ "$(jq -r '.home.path' <<<"$out")" == "$PATRONUM_HOME" ]] && pass "status uses the throwaway home" || fail "status uses the throwaway home" "$(jq -r '.home.path' <<<"$out")"
jq -e '.tools | has("bd")' <<<"$out" >/dev/null && pass "status still reports tools.bd" || fail "status still reports tools.bd"
if jq -r '.next[]' <<<"$out" | grep -qiE '\bbd\b|beads'; then fail "status next does not mention bd" "$(jq -c '.next' <<<"$out")"; else pass "status next does not mention bd"; fi
jq -r '.next[]' <<<"$out" | grep -q 'LLM_API_KEY' && pass "status next names the missing model key" || fail "status next names the missing model key"

echo "commands"
run p commands; listing="$out"
run p --help; overview="$out"
[[ "$listing" != "$overview" ]] && pass "commands differs from --help" || fail "commands differs from --help" "identical output"
missing=""
while IFS=$'\t' read -r name usage example; do
  grep -qF -- "$usage" <<<"$listing" || missing+=" usage:$name"
  grep -qF -- "$example" <<<"$listing" || missing+=" example:$name"
done < <(p commands --json | jq -r '.commands[] | [.name, .usage, .examples[0]] | @tsv')
[[ -z "$missing" ]] && pass "commands shows every usage line and an example" || fail "commands shows every usage line and an example" "missing:$missing"
[[ "$(grep -ci 'side effects' <<<"$listing")" -ge "$(p commands --json | jq '.commands | length')" ]] && pass "commands shows side effects for every command" || fail "commands shows side effects for every command"
check "commands --json is one JSON document" bash -c "./bin/patronum commands --json | jq -e '.ok and (.commands | length > 15)'"

echo "help text"
for name in collect login session preflight; do
  run p "$name" --help
  [[ $code -eq 0 ]] && ! has 'bun run|scrape-profile —|bun src/' && has "patronum $name" \
    && pass "$name --help uses the patronum name" || fail "$name --help uses the patronum name" "$(grep -nE 'bun run|scrape-profile —|bun src/' <<<"$out" | head -3)"
done

for name in saved map-api captcha; do
  run p "$name" --help
  [[ $code -eq 0 ]] && has "patronum $name" && ! has 'bun src/|map-network|^error:|at .*\.ts:[0-9]+' \
    && pass "$name --help exits 0 and uses the patronum name" || fail "$name --help exits 0 and uses the patronum name" "exit $code: $(head -3 <<<"$out")"
done
for name in saved map-api; do
  run p "$name" --no-such-option
  [[ $code -eq 2 ]] && has "patronum $name" && ! has 'at .*\.ts:[0-9]+|map-network' \
    && pass "$name with a bad option exits 2 without a stack trace" || fail "$name with a bad option exits 2 without a stack trace" "exit $code: $(head -3 <<<"$out")"
done
for name in download unique analyze; do
  run p "$name" -h
  grep -qE "^Usage: patronum $name" <<<"$out" && ! has 'go-build|scrape-profile' \
    && pass "$name -h uses the patronum name" || fail "$name -h uses the patronum name" "$(grep -nE 'Usage|go-build|scrape-profile' <<<"$out" | head -3)"
done

echo "exit codes with nothing set up"
run p preflight
[[ $code -eq 4 ]] && pass "preflight exits 4 without a model key" || fail "preflight exits 4 without a model key" "exit $code"
[[ "$(grep -E '^\{' <<<"$out" | tail -1 | jq -r '.kind')" == missing-key ]] && pass "preflight says the key is missing" || fail "preflight says the key is missing" "$out"
(
  # The old Qwen names still select the key, endpoint and model. Port 9 is closed: no request leaves the machine.
  export QWEN_API_KEY=k QWEN_BASE_URL=http://127.0.0.1:9/v1 QWEN_MODEL=old-model
  legacy="$(p preflight 2>/dev/null | grep -E '^\{' | tail -1)"
  [[ "$(jq -r '[.roles.browser.model, .roles.video.model, .roles.browser.baseUrl, .videoFormat] | join(" ")' <<<"$legacy")" == "openai/old-model openai/old-model http://127.0.0.1:9/v1 file" ]]
) && pass "QWEN_* settings still work when LLM_* is unset" || fail "QWEN_* settings still work when LLM_* is unset"
(
  export LLM_API_KEY=k LLM_BASE_URL=http://127.0.0.1:9/v1 LLM_MODEL=one LLM_MODEL_VIDEO=two QWEN_MODEL=old-model
  roles="$(p preflight 2>/dev/null | grep -E '^\{' | tail -1)"
  [[ "$(jq -r '[.roles.browser.model, .roles.vision.model, .roles.video.model] | join(" ")' <<<"$roles")" == "openai/one openai/one openai/two" ]]
) && pass "LLM_MODEL_<ROLE> overrides LLM_MODEL, which overrides QWEN_MODEL" || fail "LLM_MODEL_<ROLE> overrides LLM_MODEL, which overrides QWEN_MODEL"
run p session
[[ $code -eq 3 ]] && pass "session exits 3 without Instagram credentials" || fail "session exits 3 without Instagram credentials" "exit $code"
json="$(grep -E '^\{' <<<"$out" | tail -1)"
[[ "$(jq -r '.error' <<<"$json" 2>/dev/null)" == auth ]] && pass "session reports error auth" || fail "session reports error auth" "$json"
hint="$(jq -r '.hint' <<<"$json" 2>/dev/null)"
[[ "$hint" == *IG_USER* && "$hint" == *IG_PASS* && "$hint" != *Chrome* ]] && pass "session hint names IG_USER and IG_PASS, not Chrome" || fail "session hint names IG_USER and IG_PASS, not Chrome" "$hint"
run p job nope --json
[[ $code -eq 1 && "$(jq -r '.error' <<<"$out" 2>/dev/null)" == not_found ]] && pass "job <unknown id> exits 1 with not_found" || fail "job <unknown id> exits 1 with not_found" "exit $code: $out"
run p jobs --status NOPE
[[ $code -eq 2 ]] && has 'ERROR' && pass "jobs rejects an unknown --status" || fail "jobs rejects an unknown --status" "exit $code: $out"
run p jobs --status error
[[ $code -eq 0 ]] && pass "jobs accepts a lower-case --status" || fail "jobs accepts a lower-case --status" "exit $code: $out"
run p jobs
[[ $code -eq 0 ]] && pass "jobs exits 0 with no database" || fail "jobs exits 0 with no database" "exit $code"
run p bogus
[[ $code -eq 2 ]] && pass "an unknown command exits 2" || fail "an unknown command exits 2" "exit $code"

echo "tests"
check "check cli llm" ./bin/patronum check cli llm

echo "dashboard and a job with no credentials"
./bin/patronum dashboard >"$WORK/dashboard.log" 2>&1 &
dashboard_pid=$!
for _ in $(seq 1 60); do curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1 && break; sleep 1; done
check "dashboard answers on its port" curl -fsS -m 3 "$URL/api/health"
check "dashboard serves the app" bash -c "curl -fsS -m 3 '$URL/' | grep -qi '<!doctype html>'"
[[ "$(p status --json | jq -r '.dashboard.running')" == true ]] && pass "status sees the dashboard" || fail "status sees the dashboard"
started="$(curl -sS -m 10 -X POST "$URL/api/run" -H 'content-type: application/json' -H "origin: $URL" -d '{"handle":"fresh_install_check"}')"
id="$(jq -r '.workflowId // empty' <<<"$started" 2>/dev/null)"
[[ -n "$id" ]] && pass "dashboard starts a job" || fail "dashboard starts a job" "$started"
status=""
for _ in $(seq 1 120); do
  status="$(p job "$id" --json 2>/dev/null | jq -r '.job.status // empty' 2>/dev/null)"
  [[ "$status" == ERROR || "$status" == SUCCESS || "$status" == CANCELLED ]] && break
  sleep 1
done
job="$(p job "$id" --json 2>/dev/null)"
[[ "$status" == ERROR && "$(jq -r '.currentStage' <<<"$job")" == preflight ]] && pass "the job fails at preflight" || fail "the job fails at preflight" "status=$status stage=$(jq -r '.currentStage' <<<"$job" 2>/dev/null)"
error="$(jq -r '.error // ""' <<<"$job")"
[[ "$error" == *IG_USER* && "$error" == *LLM_API_KEY* ]] && pass "the job error names the missing variables" || fail "the job error names the missing variables" "$error"
if grep -qE 'igflow|bun run' <<<"$error"; then fail "the job error uses no internal names" "$error"; else pass "the job error uses no internal names"; fi
grep -qi 'dashboard' <<<"$error" && pass "the job error points at the dashboard" || fail "the job error points at the dashboard" "$error"
[[ "$(jq -c '[.stages[].name]' <<<"$job")" == '["preflight","scrape","verify","download","unique","analyze"]' ]] && pass "the job view lists the six stages" || fail "the job view lists the six stages" "$(jq -c '[.stages[].name]' <<<"$job")"
stop_dashboard; sleep 1
if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then fail "nothing is left on the dashboard port"; else pass "nothing is left on the dashboard port"; fi

echo "Beads for contributors"
if command -v mise >/dev/null 2>&1; then
  run make bd
  [[ $code -eq 0 ]] && pass "make bd exits 0" || fail "make bd exits 0" "$out"
  [[ -L bin/bd && "$(readlink bin/bd)" == */mise/installs/* ]] && pass "bin/bd links into the mise installs folder" || fail "bin/bd links into the mise installs folder" "$(ls -l bin/bd 2>&1)"
  ./bin/bd version 2>/dev/null | head -1 | grep -q 'bd version 1\.2\.1' && pass "bin/bd is version 1.2.1" || fail "bin/bd is version 1.2.1" "$(./bin/bd version 2>&1 | head -1)"
  has 'permissions 0' && fail "make bd prints no .beads permission warning" "$(grep 'permissions' <<<"$out")" || pass "make bd prints no .beads permission warning"
else
  echo "  skip  mise is not installed"
fi
[[ ! -e scripts/install-bd.sh ]] && ! grep -rqs --exclude=fresh-install-check.sh 'install-bd' Makefile scripts docs ./*.md && pass "the old Beads download script is gone" || fail "the old Beads download script is gone"

echo "afterwards"
dirty="$(git status --short)"
[[ -z "$dirty" ]] && pass "the clone's working tree is clean" || fail "the clone's working tree is clean" "$dirty"
[[ ! -e "$HOME/Documents/patronum/data/dbos/logs/$id" ]] && pass "the real home folder was not used" || fail "the real home folder was not used"

echo
if ((${#failures[@]})); then
  echo "FAILED ${#failures[@]} of $((passes + ${#failures[@]})). Clone kept at $CLONE"
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
cd / && rm -rf "$WORK"
echo "PASSED $passes of $passes. Clone removed."
