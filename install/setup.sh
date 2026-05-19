#!/bin/sh

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAILCOW_PATH="${MAILCOW_PATH:-/opt/mailcow-dockerized}"
NGINX_DST_DIR="$MAILCOW_PATH/data/conf/nginx"
NGINX_DST="$NGINX_DST_DIR/site.mailcow-rest-api.custom"
NGINX_SRC="$REPO_ROOT/install/site.mailcow-rest-api.custom"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

"$REPO_ROOT/install/mailcow-safety-check.sh"

[ -f "$NGINX_SRC" ] || fail "nginx site file missing at $NGINX_SRC"

if [ ! -f "$REPO_ROOT/.env" ]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    log "created $REPO_ROOT/.env from .env.example"
fi

log "Starting mailcow-rest-api from GHCR"
( cd "$REPO_ROOT" && docker compose pull && docker compose up -d )

if [ -f "$NGINX_DST" ] && cmp -s "$NGINX_SRC" "$NGINX_DST"; then
    log "nginx config already current"
else
    if [ -f "$NGINX_DST" ]; then
        cp "$NGINX_DST" "$NGINX_DST.$(date +%Y%m%d%H%M%S).bak"
        log "backed up existing nginx config"
    fi
    cp "$NGINX_SRC" "$NGINX_DST"
    log "installed nginx route at $NGINX_DST"
fi

log "Restarting nginx-mailcow"
( cd "$MAILCOW_PATH" && docker compose restart nginx-mailcow )

log "Verifying https://127.0.0.1/mailcow-rest-api/health"
if curl -fsSk https://127.0.0.1/mailcow-rest-api/health >/dev/null 2>&1; then
    log "OK: API is reachable through mailcow nginx"
elif curl -fsS http://127.0.0.1/mailcow-rest-api/health >/dev/null 2>&1; then
    log "OK: API is reachable through mailcow nginx over HTTP"
else
    fail "API is not reachable through mailcow nginx. Check:
  docker compose -f $REPO_ROOT/docker-compose.yml logs --tail 80 mailcow-rest-api
  docker compose -f $MAILCOW_PATH/docker-compose.yml logs --tail 80 nginx-mailcow"
fi

log "Swagger UI: https://<your-mailcow-host>/mailcow-rest-api/"
