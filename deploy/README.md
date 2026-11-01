# Hosted server hooks

The hosted EC2 server (native PostgreSQL, app DB user `ffoss`) updates itself from `master` every ~10 minutes and runs `npm ci`
as root. The root `package.json` `postinstall` runs `deploy/server-hook.sh`, which does nothing unless it is on that server
(root + `/etc/fieldforce-oss.env`). There it:

1. applies `db-privileges.sql` as the `postgres` superuser (idempotent): a NOLOGIN `ff_ws_provisioner` role with only
   `CREATEROLE`, granted to the app user NOINHERIT — so the Data workspace runs in strong mode without giving the app user any
   extra attribute. Older app versions (after a rollback) simply ignore it.
2. installs `bi-db-sync.sh` as `/usr/local/sbin/fieldforce-oss-bi-sync` with a 2-minute timer. With `BI_DB_EXPOSE=0` (default in
   `options.env`) it keeps Postgres local-only and removes any BI rules. With `BI_DB_EXPOSE=1` it allows only enabled `ff_bi_c<id>`
   logins from the IPs admins entered in the app, over TLS, and writes `/var/lib/fieldforce-oss-bi/status.json` for the app.

When you turn on `BI_DB_EXPOSE=1`, also allow TCP 5432 in the AWS security group **only** from those IPs (`/32`), never `0.0.0.0/0`.
3. runs `domain-setup.sh`: adds `ownfield.in www.ownfield.in` to the nginx server_name next to the sslip.io name (once DNS points here) and expands the Let's Encrypt cert via `certbot --nginx --expand --redirect`; renewal via `certbot.timer`.
