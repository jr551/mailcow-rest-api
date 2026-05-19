#!/bin/sh

set -eu

MAILCOW_PATH="${MAILCOW_PATH:-/opt/mailcow-dockerized}"
MAILCOW_NETWORK="${MAILCOW_NETWORK:-mailcowdockerized_mailcow-network}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is not installed or not on PATH"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is not available"
docker info >/dev/null 2>&1 || fail "cannot talk to Docker; run with sudo or add this user to the docker group"

[ -d "$MAILCOW_PATH" ] || fail "mailcow checkout not found at $MAILCOW_PATH (set MAILCOW_PATH=...)"
[ -f "$MAILCOW_PATH/docker-compose.yml" ] || [ -f "$MAILCOW_PATH/compose.yaml" ] || fail "$MAILCOW_PATH does not look like mailcow-dockerized"
[ -d "$MAILCOW_PATH/data/conf/nginx" ] || fail "mailcow nginx config directory missing at $MAILCOW_PATH/data/conf/nginx"
[ -w "$MAILCOW_PATH/data/conf/nginx" ] || fail "mailcow nginx config directory is not writable; run setup with sudo"
[ -w "$REPO_ROOT" ] || fail "install directory is not writable: $REPO_ROOT"

case "$REPO_ROOT" in
    "$MAILCOW_PATH"|"$MAILCOW_PATH"/*)
        fail "do not install this add-on inside the mailcow checkout; use /opt/mailcow-rest-api or another sibling directory"
        ;;
esac

docker network inspect "$MAILCOW_NETWORK" >/dev/null 2>&1 || fail "Docker network $MAILCOW_NETWORK not found (set MAILCOW_NETWORK=...)"

for name in nginx-mailcow dovecot-mailcow postfix-mailcow; do
    docker ps --format '{{.Names}}' | grep -qx "$name" || fail "required mailcow container is not running: $name"
done

log "mailcow safety check passed"
