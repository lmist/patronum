#!/usr/bin/env bash
# Download a verified, repo-local Beads release binary.
set -euo pipefail

VERSION="${BEADS_VERSION:-1.2.1}"
REPOSITORY="${BEADS_REPOSITORY:-gastownhall/beads}"
TARGET="${1:?usage: install-bd.sh <target>}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported Beads platform: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo "unsupported Beads architecture: $(uname -m)" >&2; exit 1 ;;
esac

archive="beads_${VERSION}_${os}_${arch}.tar.gz"
release="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -depth -delete' EXIT

curl --fail --location --silent --show-error --output "$tmp_dir/$archive" "$release/$archive"
curl --fail --location --silent --show-error --output "$tmp_dir/checksums.txt" "$release/checksums.txt"
expected="$(awk -v file="$archive" '$2 == file { print $1 }' "$tmp_dir/checksums.txt")"
actual="$(shasum -a 256 "$tmp_dir/$archive" | awk '{ print $1 }')"
if [[ -z "$expected" || "$actual" != "$expected" ]]; then
  echo "Beads release checksum verification failed for $archive" >&2
  exit 1
fi

tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
test -f "$tmp_dir/bd"
mkdir -p "$(dirname "$TARGET")"
install -m 0755 "$tmp_dir/bd" "$TARGET"
