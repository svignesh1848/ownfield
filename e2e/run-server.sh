#!/bin/bash
# Start the built app against a fresh Postgres (CI) or an existing DATABASE_URL.
# Passwords come from the environment; this script never prints them.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OWNER_PASSWORD:?OWNER_PASSWORD is required}"
export JWT_SECRET="${JWT_SECRET:-$(python3 -c 'import secrets;print(secrets.token_hex(32))')}"
export OWNER_EMAIL="${OWNER_EMAIL:-owner@example.com}"
export PORT="${PORT:-8080}"
export HOST="${HOST:-127.0.0.1}"
export WEBHOOKS_DISABLED="${WEBHOOKS_DISABLED:-1}"
export NODE_ENV="${NODE_ENV:-development}"
unset DEMO_PASSWORD || true
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export WEB_DIR="${WEB_DIR:-$ROOT/web/dist}"
export UPLOAD_DIR="${UPLOAD_DIR:-$ROOT/.e2e-uploads}"
mkdir -p "$UPLOAD_DIR"
cd "$ROOT"
exec npm start
