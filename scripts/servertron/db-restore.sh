#!/usr/bin/env bash
set -euo pipefail

# Stream a custom-format dump into pg_restore inside the server's postgres container.

SERVER="${SERVER:-}"
REMOTE_DIR="${REMOTE_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-}"
DB_USER="${DB_USER:-}"
DB_NAME="${DB_NAME:-}"
BACKUP_FILE="${BACKUP_FILE:-}"
STOP_SERVICE="${STOP_SERVICE:-}"
YES="${YES:-0}"

usage() {
  cat <<EOF
Usage:
  SERVER=user@host \\
  REMOTE_DIR=<servertron-root>/<app> \\
  DB_CONTAINER=<container> DB_USER=<user> DB_NAME=<db> \\
  STOP_SERVICE=<compose-service-or-empty> \\
  BACKUP_FILE=backups/<file>.dump \\
  npm run db:restore

Safety:
  This operation is DESTRUCTIVE (drops/replaces existing tables).
  To proceed, pass --yes (or set YES=1).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) YES="1"; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$SERVER" || -z "$REMOTE_DIR" || -z "$DB_CONTAINER" || -z "$DB_USER" || -z "$DB_NAME" || -z "$BACKUP_FILE" ]]; then
  echo "Missing required env vars." >&2
  usage
  exit 2
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 2
fi

if [[ "${YES}" != "1" ]]; then
  echo "ERROR: Refusing to restore without explicit confirmation." >&2
  echo "Run: npm run db:restore -- --yes" >&2
  exit 2
fi

echo "Restoring $BACKUP_FILE -> $SERVER ($DB_CONTAINER/$DB_NAME)"

if [[ -n "$STOP_SERVICE" ]]; then
  echo "Stopping service: $STOP_SERVICE"
  ssh "$SERVER" "set -euo pipefail; cd '$REMOTE_DIR' && docker compose stop '$STOP_SERVICE' || true"
fi

cat "$BACKUP_FILE" | ssh "$SERVER" "set -euo pipefail; \
  cd '$REMOTE_DIR'; \
  docker inspect '$DB_CONTAINER' >/dev/null; \
  docker exec -i '$DB_CONTAINER' pg_restore -U '$DB_USER' -d '$DB_NAME' --clean --if-exists --no-owner --no-acl"

if [[ -n "$STOP_SERVICE" ]]; then
  echo "Starting service: $STOP_SERVICE"
  ssh "$SERVER" "set -euo pipefail; cd '$REMOTE_DIR' && docker compose up -d '$STOP_SERVICE'"
fi

echo "OK"
