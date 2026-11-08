# Security operations (backups, encryption, audit, two-step sign-in)

## Backups
- The API server takes a `pg_dump` every night at 02:30 server time (`BACKUP_HOUR`, default 2) into `BACKUP_DIR` (default `~/backups`, folder mode 700, files 600) and keeps the newest `BACKUP_KEEP` (default 7).
- **Encryption:** set `BACKUP_PASSPHRASE` (a long random string) in the server environment. Backups are then written as `db-YYYY-MM-DD.sql.gz.enc` (AES-256, openssl, PBKDF2 200k). Store the passphrase in a password manager **off the server**: without it backups cannot be restored.
- **Off-server copy:** set `BACKUP_S3_BUCKET` and give the instance role `s3:PutObject` on that bucket (bucket: private, default encryption on, versioning + lifecycle e.g. 30 days). Without this, backups live on the same disk as the database.
- Logs show `backup ok: <file>` or `backup: <error>` each night.

### Restore (tested)
```sh
createdb ownfield_restore                      # a NEW empty database
DATABASE_URL=postgres://.../ownfield_restore BACKUP_PASSPHRASE=... sh server/scripts/restore-backup.sh db-YYYY-MM-DD.sql.gz.enc
```
Check counts in the restored DB, then point `DATABASE_URL` at it and restart. A wrong passphrase or damaged file stops with an error before touching the database. Test a restore once a month.

## Encryption of stored data
- **Disk:** the EC2 root/data EBS volume should be encrypted. Check: AWS console → EC2 → Volumes → "Encryption" column. If "Not encrypted": snapshot the volume → copy snapshot with encryption on → create volume from it → stop instance, swap volume, start (plan a short downtime). Also turn on "EBS encryption by default" for the region.
- **App-level:** set `DATA_ENCRYPTION_KEY` (long random string, kept off the server too). New two-step (TOTP) secrets and webhook signing secrets are then stored AES-256-GCM encrypted (`enc1:` prefix). Old plain values keep working. Do not lose or change the key once set, or users with two-step sign-in must be reset by an admin.
- Passwords, reset codes and API keys are already stored only as hashes.

## Access record (audit log)
`security_audit_log` records sign-ins, failed sign-ins, lockouts, new devices, user create/update/delete, role and hierarchy changes, password resets, two-step changes, security settings, data exports, integration changes and platform-owner actions.
- Company admins: Security screen (`GET /api/audit-log`).
- Platform owner: `GET /api/platform/audit-log[?companyId=]` across all companies.

## Two-step sign-in
Users turn it on in their profile (authenticator app). Admins can require it for everyone, or only for admins ("Require two-step sign-in for admins"); both are off by default (demo company stays off).
