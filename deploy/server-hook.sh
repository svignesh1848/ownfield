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
# Off-server backups: AWS CLI v2 (signature-checked), options.env into the app's env (BACKUP_S3_BUCKET), and a
# timer that restores the newest S3 backup into a scratch DB to prove it works (status shown to the platform owner).
timeout 900 bash "$D/aws-cli-install.sh" || echo "server-hook: aws cli step failed"
mkdir -p /etc/systemd/system/fieldforce-oss.service.d
printf '[Service]\nEnvironmentFile=-/etc/fieldforce-oss-options.env\n' >/etc/systemd/system/fieldforce-oss.service.d/options.conf
install -m 755 "$D/backup-restore-test.sh" /usr/local/sbin/fieldforce-oss-restore-test
printf 'APPDB=%s\n' "$APPDB" >/etc/fieldforce-oss-restore-test.env
printf '[Unit]\nDescription=OwnField backup restore test (scratch DB)\nAfter=postgresql.service\n[Service]\nType=oneshot\nNice=19\nEnvironmentFile=/etc/fieldforce-oss-restore-test.env\nExecStart=/usr/local/sbin/fieldforce-oss-restore-test\n' >/etc/systemd/system/fieldforce-oss-restore-test.service
printf '[Unit]\nDescription=OwnField backup restore test check every 15 min\n[Timer]\nOnBootSec=20min\nOnUnitActiveSec=15min\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/fieldforce-oss-restore-test.timer
systemctl daemon-reload && systemctl enable --now fieldforce-oss-bi-sync.timer >/dev/null 2>&1
systemctl enable --now fieldforce-oss-restore-test.timer >/dev/null 2>&1 || echo "server-hook: restore-test timer failed"
timeout 120 env APPU="$APPU" APPDB="$APPDB" /usr/local/sbin/fieldforce-oss-bi-sync || echo "server-hook: bi sync failed"
timeout 300 bash "$D/domain-setup.sh" || echo "server-hook: domain setup failed"
exit 0
