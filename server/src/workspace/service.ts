// SPDX-License-Identifier: AGPL-3.0-only
// Developer Data Workspace: company-scoped views (schema ff_c<id>), guarded read-only SQL runs with audit,
// saved SQL datasets (usable as report-builder sources), and optional read-only BI login per company.
import crypto from "node:crypto";
import fs from "node:fs";
import { withTx, type Db } from "../db.js";
import { bad, parseJson } from "../catalog.js";
import { audit } from "../security.js";
import { guardSql } from "./guard.js";
import { WS_TABLES } from "./tables.js";

export const WS_MAX_ROWS = Number(process.env.WORKSPACE_MAX_ROWS || 5000);
export const WS_TIMEOUT_MS = Number(process.env.WORKSPACE_TIMEOUT_MS || 15000);
export const schemaOf = (cid: number) => { if (!Number.isInteger(cid) || cid <= 0) throw bad("bad company"); return `ff_c${cid}`; };
export const roRole = (cid: number) => `ff_ro_c${cid}`;
export const biRole = (cid: number) => `ff_bi_c${cid}`;

const ready = new WeakMap<Db, Promise<void>>();
export function ensureWorkspaceTables(db: Db) {
  if (ready.has(db)) return ready.get(db)!;
  const p = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS ws_datasets (id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
      description TEXT, sql TEXT NOT NULL, columns TEXT NOT NULL DEFAULT '[]', created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  })().catch(e => { ready.delete(db); throw e; });
  ready.set(db, p); return p;
}

/** Who creates the per-company read-only roles. Least privilege: on the hosted server the app's DB user has no CREATEROLE;
 * it is a NOINHERIT member of a NOLOGIN role (WORKSPACE_PROVISIONER_ROLE, default ff_ws_provisioner) that has only CREATEROLE,
 * and switches to it just for the statements that create/alter workspace roles. A superuser / CREATEROLE app user also works. */
