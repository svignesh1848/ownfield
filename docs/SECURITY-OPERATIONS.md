# Security operations (backups, encryption, audit, two-step sign-in)

## Backups
- The API server dumps the database every night at 02:30 server time (`BACKUP_HOUR`, default 2) into `BACKUP_DIR` (default `~/backups`, folder mode 700, files 600) and keeps the newest `BACKUP_KEEP` (default 7) saved copies.
- **Skip when nothing changed:** after the dump, a content hash (ignoring pg_dump's timestamp header lines) is compared to the last saved copy. If it matches and that copy is less than 7 days old, the new file is discarded and nothing is uploaded (status: `skipped (no changes)`). A new copy is always kept at least once every 7 days so a 35-day S3 expiry cannot leave us with no off-server copy. If S3 is configured but the last saved copy never reached it, the run is not skipped.
- **Encryption:** set `BACKUP_PASSPHRASE` (a long random string) in the server environment. Backups are then written as `db-YYYY-MM-DD.sql.gz.enc` (AES-256, openssl, PBKDF2 200k). Store the passphrase in a password manager **off the server**: without it backups cannot be restored.
- **Off-server copy:** set `BACKUP_S3_BUCKET` and give the instance role `s3:PutObject` on that bucket (bucket: private, default encryption on, versioning + lifecycle e.g. 30 days). Without this, backups live on the same disk as the database.
- Logs show `backup ok: <file>`, `backup: skipped (no changes)`, or `backup: <error>` each night.
- **Hosted server:** `deploy/options.env` sets `BACKUP_S3_BUCKET` and `AWS_DEFAULT_REGION`; `server-hook.sh` installs the official AWS CLI v2 (zip checked against the AWS CLI Team PGP key in `deploy/aws-cli-team.asc`) and passes `options.env` to the app through a systemd drop-in. Uploads use the EC2 instance role (no AWS keys on the server). After a deploy the app makes one backup ~2 minutes after start if nothing reached S3 that day (the same skip rule applies; a skip counts as already handled that day).
- **Status (no SSH):** platform owner → `GET /api/platform/backup-status`: last backup time, last skip time, result (`ok` or `skipped (no changes)`), size, S3 upload ok/failed + key, and the latest restore test. No secrets, data or content hash in it.
- **Automatic restore test:** a root timer (`fieldforce-oss-restore-test`, every 15 min check) restores the newest S3 backup into a scratch database `ownfield_restore_test` (never the app database), counts the tables, then drops it and deletes the download. It uses the newest copy even if recent nights were skipped, so a skip does not fail the test. It runs for the first backup, retries a failure every 6 h, and re-tests weekly after a pass. Force one: `sudo /usr/local/sbin/fieldforce-oss-restore-test --force`.
- The AWS CLI signing key expires 2027-07-01; update `deploy/aws-cli-team.asc` from the AWS install docs before then (only matters for new servers).

### Restore (tested)
```sh
createdb ownfield_restore                      # a NEW empty database
DATABASE_URL=postgres://.../ownfield_restore BACKUP_PASSPHRASE=... sh server/scripts/restore-backup.sh db-YYYY-MM-DD.sql.gz.enc
```
Check counts in the restored DB, then point `DATABASE_URL` at it and restart. A wrong passphrase or damaged file stops with an error before touching the database. Test a restore once a month.

## Encryption of stored data
- **Disk:** the EC2 root/data EBS volume should be encrypted. Check: AWS console → EC2 → Volumes → "Encryption" column. If "Not encrypted": snapshot the volume → copy snapshot with encryption on → create volume from it → stop instance, swap volume, start (plan a short downtime). Also turn on "EBS encryption by default" for the region.
- **App-level:** set `DATA_ENCRYPTION_KEY` (long random string, kept off the server too). New two-step (TOTP) secrets, webhook signing secrets and connector passwords (API keys, tokens, client secrets) are then stored AES-256-GCM encrypted (`enc1:` prefix). Old plain values keep working and are encrypted the next time they are saved, or once at startup. Without the key the app keeps running and logs a warning (values stay as plain text). Do not lose or change the key once set, or users with two-step sign-in must be reset by an admin.
- Passwords, reset codes and API keys are already stored only as hashes.

## Access record (audit log)
`security_audit_log` records sign-ins, failed sign-ins, lockouts, new devices, user create/update/delete, role and hierarchy changes, password resets, two-step changes, security settings, data exports, integration changes and platform-owner actions.
- Company admins: Security screen (`GET /api/audit-log`).
- Platform owner: `GET /api/platform/audit-log[?companyId=]` across all companies.

## Two-step sign-in
Users turn it on in their profile (authenticator app). Admins can require it for everyone, or only for admins ("Require two-step sign-in for admins"); both are off by default (demo company stays off). The platform owner must use two-step sign-in: they can still sign in and are sent to set it up, then cannot turn it off.

## Hosted server updates
On the hosted EC2 box, each deploy enables Ubuntu `unattended-upgrades` for the security origin only, with an automatic reboot at 03:00 Asia/Kolkata (21:30 UTC if the server clock is UTC).

## Hosted server WAF-lite and alerts
On the hosted server, each deploy installs nginx rate limits (30 requests/second per IP generally, 10/minute on `/api/auth/*`) and returns 404 for obvious probe paths (`.env`, `.git`, WordPress/phpMyAdmin, path traversal). fail2ban bans an IP for 30 minutes after 8 failed or rate-limited sign-ins in 10 minutes, and keeps the sshd jail on. A failed `nginx -t` reverts the app site and does not reload a broken config. This is not a paid cloud firewall and does not close SSH; those remain AWS-console steps.

The platform owner gets an in-app notification (bell on the platform screen) when there are many failed sign-ins, a backup or restore-test failure, or a burst of server errors. Email is sent only if `SMTP_HOST` is already set and the optional `nodemailer` package is installed; otherwise the alert stays in the app.

## Photo copies with the nightly backup
After each nightly (or catch-up) database backup, the app runs `aws s3 sync` of the local photo folder (`UPLOAD_DIR` or `~/uploads`) to `s3://$BACKUP_S3_BUCKET/fieldforce/photos/`, and skips the copy when the folder is empty or unchanged. The instance role already lists and reads `fieldforce/` for the restore test, and should also allow `s3:PutObject` (and `s3:GetObject` / `s3:ListBucket` for sync) under `fieldforce/photos/`. If the sync fails with AccessDenied, add those actions on that prefix; no bucket policy is changed from the app.
