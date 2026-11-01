#!/bin/bash
# Runs from `npm ci` (root package.json "postinstall") during the server's self-update, which runs as root on the
# hosted EC2 box (native PostgreSQL, app user ffoss, env /etc/fieldforce-oss.env). Anywhere else (dev machines,
# Docker builds, CI) it does nothing. Idempotent, never fails the build, prints no secrets.
[ "$(id -u)" = 0 ] && [ -f /etc/fieldforce-oss.env ] && command -v systemctl >/dev/null && id postgres >/dev/null 2>&1 || exit 0
D=$(cd "$(dirname "$0")" && pwd)
APPU=$(sed -n 's|^DATABASE_URL=postgres://\([a-z_][a-z0-9_]*\):.*|\1|p' /etc/fieldforce-oss.env | head -1)
APPDB=$(sed -n 's|^DATABASE_URL=postgres://[^/]*/\([a-z_][a-z0-9_]*\).*|\1|p' /etc/fieldforce-oss.env | head -1)
[ -n "$APPU" ] && [ -n "$APPDB" ] || exit 0
echo "server-hook: data workspace DB privileges for $APPU"
timeout 60 sudo -u postgres psql -qX -v ON_ERROR_STOP=1 -v app="$APPU" -d "$APPDB" <"$D/db-privileges.sql" || echo "server-hook: privileges step failed (app stays in views mode)"
# BI connection sync (pg_hba allow-list). Installed outside the build dir so a rollback keeps a working copy.
install -m 755 "$D/bi-db-sync.sh" /usr/local/sbin/fieldforce-oss-bi-sync
install -m 644 "$D/options.env" /etc/fieldforce-oss-options.env
printf 'APPU=%s\nAPPDB=%s\n' "$APPU" "$APPDB" >/etc/fieldforce-oss-bi-sync.env
printf '[Unit]\nDescription=OwnField BI database allow-list sync\nAfter=postgresql.service\n[Service]\nType=oneshot\nEnvironmentFile=/etc/fieldforce-oss-bi-sync.env\nExecStart=/usr/local/sbin/fieldforce-oss-bi-sync\n' >/etc/systemd/system/fieldforce-oss-bi-sync.service
printf '[Unit]\nDescription=OwnField BI allow-list sync every 2 min\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=2min\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/fieldforce-oss-bi-sync.timer
systemctl daemon-reload && systemctl enable --now fieldforce-oss-bi-sync.timer >/dev/null 2>&1
timeout 120 env APPU="$APPU" APPDB="$APPDB" /usr/local/sbin/fieldforce-oss-bi-sync || echo "server-hook: bi sync failed"
timeout 300 bash "$D/domain-setup.sh" || echo "server-hook: domain setup failed"
exit 0
