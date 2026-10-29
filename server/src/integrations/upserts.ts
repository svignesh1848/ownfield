// Master-data and stock upserts shared by the public API, inbound webhooks and file imports. Match by external_id first.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "../db.js";
import { bad, getCompany, importOne } from "../catalog.js";
import { checkLowStock } from "./webhooks.js";

export const UPSERT_ENTITIES = ["products", "stock", "customers", "distributors"] as const;
export type UpsertEntity = (typeof UPSERT_ENTITIES)[number];
export type UpsertResult = { inserted: number; updated: number; errors: { index: number; external_id: string | null; error: string }[] };
export const ext = (v: unknown) => v == null || v === "" ? null : String(v).trim().slice(0, 120);
type Ctx = { db: Db; cid: number; imp: any; touched: { vid: number; loc: number | null }[] };

const ROW: Record<UpsertEntity, (c: Ctx, row: any) => Promise<"inserted" | "updated">> = {
  async products({ db, cid, imp }, p) {
    const e = ext(p.external_id);
    const byExt = e && (await db.query("SELECT sku FROM variants WHERE company_id=$1 AND external_id=$2", [cid, e])).rows[0];
    const sku = String(byExt?.sku ?? p.sku ?? "").trim(); if (!sku) throw bad("sku or a known external_id required");
    const row: any = { ...(p.attrs || {}), ...p, sku, item_code: p.item_code ?? sku, billing_price: p.price ?? p.billing_price };
    delete row.attrs; delete row.external_id; delete row.item_external_id; delete row.price;
    const k = await importOne(imp, "products", row);
    if (e) await db.query("UPDATE variants SET external_id=$1, updated_at=NOW() WHERE company_id=$2 AND sku=$3", [e, cid, sku]);
    if (p.item_external_id) await db.query("UPDATE items SET external_id=$1 WHERE company_id=$2 AND code=$3", [ext(p.item_external_id), cid, String(row.item_code)]);
    return k;
  },
  async stock({ db, cid, imp, touched }, s) {
    let sku = s.sku;
    if (!sku && s.product_external_id) sku = (await db.query("SELECT sku FROM variants WHERE company_id=$1 AND external_id=$2", [cid, ext(s.product_external_id)])).rows[0]?.sku;
    if (!sku) throw bad("sku or a known product_external_id required");
    let email: string | null = null, loc: number | null = null;
    if (s.distributor_external_id || s.distributor_id) {
      const d = (await db.query(`SELECT id, email FROM users WHERE company_id=$1 AND role='distributor' AND ${s.distributor_external_id ? "external_id=$2" : "id=$2"}`, [cid, s.distributor_external_id ? ext(s.distributor_external_id) : Number(s.distributor_id)])).rows[0];
      if (!d) throw bad("distributor not found"); email = d.email; loc = d.id;
    }
    const k = await importOne(imp, "stock", { sku, distributor_email: email, qty: s.qty, unit: s.unit, batch_no: s.batch_no, expiry: s.expiry });
    const vid = (await db.query("SELECT id FROM variants WHERE company_id=$1 AND sku=$2", [cid, sku])).rows[0]?.id; if (vid) touched.push({ vid, loc });
    return k;
  },
  async customers({ db, cid, imp }, s) {
    const e = ext(s.external_id);
    const byExt = e && (await db.query("SELECT code FROM shops WHERE company_id=$1 AND external_id=$2", [cid, e])).rows[0];
    const code = String(byExt?.code ?? s.code ?? "").trim(); if (!code) throw bad("code or a known external_id required");
    let distributor_email: string | null = null;
    if (s.distributor_external_id) {
      distributor_email = (await db.query("SELECT email FROM users WHERE company_id=$1 AND role='distributor' AND external_id=$2", [cid, ext(s.distributor_external_id)])).rows[0]?.email;
      if (!distributor_email) throw bad("distributor not found");
    }
    const row = { ...s, code, distributor_email }; delete row.external_id; delete row.distributor_external_id; delete row.credit_days; delete row.credit_limit;
    const k = await importOne(imp, "shops", row);
    if (s.credit_days != null || s.credit_limit != null) await db.query("UPDATE shops SET credit_days=COALESCE($1,credit_days), credit_limit=COALESCE($2,credit_limit) WHERE company_id=$3 AND code=$4",
      [s.credit_days == null ? null : Math.max(0, Math.floor(Number(s.credit_days) || 0)), s.credit_limit == null ? null : Math.max(0, Number(s.credit_limit) || 0), cid, code]);
    if (e) await db.query("UPDATE shops SET external_id=$1, updated_at=NOW() WHERE company_id=$2 AND code=$3", [e, cid, code]);
    return k;
  },
  async distributors({ db, cid }, d) {
    const e = ext(d.external_id), email = String(d.email ?? "").toLowerCase().trim();
    const ex = (e && (await db.query("SELECT id, role FROM users WHERE company_id=$1 AND role='distributor' AND external_id=$2", [cid, e])).rows[0])
      || (email && (await db.query("SELECT id, role FROM users WHERE company_id=$1 AND email=$2", [cid, email])).rows[0]);
    if (ex && ex.role !== "distributor") throw bad("that email belongs to a non-distributor user");
    if (ex) {
      await db.query("UPDATE users SET name=COALESCE($1,name), phone=COALESCE($2,phone), external_id=COALESCE($3,external_id), updated_at=NOW() WHERE id=$4", [d.name ?? null, d.phone == null ? null : String(d.phone), e, ex.id]);
      return "updated";
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !d.name) throw bad("name and a valid email required for a new distributor");
    const lim = (await db.query("SELECT user_limit FROM companies WHERE id=$1", [cid])).rows[0];
    const n = (await db.query("SELECT COUNT(*) AS n FROM users WHERE company_id=$1 AND active=TRUE", [cid])).rows[0];
    if (Number(n.n) >= Number(lim.user_limit)) throw bad(`user limit reached (${lim.user_limit})`, 409);
    // New distributors get an unusable random password; the admin issues a reset code when they need to sign in.
    await db.query("INSERT INTO users (company_id,email,name,phone,role,password_hash,external_id) VALUES ($1,$2,$3,$4,'distributor',$5,$6)",
      [cid, email, String(d.name), d.phone == null ? null : String(d.phone), await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 8), e]);
    return "inserted";
  },
};

/** Upsert rows; each row succeeds or fails on its own. Low-stock webhooks fire after stock pushes. */
export async function upsertRows(db: Db, cid: number, entity: string, rows: any[]): Promise<UpsertResult> {
  const fn = ROW[entity as UpsertEntity]; if (!fn) throw bad(`cannot import ${entity}`, 400);
  const imp = { db, cid, s: (await getCompany(db, cid)).settings, role: "company_admin", uid: 0, addUser: async () => { throw bad("not supported"); } };
  const c: Ctx = { db, cid, imp, touched: [] };
  const out: UpsertResult = { inserted: 0, updated: 0, errors: [] };
  for (const [i, row] of rows.entries()) {
    try { if (!row || typeof row !== "object") throw bad("each row must be an object"); out[await fn(c, row)]++; }
    catch (e: any) { out.errors.push({ index: i, external_id: ext(row?.external_id), error: e.status ? e.message : "could not save this row" }); if (!e.status) console.error("upsert:", e.message); }
  }
  for (const t of c.touched) await checkLowStock(db, cid, [t.vid], t.loc);
  return out;
}
