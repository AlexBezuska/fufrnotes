#!/usr/bin/env bash
set -euo pipefail

# One command bootstrap for a new fufnotes deploy:
# - Ensures app remote dir + .env exist
# - Rsync deploy + docker compose up
# - Ensures nginx HTTP vhost, runs certbot, installs HTTPS vhost

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

DOMAIN="${DOMAIN:-}"
PROXY_PASS="${PROXY_PASS:-http://127.0.0.1:18081}"

usage() {
  cat <<EOF
Usage:
  npm run servertron:bootstrap

Optional env overrides:
  DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_PORT
  REMOTE_DIR (default: $REMOTE_DIR)
  DOMAIN (default: $DOMAIN)
  PROXY_PASS (default: $PROXY_PASS)

What it does:
  1) Creates REMOTE_DIR if missing
  2) Creates REMOTE_DIR/.env with a generated FUFNOTES_DB_PASSWORD if missing
  3) Deploys app + runs docker compose
  4) Sets up nginx + certbot SSL for DOMAIN
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USER" || -z "$REMOTE_DIR" || -z "$DOMAIN" ]]; then
  echo "ERROR: Missing bootstrap configuration." >&2
  echo "Set DEPLOY_HOST, DEPLOY_USER, REMOTE_DIR (or SERVERTRON_ROOT), and DOMAIN" >&2
  echo "Tip: copy .deploy.env.example -> .deploy.env" >&2
  exit 2
fi

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=( -p "$DEPLOY_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 )

if ! command -v ssh >/dev/null 2>&1; then
  echo "ssh is required" >&2
  exit 1
fi

echo "Ensuring $REMOTE_DIR exists on $REMOTE ..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$REMOTE_DIR'"

echo "Ensuring $REMOTE_DIR/.env exists (generating FUFNOTES_DB_PASSWORD if missing) ..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "
  set -euo pipefail
  cd '$REMOTE_DIR'
  touch .env
  chmod 600 .env

  if ! grep -qE '^FUFNOTES_DB_PASSWORD=.+$' .env; then
    if command -v openssl >/dev/null 2>&1; then
      pw=\"\$(openssl rand -hex 24)\"
    else
      pw=\"\$(date +%s)-\$(id -u)-\$(uname -n)\"
    fi

    printf '%s=%s\n' 'FUFNOTES_DB_PASSWORD' \"\$pw\" >> .env
    echo 'Updated .env (added FUFNOTES_DB_PASSWORD)'
  else
    echo 'OK: .env has FUFNOTES_DB_PASSWORD; leaving as-is.'
  fi

  if ! grep -qE '^PASSHROOM_CLIENT_SECRET=.+$' .env; then
    echo 'WARN: PASSHROOM_CLIENT_SECRET is missing or empty in .env.'
    echo '      Magic-link callback will fail until it is set.'
  fi
"

# Deploy and start the app
bash "$SCRIPT_DIR/deploy.sh"

# Domain + SSL
bash "$SCRIPT_DIR/setup-domain-ssl.sh" --domain "$DOMAIN" --proxy-pass "$PROXY_PASS"

echo "OK: bootstrap finished for https://$DOMAIN"
