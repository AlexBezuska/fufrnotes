#!/usr/bin/env bash
set -euo pipefail

# Deploy fufnotes to Servertron via rsync, then docker compose up.
# - App runs behind nginx via a published localhost port.
# - This script only syncs the files needed to build/run the container.

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

DRY_RUN=0
MIRROR=0

usage() {
  cat <<EOF
Usage:
  npm run servertron:deploy -- [--dry-run] [--mirror]

Env overrides:
  DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_PORT
  APP_SLUG (default: fufnotes)
  REMOTE_DIR (default: <servertron-root>/<APP_SLUG>)

Notes:
  - Creates REMOTE_DIR if missing.
  - Does NOT create/overwrite REMOTE_DIR/.env.
  - By default, rsync will NOT delete remote files (safer). Use --mirror to include deletions.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --mirror) MIRROR=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USER" || -z "$REMOTE_DIR" ]]; then
  echo "ERROR: Missing deploy configuration." >&2
  echo "Set DEPLOY_HOST, DEPLOY_USER, and REMOTE_DIR (or SERVERTRON_ROOT)" >&2
  echo "Tip: copy .deploy.env.example -> .deploy.env" >&2
  exit 2
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required" >&2
  exit 1
fi
if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required" >&2
  exit 1
fi

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=( -p "$DEPLOY_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 )

echo "Ensuring $REMOTE_DIR on $REMOTE ..."
if [[ $DRY_RUN -eq 0 ]]; then
  ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$REMOTE_DIR'"
else
  echo "(dry-run) would mkdir -p '$REMOTE_DIR'"
fi

RSYNC_OPTS=( -avz --human-readable --progress --partial )
if [[ $DRY_RUN -eq 1 ]]; then
  RSYNC_OPTS+=( --dry-run )
fi

echo "Rsyncing app code to $REMOTE:$REMOTE_DIR ..."
if [[ $MIRROR -eq 1 ]]; then
  RSYNC_OPTS+=( --delete )
fi

rsync "${RSYNC_OPTS[@]}" \
  --exclude '/.env' \
  --exclude '/.env.*' \
  --exclude '/node_modules/' \
  --exclude '/tools/node_modules/' \
  --exclude '/backup/' \
  --exclude '/data/' \
  --exclude '/.git/' \
  "$REPO_ROOT/" \
  "$REMOTE:$REMOTE_DIR/"

echo "Starting compose on server ..."
if [[ $DRY_RUN -eq 0 ]]; then
  ssh "${SSH_OPTS[@]}" "$REMOTE" "set -euo pipefail; cd '$REMOTE_DIR' \
    && if [[ ! -f .env ]]; then echo 'ERROR: missing .env in $REMOTE_DIR'; exit 2; fi \
    && if ! grep -qE '^FUFNOTES_DB_PASSWORD=.+$' .env; then echo 'ERROR: .env missing FUFNOTES_DB_PASSWORD'; exit 2; fi \
    && docker compose --env-file .env up -d --build"
else
  echo "(dry-run) would run docker compose up -d --build"
fi

cat <<EOF

OK: deploy attempted.

Next:
  - Ensure nginx is proxying your domain -> the app's localhost port
  - Ensure PASSHROOM_CLIENT_SECRET is set on the server in $REMOTE_DIR/.env
EOF
