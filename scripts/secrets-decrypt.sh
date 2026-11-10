#!/usr/bin/env bash
# Decrypt secrets/*.age into runtime paths. Requires `age` (https://github.com/FiloSottile/age).
#
#   AGE_SECRET_KEY=AGE-SECRET-KEY-... npm run secrets:decrypt
#   AGE_KEY_FILE=./secrets/AGE_SECRET_KEY npm run secrets:decrypt
#   # or drop the private key at secrets/AGE_SECRET_KEY (gitignored)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v age >/dev/null 2>&1; then
  echo "error: age not found. Install: brew install age  (or https://github.com/FiloSottile/age)" >&2
  exit 1
fi

KEY_FILE="${AGE_KEY_FILE:-$ROOT/secrets/AGE_SECRET_KEY}"
TMP_KEY=""
cleanup() {
  if [[ -n "${TMP_KEY}" && -f "${TMP_KEY}" ]]; then
    rm -f "${TMP_KEY}"
  fi
}
trap cleanup EXIT

if [[ -n "${AGE_SECRET_KEY:-}" ]]; then
  TMP_KEY="$(mktemp)"
  if [[ "${AGE_SECRET_KEY}" == AGE-SECRET-KEY-* ]]; then
    printf '%s\n' "${AGE_SECRET_KEY}" >"${TMP_KEY}"
  else
    printf '%s\n' "${AGE_SECRET_KEY}" >"${TMP_KEY}"
  fi
  KEY_FILE="${TMP_KEY}"
elif [[ ! -f "${KEY_FILE}" ]]; then
  echo "error: no age identity. Set AGE_SECRET_KEY, AGE_KEY_FILE, or place secrets/AGE_SECRET_KEY" >&2
  exit 1
fi

decrypt() {
  local src="$1" dest="$2"
  if [[ ! -f "${src}" ]]; then
    echo "skip (missing): ${src}"
    return 0
  fi
  mkdir -p "$(dirname "${dest}")"
  age -d -i "${KEY_FILE}" -o "${dest}" "${src}"
  chmod 600 "${dest}" 2>/dev/null || true
  echo "ok  ${src}  →  ${dest}"
}

decrypt "secrets/env.age" ".env"
decrypt "secrets/agents-config.toml.age" ".agents/config.toml"

echo "done — secrets decrypted"
