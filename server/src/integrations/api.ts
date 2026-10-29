// Public versioned REST API (/api/v1), authenticated with per-company API keys. See INTEGRATIONS.md.
import express, { NextFunction, Request, Response } from "express";
import type { Express } from "express";
import type { Db } from "../db.js";
import { bad, parseJson } from "../catalog.js";
import { audit } from "../security.js";
import { apiKeyAuth, need, type ApiReq } from "./apikeys.js";
import { upsertRows, ext } from "./upserts.js";
import { openapiSpec, DOCS_HTML, DOCS_JS } from "./openapi.js";

const MAX_BATCH = 500;
type H = (req: ApiReq, res: Response) => Promise<unknown>;
const w = (fn: H) => (req: Request, res: Response, next: NextFunction) => fn(req as ApiReq, res).catch(next);

/** Pagination + incremental sync: ?limit (1-500, default 100) &page (1..) &updated_since (ISO timestamp). */
export function pageArgs(q: any) {
  const limit = Math.min(MAX_BATCH, Math.max(1, Number(q.limit) || 100)), page = Math.max(1, Math.floor(Number(q.page) || 1));
  let since: string | null = null;
  if (q.updated_since != null && q.updated_since !== "") {
    const t = Date.parse(String(q.updated_since)); if (isNaN(t)) throw bad("updated_since must be an ISO 8601 timestamp");
    since = new Date(t).toISOString();
  }
  return { limit, page, since, offset: (page - 1) * limit };
}
async function list(db: Db, req: ApiReq, res: Response, sql: { from: string; where?: string; ts: string; select: string }, map: (r: any) => any = r => r) {
  const { limit, page, since, offset } = pageArgs(req.query);
  const args: unknown[] = [req.api.companyId]; let where = sql.where ? `${sql.where}` : "";
  if (since) { args.push(since); where += ` AND ${sql.ts} >= $${args.length}`; }
  const rows = (await db.query(`SELECT ${sql.select} FROM ${sql.from} WHERE ${where.replace(/^ AND /, "")} ORDER BY 1 LIMIT ${limit + 1} OFFSET ${offset}`, args)).rows;
  const more = rows.length > limit;
  res.json({ data: (more ? rows.slice(0, limit) : rows).map(map), page, limit, has_more: more, next_page: more ? page + 1 : null, server_time: new Date().toISOString() });
}
const items = (b: any) => {
  const a = Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : null;
  if (!a || !a.length) throw bad("send {\"items\": [...]} with at least one row");
  if (a.length > MAX_BATCH) throw bad(`at most ${MAX_BATCH} rows per call`);
  return a as any[];
};

