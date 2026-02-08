#!/usr/bin/env bash
set -euo pipefail

# Automated 2-step nginx + certbot flow (run from local)
# 1) Install HTTP-only vhost (bootstraps nginx even if certs don't exist yet)
# 2) Run certbot using webroot
# 3) Replace with HTTPS vhost and reload nginx

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

WEBSERVER_ROOT="${WEBSERVER_ROOT:-}"
SITE_ROOT="$WEBSERVER_ROOT/site"
NGINX_CONF_DIR="$WEBSERVER_ROOT/nginx/conf.d"

# These are paths *inside the containers* (based on current nginx_web/certbot mounts).
NGINX_SITE_ROOT_IN_CONTAINER="${NGINX_SITE_ROOT_IN_CONTAINER:-/usr/share/nginx/html}"
CERTBOT_WEBROOT_IN_CONTAINER="${CERTBOT_WEBROOT_IN_CONTAINER:-/var/www/certbot}"

NGINX_CONTAINER="${NGINX_CONTAINER:-nginx_web}"
CERTBOT_CONTAINER="${CERTBOT_CONTAINER:-certbot}"

CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

DOMAIN=""
PROXY_PASS=""
FORCE_CERTBOT=0

usage() {
  cat <<EOF
Usage:
  npm run servertron:setup-domain-ssl -- --domain <domain> --proxy-pass http://127.0.0.1:<PORT>

Options:
  --force-certbot   Run certbot even if a cert already exists (use sparingly)

Env overrides:
  DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_PORT
  WEBSERVER_ROOT (default: $WEBSERVER_ROOT)
  NGINX_CONTAINER (default: $NGINX_CONTAINER)
  CERTBOT_CONTAINER (default: $CERTBOT_CONTAINER)
  CERTBOT_EMAIL (default: $CERTBOT_EMAIL)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --proxy-pass) PROXY_PASS="$2"; shift 2 ;;
    --force-certbot) FORCE_CERTBOT=1; shift 1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$PROXY_PASS" ]]; then
  echo "ERROR: --domain and --proxy-pass are required" >&2
  usage
  exit 2
fi

if [[ -z "$DEPLOY_HOST" || -z "$DEPLOY_USER" || -z "$WEBSERVER_ROOT" || -z "$CERTBOT_EMAIL" ]]; then
  echo "ERROR: Missing deploy configuration." >&2
  echo "Set DEPLOY_HOST, DEPLOY_USER, WEBSERVER_ROOT, and CERTBOT_EMAIL" >&2
  echo "Tip: copy .deploy.env.example -> .deploy.env" >&2
  exit 2
fi

REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=( -p "$DEPLOY_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 )

HTTP_CONF_PATH="$NGINX_CONF_DIR/$DOMAIN.conf"
SITE_PATH="$SITE_ROOT/$DOMAIN"
NGINX_SITE_PATH_IN_CONTAINER="$NGINX_SITE_ROOT_IN_CONTAINER/$DOMAIN"

http_conf=$(cat <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  root $NGINX_SITE_PATH_IN_CONTAINER;

  location ^~ /.well-known/acme-challenge/ {
    root $CERTBOT_WEBROOT_IN_CONTAINER;
    default_type "text/plain";
    allow all;
    try_files \$uri =404;
  }

  location / {
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_pass $PROXY_PASS;
  }
}
EOF
)

https_conf=$(cat <<EOF
server {
  listen 80;
  server_name $DOMAIN;

  location ^~ /.well-known/acme-challenge/ {
    root $CERTBOT_WEBROOT_IN_CONTAINER;
    default_type "text/plain";
    allow all;
    try_files \$uri =404;
  }

  location / {
    return 301 https://\$host\$request_uri;
  }
}

server {
  listen 443 ssl;
  server_name $DOMAIN;

  ssl_certificate /etc/nginx/certs/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/live/$DOMAIN/privkey.pem;

  location / {
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass $PROXY_PASS;
  }
}
EOF
)

echo "Connecting to $REMOTE ..."

echo "Ensuring site dir exists: $SITE_PATH"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$SITE_PATH'"

echo "Ensuring certbot webroot exists: $WEBSERVER_ROOT/certbot/www/.well-known/acme-challenge"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$WEBSERVER_ROOT/certbot/www/.well-known/acme-challenge'"

echo "Installing HTTP bootstrap vhost: $HTTP_CONF_PATH"
ssh "${SSH_OPTS[@]}" "$REMOTE" "if [[ -f '$HTTP_CONF_PATH' ]]; then cp '$HTTP_CONF_PATH' '$HTTP_CONF_PATH.bak'; fi"
printf '%s\n' "$http_conf" | ssh "${SSH_OPTS[@]}" "$REMOTE" "cat > '$HTTP_CONF_PATH'"

echo "Validating + reloading nginx (HTTP config) ..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "docker exec '$NGINX_CONTAINER' nginx -t && docker exec '$NGINX_CONTAINER' nginx -s reload"

HOST_CERT_PATH="$WEBSERVER_ROOT/nginx/certs/live/$DOMAIN/fullchain.pem"
echo "Checking for existing cert: $HOST_CERT_PATH"
HAS_CERT=0
if ssh "${SSH_OPTS[@]}" "$REMOTE" "test -f '$HOST_CERT_PATH'"; then
  HAS_CERT=1
fi

if [[ $HAS_CERT -eq 1 && $FORCE_CERTBOT -eq 0 ]]; then
  echo "Cert already exists; skipping certbot. (Use --force-certbot to run anyway.)"
else
  echo "Running certbot for $DOMAIN (webroot) ..."
  ssh "${SSH_OPTS[@]}" "$REMOTE" "docker exec '$CERTBOT_CONTAINER' certbot certonly --webroot -w '$CERTBOT_WEBROOT_IN_CONTAINER' -d '$DOMAIN' --email '$CERTBOT_EMAIL' --agree-tos --non-interactive"
fi

echo "Installing HTTPS vhost: $HTTP_CONF_PATH"
printf '%s\n' "$https_conf" | ssh "${SSH_OPTS[@]}" "$REMOTE" "cat > '$HTTP_CONF_PATH'"

echo "Validating + reloading nginx (HTTPS config) ..."
ssh "${SSH_OPTS[@]}" "$REMOTE" "docker exec '$NGINX_CONTAINER' nginx -t && docker exec '$NGINX_CONTAINER' nginx -s reload"

echo "OK: domain configured: https://$DOMAIN"
