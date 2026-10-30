// SPDX-License-Identifier: AGPL-3.0-only
// Developer Data Workspace: company-scoped views (schema ff_c<id>), guarded read-only SQL runs with audit,
// saved SQL datasets (usable as report-builder sources), and optional read-only BI login per company.
import crypto from "node:crypto";
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
      const r = roRole(cid);
      if (!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rows[0]) await db.query(`CREATE ROLE ${r} NOLOGIN`);
      await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`); await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
      await db.query(`GRANT ${r} TO CURRENT_USER`).catch(() => {});
      roles = true;
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

/** Optional BI login (Metabase / Power BI / Superset). Disabled by default; needs a DB user that can create roles. */
export async function setBiAccess(db: Db, cid: number, enable: boolean) {
  const iso = await syncCompanySchema(db, cid);
  if (iso.roles) await syncCompanySchema(db, cid, true); // refresh views and grants
  else throw bad("This database does not allow creating read-only roles (the app's DB user needs CREATEROLE). See README → Data workspace.", 409);
  const r = biRole(cid), s = schemaOf(cid);
  const exists = !!(await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [r])).rows[0];
  if (!enable) { if (exists) await db.query(`ALTER ROLE ${r} NOLOGIN`); return { enabled: false }; }
  const pw = crypto.randomBytes(18).toString("hex");
  await db.query(`${exists ? "ALTER" : "CREATE"} ROLE ${r} LOGIN PASSWORD '${pw}' CONNECTION LIMIT ${Number(process.env.WORKSPACE_BI_CONN_LIMIT || 3)}`);
  await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${r}`); await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${r}`);
  await db.query(`ALTER ROLE ${r} SET search_path TO ${s}`); await db.query(`ALTER ROLE ${r} SET default_transaction_read_only TO on`);
  await db.query(`ALTER ROLE ${r} SET statement_timeout TO '${Math.floor(WS_TIMEOUT_MS * 4)}'`);
  await db.query(`REVOKE ALL ON SCHEMA public FROM ${r}`).catch(() => {});
  return { enabled: true, host: process.env.WORKSPACE_BI_HOST || "(your database host)", port: Number(process.env.WORKSPACE_BI_PORT || 5432), database: process.env.WORKSPACE_BI_DATABASE || "(your database name)",
    user: r, password: pw, schema: s, note: "Shown once. Read-only; sees only this company's views. Disable any time." };
}
export async function biStatus(db: Db, cid: number) {
  try { const r = (await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [biRole(cid)])).rows[0]; return { enabled: !!r?.rolcanlogin, user: biRole(cid), schema: schemaOf(cid) }; }
  catch { return { enabled: false, user: biRole(cid), schema: schemaOf(cid), unsupported: true }; }
}

export const datasetOut = (r: any) => ({ id: r.id, name: r.name, description: r.description || "", sql: r.sql, columns: parseJson(r.columns, []), updatedAt: r.updated_at });
