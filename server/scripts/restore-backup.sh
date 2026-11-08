#!/bin/sh
# Restore an OwnField backup into a database.
# Usage: DATABASE_URL=postgres://... [BACKUP_PASSPHRASE=...] sh restore-backup.sh db-YYYY-MM-DD.sql.gz[.enc]
# Restore into a NEW empty database first, check it, then switch the app to it. Never restore over live data blindly.
set -eu
f="$1"; : "${DATABASE_URL:?set DATABASE_URL to the target (empty) database}"
case "$f" in
  *.enc) : "${BACKUP_PASSPHRASE:?this backup is encrypted; set BACKUP_PASSPHRASE}"
         tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
         openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$f" -out "$tmp" || { echo "wrong passphrase or damaged file" >&2; exit 1; }
         gunzip -t < "$tmp"; gunzip -c < "$tmp" | psql -v ON_ERROR_STOP=1 -q -o /dev/null "$DATABASE_URL" ;;
  *)     gunzip -t "$f"; gunzip -c "$f" | psql -v ON_ERROR_STOP=1 -q -o /dev/null "$DATABASE_URL" ;;
esac
echo "restored $f"
