#!/usr/bin/env bash
set -euo pipefail

# Stream a pg_dump -Fc from inside the server's postgres container over SSH.

SERVER="${SERVER:-}"
REMOTE_DIR="${REMOTE_DIR:-}"
DB_CONTAINER="${DB_CONTAINER:-}"
DB_USER="${DB_USER:-}"
DB_NAME="${DB_NAME:-}"
OUT="${OUT:-}"

usage() {
  cat <<EOF
Usage:
  SERVER=user@host \\
  REMOTE_DIR=<servertron-root>/<app> \\
  DB_CONTAINER=<container> DB_USER=<user> DB_NAME=<db> \\
  OUT=backups/<file>.dump \\
  npm run db:backup
EOF
}

if [[ -z "$SERVER" || -z "$REMOTE_DIR" || -z "$DB_CONTAINER" || -z "$DB_USER" || -z "$DB_NAME" || -z "$OUT" ]]; then
  echo "Missing required env vars." >&2
  usage
  exit 2
fi

mkdir -p "$(dirname "$OUT")"

echo "Backing up $DB_NAME from $SERVER ($DB_CONTAINER) -> $OUT"
ssh "$SERVER" "set -euo pipefail; \
  cd '$REMOTE_DIR'; \
  docker inspect '$DB_CONTAINER' >/dev/null; \
  docker exec -i '$DB_CONTAINER' pg_dump -U '$DB_USER' -d '$DB_NAME' -Fc" > "$OUT"

echo "OK"
