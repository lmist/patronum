#!/usr/bin/env bash
# Re-encrypt runtime secrets into secrets/*.age using secrets/age.pubkey (or AGE_RECIPIENT).
# Requires plaintext files to already exist. Never commits AGE_SECRET_KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v age >/dev/null 2>&1; then
  echo "error: age not found" >&2
  exit 1
fi

RECIPIENT="${AGE_RECIPIENT:-}"
if [[ -z "${RECIPIENT}" && -f secrets/age.pubkey ]]; then
  RECIPIENT="$(tr -d '[:space:]' <secrets/age.pubkey)"
fi
if [[ -z "${RECIPIENT}" ]]; then
  echo "error: set AGE_RECIPIENT or create secrets/age.pubkey" >&2
  exit 1
fi

mkdir -p secrets

encrypt() {
  local src="$1" dest="$2"
  if [[ ! -f "${src}" ]]; then
    echo "skip (missing): ${src}"
    return 0
  fi
  age -r "${RECIPIENT}" -o "${dest}" "${src}"
  echo "ok  ${src}  →  ${dest}"
}

encrypt ".env" "secrets/env.age"
encrypt ".agents/config.toml" "secrets/agents-config.toml.age"

echo "done — re-encrypted with ${RECIPIENT}"