export const PROVISIONER = /^[a-z_][a-z0-9_]{0,62}$/.test(process.env.WORKSPACE_PROVISIONER_ROLE || "") ? process.env.WORKSPACE_PROVISIONER_ROLE! : "ff_ws_provisioner";
type Prov = { me: string; via: "self" | "provisioner" };
const provCache = new WeakMap<Db, Prov>();
const qi = (n: string) => `"${n.replace(/"/g, '""')}"`;
async function provisioner(db: Db): Promise<Prov | null> {
  if (provCache.has(db)) return provCache.get(db)!;
  const me = (await db.query("SELECT r.rolname, r.rolsuper, r.rolcreaterole FROM pg_roles r WHERE r.rolname = session_user")).rows[0];
  if (!me) return null;
  let p: Prov | null = null;
  if (me.rolsuper || me.rolcreaterole) p = { me: me.rolname, via: "self" };
  else if ((await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1 AND rolcreaterole AND pg_has_role(session_user, oid, 'MEMBER')", [PROVISIONER])).rows[0]) p = { me: me.rolname, via: "provisioner" };
  if (p) provCache.set(db, p);
  return p;
}
function asRoleAdmin<T>(db: Db, p: Prov, fn: (tx: Db) => Promise<T>) {
  return withTx(db, async tx => { if (p.via === "provisioner") await tx.query(`SET LOCAL ROLE ${PROVISIONER}`); return fn(tx); });
}
/** Let the app SET ROLE to r without inheriting its rights (PostgreSQL 16+ syntax, plain GRANT on older servers). */
async function grantToApp(tx: Db, r: string, me: string) {
  try { await tx.query("SAVEPOINT g"); await tx.query(`GRANT ${r} TO ${qi(me)} WITH INHERIT FALSE, SET TRUE`); await tx.query("RELEASE SAVEPOINT g"); }
  catch { await tx.query("ROLLBACK TO SAVEPOINT g"); await tx.query(`GRANT ${r} TO ${qi(me)}`); }
}

const synced = new WeakMap<Db, Map<number, Promise<{ roles: boolean }>>>();
/** Create/refresh the company's views, and (when the DB user may) a read-only role that can see only them. */
export function syncCompanySchema(db: Db, cid: number, force = false) {
  let m = synced.get(db); if (!m) synced.set(db, m = new Map());
  if (!force && m.has(cid)) return m.get(cid)!;
  const p = (async () => {
    const s = schemaOf(cid);
    await db.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    for (const [name, t] of Object.entries(WS_TABLES)) {
      const a = t.alias || "t", cols = Object.keys(t.cols).map(c => `${a}.${c}`).join(", ");
      const body = `SELECT ${cols} FROM ${t.from || `public.${name} t`} WHERE ${t.where || "t.company_id"}=${cid}`;
      // Column list changed (or the database can't replace): drop and re-create.
      try { await db.query(`CREATE OR REPLACE VIEW ${s}.${name} AS ${body}`); } catch { await db.query(`DROP VIEW IF EXISTS ${s}.${name}`); await db.query(`CREATE VIEW ${s}.${name} AS ${body}`); }
    }
    let roles = false;
    if (process.env.WORKSPACE_DB_ROLES !== "0") try {
      const prov = await provisioner(db);
      if (prov) {
        const r = roRole(cid);
        await asRoleAdmin(db, prov, async tx => {
          if (!(await tx.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rows[0]) await tx.query(`CREATE ROLE ${r} NOLOGIN`);
          await grantToApp(tx, r, prov.me);
        }).catch(() => {});
        await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`); await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
        await withTx(db, async tx => { await tx.query(`SET LOCAL ROLE ${r}`); }); // proves the app can switch to it
        roles = true;
      }
    } catch { roles = false; }
    return { roles };
  })().catch(e => { m!.delete(cid); throw e; });
  m.set(cid, p); return p;
}

export type SqlResult = { columns: { key: string; type: string }[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number; isolation: "role+views" | "views" };
const typeOf = (vs: unknown[]) => { const v = vs.find(x => x != null); if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && vs.every(x => x == null || /^-?\d+(\.\d+)?$/.test(String(x))))) return "number";
  if (typeof v === "boolean") return "bool"; if (v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return "date"; return "text"; };

/** Run guarded SQL for one company. Every run (ok or refused) is written to the security audit log. */
export async function runSql(db: Db, cid: number, sql: string, who: { uid: number; ip?: string; via?: string }, limit = WS_MAX_ROWS): Promise<SqlResult> {
  const t0 = Date.now(); let rowsN = 0, err: string | null = null;
  try {
    const iso = await syncCompanySchema(db, cid);
    const s = schemaOf(cid), safe = guardSql(sql, s), cap = Math.max(1, Math.min(WS_MAX_ROWS, limit));
    const run = withTx(db, async tx => {
      try { await tx.query("SET TRANSACTION READ ONLY"); } catch { /* test db */ }
      try { await tx.query(`SET LOCAL statement_timeout = ${Math.floor(WS_TIMEOUT_MS)}`); } catch { /* test db */ }
      try { await tx.query(`SET LOCAL search_path TO ${s}`); } catch { /* test db */ }
      if (iso.roles) await tx.query(`SET LOCAL ROLE ${roRole(cid)}`);
      return (await tx.query(`SELECT * FROM (${safe}\n) AS ff_q LIMIT ${cap + 1}`)).rows;
    });
    let timer: NodeJS.Timeout | undefined;
    const rows = await Promise.race([run, new Promise<never>((_, no) => { timer = setTimeout(() => no(bad("Query took too long", 504)), WS_TIMEOUT_MS + 2000); })]).finally(() => clearTimeout(timer));
    rowsN = rows.length;
    const keys = Object.keys(rows[0] || {});
    const out = rows.slice(0, cap).map(r => { const o: Record<string, unknown> = {}; for (const k of keys) { const v = r[k]; o[k] = v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v; } return o; });
    return { columns: keys.map(k => ({ key: k, type: typeOf(out.map(r => r[k])) })), rows: out, truncated: rows.length > cap, ms: Date.now() - t0, isolation: iso.roles ? "role+views" : "views" };
  } catch (e: any) {
    err = String(e.message || e).split("\n")[0].slice(0, 300);
    throw e.status ? e : bad(`Query error: ${err}`);
  } finally {
    await audit(db, { companyId: cid, userId: who.uid, action: err ? "workspace.sql_refused" : "workspace.sql", detail: { sql: String(sql).slice(0, 4000), rows: rowsN, ms: Date.now() - t0, via: who.via || "editor", ...(err ? { error: err } : {}) }, ip: who.ip }).catch(() => {});
  }
}

/** Schema browser: allowed tables, columns and docs. */
export const schemaDocs = () => Object.entries(WS_TABLES).map(([name, t]) => ({ name, doc: t.doc, columns: Object.entries(t.cols).map(([c, d]) => ({ name: c, doc: d })) }));

/** BI allow-list: IPv4/IPv6 addresses or networks (at least /16 or /48), never "everyone". Returns normalised CIDRs. */
export function parseAllowlist(input: unknown): string[] {
  const list = (Array.isArray(input) ? input : String(input ?? "").split(/[\s,;]+/)).map(x => String(x).trim()).filter(Boolean);
  const out: string[] = [];
  for (const x of list) {
    const m4 = x.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
    if (m4) {
      const oct = m4.slice(1, 5).map(Number), bits = m4[5] == null ? 32 : Number(m4[5]);
      if (oct.some(o => o > 255) || bits < 16 || bits > 32) throw bad(`Not allowed: ${x} (use single IPs or networks of /16 or smaller)`);
      if (oct[0] === 0 || oct[0] === 127) throw bad(`Not allowed: ${x}`);
      out.push(`${oct.join(".")}/${bits}`); continue;
    }
    const m6 = x.match(/^([0-9a-fA-F:]{2,39})(?:\/(\d{1,3}))?$/);
    if (m6 && m6[1].includes(":")) {
      const bits = m6[2] == null ? 128 : Number(m6[2]);
      if (bits < 48 || bits > 128 || m6[1] === "::") throw bad(`Not allowed: ${x} (use single IPs or networks of /48 or smaller)`);
      out.push(`${m6[1].toLowerCase()}/${bits}`); continue;
    }
    throw bad(`Not an IP address: ${x}`);
  }
  if (out.length > 20) throw bad("At most 20 addresses");
  return [...new Set(out)];
}
/** What the server operator set up for outside BI connections (written by deploy/bi-db-sync.sh; absent = not exposed). */
export function biServerStatus(): { exposed: boolean; tls?: boolean; host?: string; port?: number } {
  try { const j = JSON.parse(fs.readFileSync(process.env.WORKSPACE_BI_STATUS_FILE || "/var/lib/fieldforce-oss-bi/status.json", "utf8")); return { exposed: !!j.exposed, tls: !!j.tls, host: j.host, port: Number(j.port) || 5432 }; }
  catch { return { exposed: false }; }
}

/** Optional BI login (Metabase / Power BI / Tableau / Superset). Off by default; needs strong mode (see provisioner). */
export async function setBiAccess(db: Db, cid: number, enable: boolean, host?: string) {
  const iso = await syncCompanySchema(db, cid);
  if (iso.roles) await syncCompanySchema(db, cid, true); // refresh views and grants
  else throw bad("This database does not allow creating read-only roles (the app's DB user needs CREATEROLE). See README → Data workspace.", 409);
  const prov = (await provisioner(db))!;
  const r = biRole(cid), s = schemaOf(cid);
  const exists = !!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rows[0];
  if (!enable) { if (exists) await asRoleAdmin(db, prov, tx => tx.query(`ALTER ROLE ${r} NOLOGIN`)); return { enabled: false }; }
  const pw = crypto.randomBytes(18).toString("hex");
  await asRoleAdmin(db, prov, async tx => {
    await tx.query(`${exists ? "ALTER" : "CREATE"} ROLE ${r} LOGIN PASSWORD '${pw}' CONNECTION LIMIT ${Number(process.env.WORKSPACE_BI_CONN_LIMIT || 3)}`);
    await tx.query(`ALTER ROLE ${r} SET search_path TO ${s}`); await tx.query(`ALTER ROLE ${r} SET default_transaction_read_only TO on`);
    await tx.query(`ALTER ROLE ${r} SET statement_timeout TO '${Math.floor(WS_TIMEOUT_MS * 4)}'`);
  });
  await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`); await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
  await db.query(`REVOKE ALL ON SCHEMA public FROM ${r}`).catch(() => {});
  const srv = biServerStatus();
  return { enabled: true, host: process.env.WORKSPACE_BI_HOST || srv.host || host || "(your database host)", port: Number(process.env.WORKSPACE_BI_PORT || srv.port || 5432),
    database: process.env.WORKSPACE_BI_DATABASE || (await db.query("SELECT current_database() AS d")).rows[0]?.d || "(your database name)",
    user: r, password: pw, schema: s, sslmode: "require", note: "Shown once. Read-only; sees only this company's views. Disable any time." };
}
export async function biStatus(db: Db, cid: number) {
  const srv = biServerStatus(); let enabled = false, unsupported = false;
  try { enabled = !!(await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [biRole(cid)])).rows[0]?.rolcanlogin; } catch { unsupported = true; }
  return { enabled, user: biRole(cid), schema: schemaOf(cid), ...(unsupported ? { unsupported } : {}), server: srv };
}

export const datasetOut = (r: any) => ({ id: r.id, name: r.name, description: r.description || "", sql: r.sql, columns: parseJson(r.columns, []), updatedAt: r.updated_at });
