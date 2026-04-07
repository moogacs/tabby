#!/usr/bin/env bash
# Build a Chrome Web Store zip (extension files only; no README, screenshots, or .git).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ZIP_NAME="${ZIP_NAME:-tabby-extension.zip}"
OUT="${1:-$ZIP_NAME}"

rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  classify.js \
  limits.js \
  popup.html \
  popup.css \
  popup.js \
  progress.html \
  progress.css \
  progress.js \
  icons \
  -x "*.DS_Store" \
  -x "**/.DS_Store"

echo "Packaged: $ROOT/$OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
