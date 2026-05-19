#!/bin/sh

set -eu

REPO="jr551/mailcow-rest-api"
INSTALL_DIR="${INSTALL_DIR:-/opt/mailcow-rest-api}"
MAILCOW_PATH="${MAILCOW_PATH:-/opt/mailcow-dockerized}"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker info >/dev/null 2>&1 || fail "cannot talk to Docker; run with sudo or add this user to the docker group"
[ -d "$MAILCOW_PATH" ] || fail "mailcow checkout not found at $MAILCOW_PATH (set MAILCOW_PATH=...)"
case "$INSTALL_DIR" in
    "$MAILCOW_PATH"|"$MAILCOW_PATH"/*)
        fail "INSTALL_DIR must be outside the mailcow checkout"
        ;;
esac

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

log "Downloading $REPO master"
curl -fsSL "https://github.com/$REPO/archive/refs/heads/master.tar.gz" -o "$TMPDIR/repo.tar.gz"
tar -xzf "$TMPDIR/repo.tar.gz" -C "$TMPDIR" --strip-components=1

if [ -f "$INSTALL_DIR/.env" ]; then
    log "Preserving existing $INSTALL_DIR/.env"
    cp "$INSTALL_DIR/.env" "$TMPDIR/.env.keep"
    rm -rf "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    mv "$TMPDIR" "$INSTALL_DIR"
    mv "$INSTALL_DIR/.env.keep" "$INSTALL_DIR/.env"
else
    rm -rf "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    mv "$TMPDIR" "$INSTALL_DIR"
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    log "Created $INSTALL_DIR/.env from .env.example"
fi

log "Running setup"
"$INSTALL_DIR/install/setup.sh"
