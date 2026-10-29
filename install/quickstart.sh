#!/bin/sh

set -eu

REPO="jr551/mailcow-rest-api"
INSTALL_DIR="${INSTALL_DIR:-/opt/mailcow-rest-api}"
MAILCOW_PATH="${MAILCOW_PATH:-/opt/mailcow-dockerized}"
# Branch, tag or commit to install. Pin a release tag or SHA for a reproducible install.
REF="${REF:-master}"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v docker >/dev/null 2>&1 || fail "docker is required"
docker info >/dev/null 2>&1 || fail "cannot talk to Docker; run with sudo or add this user to the docker group"
[ -d "$MAILCOW_PATH" ] || fail "mailcow checkout not found at $MAILCOW_PATH (set MAILCOW_PATH=...)"
case "$REF" in
    ""|*[!A-Za-z0-9._/-]*)
        fail "REF may only contain letters, digits and . _ / -"
        ;;
esac
case "$INSTALL_DIR" in
    /?*/?*) ;;
    *)
        fail "INSTALL_DIR must be an absolute path at least two levels deep, for example /opt/mailcow-rest-api (got '$INSTALL_DIR')"
        ;;
esac
case "$INSTALL_DIR" in
    /usr/*|/etc/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/boot/*|/dev/*|/proc/*|/sys/*|/run/*)
        fail "INSTALL_DIR must not be inside a system directory (got '$INSTALL_DIR')"
        ;;
    "$MAILCOW_PATH"|"$MAILCOW_PATH"/*)
        fail "INSTALL_DIR must be outside the mailcow checkout"
        ;;
esac

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

log "Downloading $REPO $REF"
curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" -o "$TMPDIR/repo.tar.gz"
tar -xzf "$TMPDIR/repo.tar.gz" -C "$TMPDIR" --strip-components=1
rm -f "$TMPDIR/repo.tar.gz"

# The previous install (and its .env, which holds the credential encryption
# key) is moved aside, never deleted, until the new one is in place and set up.
OLD_DIR=""
if [ -e "$INSTALL_DIR" ]; then
    OLD_DIR="$INSTALL_DIR.old.$(date +%Y%m%d%H%M%S)"
    mv "$INSTALL_DIR" "$OLD_DIR"
fi
mkdir -p "$(dirname "$INSTALL_DIR")"
if ! mv "$TMPDIR" "$INSTALL_DIR"; then
    rm -rf "$INSTALL_DIR"
    [ -z "$OLD_DIR" ] || mv "$OLD_DIR" "$INSTALL_DIR"
    fail "could not move the new install into $INSTALL_DIR; the previous install was left in place"
fi

if [ -n "$OLD_DIR" ] && [ -f "$OLD_DIR/.env" ]; then
    log "Preserving existing $INSTALL_DIR/.env"
    ( umask 077 && cp "$OLD_DIR/.env" "$INSTALL_DIR/.env" )
else
    ( umask 077 && cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env" )
    log "Created $INSTALL_DIR/.env from .env.example"
fi

log "Running setup"
if ! "$INSTALL_DIR/install/setup.sh"; then
    [ -z "$OLD_DIR" ] || printf 'The previous install is still at %s\n' "$OLD_DIR" >&2
    exit 1
fi
[ -z "$OLD_DIR" ] || rm -rf "$OLD_DIR"