export function registerApiV1(app: Express, db: Db) {
  const r = express.Router();
  r.get("/openapi.json", (_q, res) => res.json(openapiSpec()));
  r.get("/docs", (_q, res) => res.type("html").send(DOCS_HTML));
  r.get("/docs.js", (_q, res) => res.type("application/javascript").send(DOCS_JS));
  r.use(apiKeyAuth(db));
  r.get("/me", w(async (req, res) => {
    const c = (await db.query("SELECT code, name FROM companies WHERE id=$1", [req.api.companyId])).rows[0];
    res.json({ company: c, key: req.api.name, scopes: req.api.scopes });
  }));
  const logWrite = (req: ApiReq, what: string, out: any) => audit(db, { companyId: req.api.companyId, action: `api.${what}`, target: `key:${req.api.name}`, detail: { inserted: out.inserted, updated: out.updated, errors: out.errors.length }, ip: req.ip });
  // ---- Products / SKUs ----
  const productSelect = "v.id, v.sku, v.external_id, i.code AS item_code, i.external_id AS item_external_id, i.name, i.category, i.kind, i.hsn, v.mrp, v.billing_price AS price, v.attrs, v.updated_at";
  const product = (x: any) => ({ ...x, mrp: Number(x.mrp), price: Number(x.price), attrs: parseJson(x.attrs, {}) });
  r.get("/products", need("products:read"), w((req, res) => list(db, req, res, { select: productSelect, from: "variants v JOIN items i ON i.id=v.item_id", where: "v.company_id=$1", ts: "v.updated_at" }, product)));
  r.get("/products/:id", need("products:read"), w(async (req, res) => {
    const x = (await db.query(`SELECT ${productSelect} FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 AND v.id=$2`, [req.api.companyId, Number(req.params.id)])).rows[0];
    if (!x) throw bad("not found", 404); res.json(product(x));
  }));
  r.post("/products/upsert", need("products:write"), w(async (req, res) => {
    const out = await upsertRows(db, req.api.companyId, "products", items(req.body));
    await logWrite(req, "products.upsert", out); res.json(out);
  }));

  // ---- Stock ----
  const stockSelect = "s.id, v.sku, v.external_id AS product_external_id, s.distributor_id, d.external_id AS distributor_external_id, s.batch_no, s.expiry, s.qty, s.updated_at";
  r.get("/stock", need("stock:read"), w((req, res) => list(db, req, res, { select: stockSelect, from: "stock s JOIN variants v ON v.id=s.variant_id LEFT JOIN users d ON d.id=s.distributor_id", where: "s.company_id=$1", ts: "s.updated_at" })));
  r.post("/stock/upsert", need("stock:write"), w(async (req, res) => {
    const out = await upsertRows(db, req.api.companyId, "stock", items(req.body));
    await logWrite(req, "stock.upsert", out); res.json(out);
  }));

  // ---- Customers (shops / outlets) ----
  const shopSelect = "s.id, s.code, s.external_id, s.name, s.owner_name, s.phone, s.address, s.city, s.pincode, s.state_code, s.gstin, s.credit_days, s.credit_limit, s.distributor_id, d.external_id AS distributor_external_id, s.updated_at";
  r.get("/customers", need("customers:read"), w((req, res) => list(db, req, res, { select: shopSelect, from: "shops s LEFT JOIN users d ON d.id=s.distributor_id", where: "s.company_id=$1", ts: "s.updated_at" })));
  r.get("/customers/:id", need("customers:read"), w(async (req, res) => {
    const x = (await db.query(`SELECT ${shopSelect} FROM shops s LEFT JOIN users d ON d.id=s.distributor_id WHERE s.company_id=$1 AND s.id=$2`, [req.api.companyId, Number(req.params.id)])).rows[0];
    if (!x) throw bad("not found", 404); res.json(x);
  }));
  r.post("/customers/upsert", need("customers:write"), w(async (req, res) => {
    const out = await upsertRows(db, req.api.companyId, "customers", items(req.body));
    await logWrite(req, "customers.upsert", out); res.json(out);
  }));

  // ---- Distributors ----
  const distSelect = "id, external_id, name, email, phone, active, updated_at";
  r.get("/distributors", need("distributors:read"), w((req, res) => list(db, req, res, { select: distSelect, from: "users", where: "company_id=$1 AND role='distributor'", ts: "updated_at" })));
  r.post("/distributors/upsert", need("distributors:write"), w(async (req, res) => {
    const out = await upsertRows(db, req.api.companyId, "distributors", items(req.body));
    await logWrite(req, "distributors.upsert", out); res.json(out);
  }));

  // ---- Orders ----
  const orderSelect = "o.id, o.client_ref, o.external_id, o.status, o.shop_id, s.code AS customer_code, s.external_id AS customer_external_id, o.distributor_id, o.rep_id, o.total, o.savings, o.created_at, o.updated_at";
  const withLines = async (rows: any[]) => {
    for (const o of rows) {
      o.total = Number(o.total); o.savings = Number(o.savings);
      o.lines = (await db.query("SELECT l.id, v.sku, v.external_id AS product_external_id, l.uom, l.qty, l.base_qty, l.price, l.discount_pct, l.amount, l.free FROM order_lines l JOIN variants v ON v.id=l.variant_id WHERE l.order_id=$1 ORDER BY l.id", [o.id])).rows
        .map(l => ({ ...l, price: Number(l.price), discount_pct: Number(l.discount_pct), amount: Number(l.amount) }));
    }
    return rows;
  };
  r.get("/orders", need("orders:read"), w(async (req, res) => {
    const { limit, page, since, offset } = pageArgs(req.query);
    const args: unknown[] = [req.api.companyId]; let where = "o.company_id=$1";
    if (since) { args.push(since); where += ` AND o.updated_at >= $${args.length}`; }
    if (req.query.status) { args.push(String(req.query.status)); where += ` AND o.status = $${args.length}`; }
    const rows = (await db.query(`SELECT ${orderSelect} FROM orders o JOIN shops s ON s.id=o.shop_id WHERE ${where} ORDER BY 1 LIMIT ${limit + 1} OFFSET ${offset}`, args)).rows;
    const more = rows.length > limit;
    res.json({ data: await withLines(more ? rows.slice(0, limit) : rows), page, limit, has_more: more, next_page: more ? page + 1 : null, server_time: new Date().toISOString() });
  }));
  r.get("/orders/:id", need("orders:read"), w(async (req, res) => {
    const x = (await db.query(`SELECT ${orderSelect} FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.company_id=$1 AND o.id=$2`, [req.api.companyId, Number(req.params.id)])).rows;
    if (!x[0]) throw bad("not found", 404); res.json((await withLines(x))[0]);
  }));
  // Write back the ERP's document number for an order (e.g. the SAP sales order or Odoo SO name).
  r.put("/orders/:id/external-id", need("orders:write"), w(async (req, res) => {
    const e = ext(req.body?.external_id); if (!e) throw bad("external_id required");
    const x = (await db.query("UPDATE orders SET external_id=$1, updated_at=NOW() WHERE company_id=$2 AND id=$3 RETURNING id, external_id", [e, req.api.companyId, Number(req.params.id)])).rows[0];
    if (!x) throw bad("not found", 404);
    await audit(db, { companyId: req.api.companyId, action: "api.orders.external_id", target: `order:${x.id}`, detail: { key: req.api.name, external_id: e }, ip: req.ip });
    res.json(x);
  }));

  // ---- Invoices, collections, users (read only) ----
  const invSelect = "i.id, i.number, i.external_id, i.kind, i.issuer, i.fy, i.doc_date, i.order_id, i.ref_invoice_id, i.shop_id, s.code AS customer_code, s.external_id AS customer_external_id, i.place_of_supply, i.intra_state, i.taxable, i.cgst, i.sgst, i.igst, i.round_off, i.total, i.irn, i.created_at";
  const num = (o: any, ks: string[]) => { for (const k of ks) if (o[k] != null) o[k] = Number(o[k]); return o; };
  r.get("/invoices", need("invoices:read"), w(async (req, res) => {
    const { limit, page, since, offset } = pageArgs(req.query);
    const args: unknown[] = [req.api.companyId]; let where = "i.company_id=$1";
    if (since) { args.push(since); where += ` AND i.created_at >= $${args.length}`; }
    const rows = (await db.query(`SELECT ${invSelect} FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE ${where} ORDER BY 1 LIMIT ${limit + 1} OFFSET ${offset}`, args)).rows;
    const more = rows.length > limit, data = more ? rows.slice(0, limit) : rows;
    for (const i of data) {
      num(i, ["taxable", "cgst", "sgst", "igst", "round_off", "total"]);
      i.lines = (await db.query("SELECT l.id, v.sku, l.description, l.hsn, l.base_qty, l.uom, l.rate, l.taxable, l.gst_rate, l.cgst, l.sgst, l.igst, l.total FROM invoice_lines l JOIN variants v ON v.id=l.variant_id WHERE l.invoice_id=$1 ORDER BY l.id", [i.id])).rows
        .map(l => num(l, ["rate", "taxable", "gst_rate", "cgst", "sgst", "igst", "total"]));
    }
    res.json({ data, page, limit, has_more: more, next_page: more ? page + 1 : null, server_time: new Date().toISOString() });
  }));
  r.get("/collections", need("collections:read"), w((req, res) => list(db, req, res, {
    select: "p.id, p.number, p.external_id, p.issuer, p.shop_id, s.code AS customer_code, s.external_id AS customer_external_id, p.pay_date, p.mode, p.reference, p.cheque_date, p.amount, p.status, p.bounce_reason, p.collected_by, p.created_at",
    from: "payments p JOIN shops s ON s.id=p.shop_id", where: "p.company_id=$1", ts: "p.created_at" }, p => ({ ...p, amount: Number(p.amount) }))));
  r.get("/users", need("users:read"), w((req, res) => list(db, req, res, { select: "id, external_id, name, email, phone, role, active, updated_at", from: "users", where: "company_id=$1", ts: "updated_at" })));

  r.use((_q, res) => res.status(404).json({ error: "not found" }));
  app.use("/api/v1", r);
}
