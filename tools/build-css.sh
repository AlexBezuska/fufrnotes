#!/usr/bin/env bash
set -euo pipefail

# Build Tailwind CSS into a static file for nginx/Apache.
# Run from repo root: (cd tools && npm install && npm run build:css)

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

tmp_css="$(mktemp)"
cat theme.css tailwind.src.css > "$tmp_css"
npx tailwindcss -c tailwind.config.js -i "$tmp_css" -o ../public/styles.css --minify
rm -f "$tmp_css"

echo "Built ../public/styles.css"
