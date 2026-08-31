#!/usr/bin/env bash
# Interactive first-run setup for the "Standalone Docker" deployment mode.
#
# What this does, in order:
#   1. Copies docker-compose.example.yml -> docker-compose.yml and
#      .env.example -> .env if they don't already exist.
#   2. Tries to auto-detect your mailcow Docker network so you don't have
#      to look it up yourself.
#   3. Starts the containers with `docker compose up -d`.
#   4. Waits for the webmail + API to come up and reports pass/fail for
#      each required route, with a plain-English fix for anything that
#      failed.
#
# Safe to re-run: it never overwrites an existing docker-compose.yml or .env.

set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
err()  { printf '  \033[31mERR\033[0m %s\n' "$1"; }
info() { printf '%s\n' "$1"; }

bold "mailcow-rest-api-webmail setup"
echo

# --- 1. Prerequisites -------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
    err "docker is not installed or not on PATH."
    info "Install Docker first: https://docs.docker.com/engine/install/"
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    err "docker compose (v2 plugin) is not available."
    info "Install the Docker Compose plugin, then re-run this script."
    exit 1
fi
ok "Docker and Docker Compose are installed."

# --- 2. Config files ---------------------------------------------------------

if [ -f docker-compose.yml ]; then
    ok "docker-compose.yml already exists, leaving it alone."
else
    cp docker-compose.example.yml docker-compose.yml
    ok "Created docker-compose.yml from the example template."
fi

if [ -f .env ]; then
    ok ".env already exists, leaving it alone."
else
    cp .env.example .env
    ok "Created .env from the example template."
fi

# --- 3. Auto-detect the mailcow Docker network -------------------------------

detected_network="$(docker network ls --format '{{.Name}}' | grep -i 'mailcow.*network' | head -n1 || true)"

if [ -n "$detected_network" ]; then
    if grep -q '^MAILCOW_NETWORK=' .env; then
        sed -i.bak "s/^MAILCOW_NETWORK=.*/MAILCOW_NETWORK=${detected_network}/" .env && rm -f .env.bak
    else
        printf '\nMAILCOW_NETWORK=%s\n' "$detected_network" >> .env
    fi
    ok "Found your mailcow Docker network: ${detected_network}"
else
    info "  Could not auto-detect a mailcow Docker network."
    info "  If mailcow is on a different network name, edit MAILCOW_NETWORK in .env"
    info "  before continuing (default guess: mailcowdockerized_mailcow-network)."
fi

# --- 4. Port ------------------------------------------------------------------

port="${WEBMAIL_PORT:-8080}"
if [ -t 0 ] && [ -z "${WEBMAIL_PORT:-}" ]; then
    read -r -p "Local port to expose the webmail on [${port}]: " input_port || true
    port="${input_port:-$port}"
fi
if [ "$port" != "8080" ]; then
    sed -i.bak "s/\"8080:80\"/\"${port}:80\"/" docker-compose.yml && rm -f docker-compose.yml.bak
fi

# --- 5. Start containers -------------------------------------------------------

echo
bold "Starting containers..."
docker compose up -d

# --- 6. Health check ------------------------------------------------------------

echo
bold "Checking that everything is reachable..."
base="http://localhost:${port}"
attempts=15
sleep_s=2
overall_ok=1

check_route() {
    local path="$1" label="$2" fix="$3"
    local i=0
    while [ $i -lt $attempts ]; do
        if curl -fsS -o /dev/null --max-time 3 "${base}${path}"; then
            ok "${label} (${path})"
            return 0
        fi
        i=$((i + 1))
        sleep "$sleep_s"
    done
    err "${label} (${path}) did not respond after $((attempts * sleep_s))s"
    info "      fix: ${fix}"
    overall_ok=0
    return 1
}

check_route "/webmail/" "Webmail shell" "Check 'docker compose logs webmail'."
check_route "/health" "API health" "Check 'docker compose logs mailcow-rest-api' and confirm .env has correct IMAP/SMTP/DB hosts."
check_route "/openapi.json" "API OpenAPI document" "Same as above — the API container may still be starting."

echo
if [ "$overall_ok" -eq 1 ]; then
    bold "All checks passed."
    echo "Open http://localhost:${port}/webmail/ to see the app."
else
    bold "Some checks failed — see fixes above."
    echo "You can re-run just the checks any time with:"
    echo "  node scripts/check-config.mjs --url ${base}"
fi

echo
info "This is a local/loopback check only. To serve real users, put a TLS"
info "reverse proxy in front (see README.md 'Setup Modes') so /webmail/,"
info "/v1/*, /health, and /openapi.json are all reachable on one public origin."
