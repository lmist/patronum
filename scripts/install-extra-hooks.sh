#!/usr/bin/env bash
# Inject patronum sections around the managed beads hook shims.
# Content outside BEGIN/END BEADS markers survives `bd hooks install`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS="$(git -C "$ROOT" config --get core.hooksPath || true)"
if [[ -z "$HOOKS" ]]; then
  HOOKS="$ROOT/.beads/hooks"
fi
if [[ ! -d "$HOOKS" ]]; then
  echo "install-extra-hooks: no hooks dir at $HOOKS" >&2
  exit 1
fi

PATH_BLOCK_BEGIN='# --- BEGIN PATRONUM PATH ---'
PATH_BLOCK_END='# --- END PATRONUM PATH ---'
CHECK_BLOCK_BEGIN='# --- BEGIN PATRONUM CHECKS ---'
CHECK_BLOCK_END='# --- END PATRONUM CHECKS ---'

path_block() {
  cat <<'EOF'
# --- BEGIN PATRONUM PATH ---
# Prefer the repo-local binary so hooks never pick Homebrew/PATH bd.
_bc_root=$(git rev-parse --show-toplevel 2>/dev/null) || _bc_root=
if [ -n "$_bc_root" ] && [ -x "$_bc_root/bin/bd" ]; then
  PATH="$_bc_root/bin:$PATH"
  export PATH
fi
# --- END PATRONUM PATH ---
EOF
}

check_block() {
  local hook="$1"
  cat <<EOF
# --- BEGIN PATRONUM CHECKS ---
_bc_root=\$(git rev-parse --show-toplevel 2>/dev/null) || _bc_root=
if [ -n "\$_bc_root" ] && [ -x "\$_bc_root/scripts/hooks/${hook}.sh" ]; then
  "\$_bc_root/scripts/hooks/${hook}.sh" "\$@" || exit \$?
fi
# --- END PATRONUM CHECKS ---
EOF
}

strip_block() {
  local file="$1" begin="$2" end="$3"
  awk -v b="$begin" -v e="$end" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    !skip {print}
  ' "$file"
}

for hook in pre-commit post-merge pre-push post-checkout prepare-commit-msg; do
  f="$HOOKS/$hook"
  [[ -f "$f" ]] || continue
  tmp="$(mktemp)"
  body="$(strip_block "$f" "$PATH_BLOCK_BEGIN" "$PATH_BLOCK_END")"
  body="$(printf '%s\n' "$body" | awk -v b="$CHECK_BLOCK_BEGIN" -v e="$CHECK_BLOCK_END" '
    $0 == b {skip=1; next}
    $0 == e {skip=0; next}
    !skip {print}
  ')"
  {
    echo '#!/usr/bin/env sh'
    path_block
    printf '%s\n' "$body" | awk 'NR==1 && /^#!/ {next} {print}'
    check_block "$hook"
  } >"$tmp"
  # keep shebang once: path_block already after first line
  chmod +x "$tmp"
  mv "$tmp" "$f"
  chmod +x "$f"
done

echo "install-extra-hooks: patched $HOOKS"
