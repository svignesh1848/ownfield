#!/bin/bash
# Proves the off-server backups restore (root, from a systemd timer installed by server-hook.sh). Finds the newest
# db-*.sql.gz in s3://$BACKUP_S3_BUCKET/fieldforce/, downloads it to a root-only temp dir, loads it into a SCRATCH
# database (ownfield_restore_test, never the app database), counts the tables, then drops the scratch DB and deletes
# the download. Runs on the first backup, retries a failed test every 6 h, and re-tests weekly after a pass.
# Writes /var/lib/fieldforce-oss-backup/restore-test.json (time, S3 key, size, table count; no data, no secrets).
. /etc/fieldforce-oss-options.env 2>/dev/null
B=$BACKUP_S3_BUCKET; export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-ap-south-1}
[ -n "$B" ] && command -v aws >/dev/null && id postgres >/dev/null 2>&1 || exit 0
SCR=ownfield_restore_test
[ -n "$APPDB" ] && [ "$APPDB" = "$SCR" ] && { echo "restore-test: scratch name equals app DB, refusing"; exit 1; }
S=/var/lib/fieldforce-oss-backup; ST=$S/restore-test.json; mkdir -p $S; chmod 755 $S
L=$(timeout 60 aws s3 ls "s3://$B/fieldforce/" 2>/dev/null | awk '$4 ~ /^db-[0-9-]+\.sql\.gz$/' | sort -k4 | tail -1)
[ -n "$L" ] || exit 0
SIZE=$(echo "$L" | awk '{print $3}'); KEY=fieldforce/$(echo "$L" | awk '{print $4}'); STAMP="$(echo "$L" | awk '{print $1" "$2}')"
if [ -f $ST ] && [ "${1:-}" != "--force" ]; then
  age=$(( $(date +%s) - $(stat -c %Y $ST) ))
  if grep -q '"ok":true' $ST; then [ $age -lt 604800 ] && exit 0   # passed: re-test weekly
  else [ $age -lt 21600 ] && exit 0; fi                            # failed: retry every 6 h
fi
T=$(mktemp -d /root/ff-restore.XXXXXX); chmod 700 "$T"
cleanup() { sudo -u postgres dropdb --if-exists $SCR >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT
P() { sudo -u postgres psql -qAtX "$@"; }
ok=false; tables=null; errors=null; err=""
if ! timeout 600 aws s3 cp --only-show-errors --no-progress "s3://$B/$KEY" "$T/b.sql.gz" 2>"$T/e"; then err="download failed: $(head -c 150 "$T/e")"
else
  sudo -u postgres dropdb --if-exists $SCR; sudo -u postgres createdb $SCR
  gunzip -c "$T/b.sql.gz" | timeout 1200 nice -n 19 sudo -u postgres psql -qX -d $SCR >/dev/null 2>"$T/e"
  errors=$(grep -c 'ERROR:' "$T/e"); tables=$(P -d $SCR -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
  [ "$errors" = 0 ] && [ "${tables:-0}" -ge 40 ] && ok=true || err="$(grep -m1 'ERROR:' "$T/e" | cut -c1-120)"
fi
err=$(printf '%s' "$err" | tr -d '"\\\n\r' | tr -c '[:print:]' ' ' | sed -E 's/[0-9]{12}/<account>/g')
printf '{"at":"%s","key":"%s","s3Time":"%s","s3Bytes":%s,"ok":%s,"tables":%s,"errors":%s,"error":"%s"}\n' \
  "$(date -Is)" "$KEY" "$STAMP" "${SIZE:-null}" $ok "${tables:-null}" "${errors:-null}" "$err" >$ST.new && chmod 644 $ST.new && mv $ST.new $ST
echo "restore-test: $KEY ok=$ok tables=$tables errors=$errors"
exit 0
