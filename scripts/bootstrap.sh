#!/usr/bin/env bash
# Pre-bd entry point. Observe the repo, apply the matching resolver row,
# then pour (or refresh) the bootstrap-beads molecule.
#
# This script exists because you cannot pour a bead until bd exists.
# After it succeeds, agents work from `bd ready`, not from this file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PREFIX="${PREFIX:-pt}"

log() { printf 'bootstrap: %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

observe() {
  echo "=== observe ==="
  echo "cwd=$ROOT"
  echo "git=$(git rev-parse --is-inside-work-tree 2>/dev/null || echo no)"
  echo "bin/bd=$([ -x bin/bd ] && bin/bd version 2>/dev/null | head -1 || echo missing)"
  echo "beads_db=$([ -f .beads/metadata.json ] && echo yes || echo no)"
  echo "formulas=$(ls .beads/formulas/*.formula.toml 2>/dev/null | wc -l | tr -d ' ')"
  echo "hooks_path=$(git config --get core.hooksPath || echo unset)"
}

ensure_git() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "git already present"
    return 0
  fi
  log "git init"
  git init -b main
}

ensure_binary() {
  if [[ -x bin/bd ]]; then
    log "bin/bd already present: $(bin/bd version 2>/dev/null | head -1)"
    return 0
  fi
  log "installing bin/bd from the pinned release"
  make bd
}

ensure_init() {
  export PATH="$ROOT/bin:$PATH"
  if [[ -f .beads/metadata.json ]]; then
    log "beads already initialized"
    BD_NON_INTERACTIVE=1 bin/bd bootstrap --yes >/dev/null || true
    return 0
  fi
  log "bd init --prefix $PREFIX"
  BD_NON_INTERACTIVE=1 BD_ACTOR="${BD_ACTOR:-bootstrap}" \
    bin/bd init --non-interactive --role maintainer -p "$PREFIX" --skip-agents
}

ensure_hooks() {
  export PATH="$ROOT/bin:$PATH"
  bin/bd hooks install
  "$ROOT/scripts/install-extra-hooks.sh"
}

ensure_formulas() {
  mkdir -p .beads/formulas
  if [[ ! -f .beads/formulas/bootstrap-beads.formula.toml ]]; then
    log "bootstrap formula missing — this checkout is incomplete"
    return 1
  fi
  "$ROOT/scripts/check-formulas.sh"
}

pour_bootstrap() {
  export PATH="$ROOT/bin:$PATH"
  if bin/bd formula show bootstrap-beads >/dev/null 2>&1; then
    # Do not pour a second copy if an open bootstrap molecule already exists.
    existing="$(bin/bd list --status open --label bootstrap --json 2>/dev/null || echo '[]')"
    if echo "$existing" | grep -q '"id"'; then
      log "open bootstrap work already exists; not pouring another"
      bin/bd ready || true
      return 0
    fi
    log "pouring bootstrap-beads"
    bin/bd mol pour bootstrap-beads --var "prefix=$PREFIX" --json
  else
    log "formula bootstrap-beads not visible"
    return 1
  fi
}

observe
ensure_git
ensure_binary
ensure_init
ensure_hooks
ensure_formulas
pour_bootstrap
observe
log "done. next: PATH=\"$ROOT/bin:\$PATH\" bd ready"
