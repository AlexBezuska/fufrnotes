#!/usr/bin/env bash
set -euo pipefail

# One command: ship latest code to Servertron and verify it's live.
# - Runs deploy (rsync + docker compose up -d --build)
# - Waits for the app health check to succeed from the server host

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -f "$REPO_ROOT/.deploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.deploy.env"
  set +a
fi

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-}"
DEPLOY_SSH_PORT="${DEPLOY_SSH_PORT:-22}"

APP_SLUG="${APP_SLUG:-fufnotes}"
SERVERTRON_ROOT="${SERVERTRON_ROOT:-}"
REMOTE_DIR="${REMOTE_DIR:-}"
if [[ -z "$REMOTE_DIR" && -n "$SERVERTRON_ROOT" ]]; then
  REMOTE_DIR="$SERVERTRON_ROOT/$APP_SLUG"
fi

PROXY_PASS="${PROXY_PASS:-http://127.0.0.1:18081}"
APP_HEALTH_URL="${APP_HEALTH_URL:-}"

if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USER" || -z "$REMOTE_DIR" ]]; then
  echo "ERROR: Missing deploy configuration." >&2
  echo "Set DEPLOY_HOST, DEPLOY_USER, and REMOTE_DIR (or SERVERTRON_ROOT)" >&2
  echo "Tip: copy .deploy.env.example -> .deploy.env" >&2
  exit 2
fi

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=( -p "$DEPLOY_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 )

# 1) Deploy (accept/pass-through any args like --mirror/--dry-run)
"$SCRIPT_DIR/deploy.sh" "$@"

# 2) Health check (best-effort)
health_base="$PROXY_PASS"
health_base="${health_base%/}"
health_url="${APP_HEALTH_URL:-$health_base/healthz}"

echo "Checking health from server host: $health_url"

# Wait up to ~30s for app to come up.
ssh "${SSH_OPTS[@]}" "$REMOTE" "set -euo pipefail;
  if ! command -v curl >/dev/null 2>&1; then
    echo 'WARN: curl not found on server; skipping health check.'
    exit 0
  fi
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -fsS '$health_url' >/dev/null; then
      echo 'OK: health check passed.'
      exit 0
    fi
    sleep 2
  done
  echo 'ERROR: health check did not pass in time.'
  exit 2
"

echo "OK: ship completed."
