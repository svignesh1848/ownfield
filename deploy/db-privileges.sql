-- Least-privilege setup for the Data workspace "strong mode" (run as the Postgres superuser; safe to re-run).
-- The app's DB user (psql -v app=<user>) gets NO extra attributes. It becomes a NOINHERIT member of a NOLOGIN role
-- that only has CREATEROLE; the app switches to it (SET LOCAL ROLE) just to create/alter the per-company
-- read-only roles ff_ro_c<id> / ff_bi_c<id>. On PostgreSQL 16+ a CREATEROLE role can only manage roles it created,
-- cannot create superusers and cannot grant attributes it lacks (no SUPERUSER, REPLICATION, BYPASSRLS).
-- Rollback-safe: older app versions ignore this role and keep working in "views" mode.
SELECT 'CREATE ROLE ff_ws_provisioner NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ff_ws_provisioner')
\gexec
ALTER ROLE ff_ws_provisioner NOLOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT;
SELECT format('GRANT ff_ws_provisioner TO %I WITH INHERIT FALSE, SET TRUE', :'app')
 WHERE current_setting('server_version_num')::int >= 160000
   AND NOT pg_has_role(:'app', 'ff_ws_provisioner', 'MEMBER')
\gexec
SELECT format('GRANT ff_ws_provisioner TO %I', :'app')
 WHERE current_setting('server_version_num')::int < 160000
   AND NOT pg_has_role(:'app', 'ff_ws_provisioner', 'MEMBER')
\gexec
