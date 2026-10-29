// Canonical OwnField records that mappings read from. Field lists below drive the admin field mapper's pick lists.
import type { Db } from "../db.js";
import { parseJson } from "../catalog.js";
import type { OutEntity, InEntity } from "./types.js";

const n = (x: any) => (x == null ? x : Number(x));
const CUSTOMER = ["customer.id", "customer.code", "customer.external_id", "customer.name", "customer.gstin", "customer.city", "customer.state_code", "customer.pincode", "customer.phone", "customer.address"];
export const FIELDS: Record<OutEntity | InEntity, string[]> = {
  orders: ["id", "client_ref", "external_id", "status", "date", "created_at", "total", "savings", ...CUSTOMER, "distributor.id", "distributor.external_id", "distributor.name", "rep.name", "rep.email",
    "lines", "lines[].sku", "lines[].product_external_id", "lines[].name", "lines[].hsn", "lines[].qty", "lines[].uom", "lines[].base_qty", "lines[].price", "lines[].discount_pct", "lines[].amount", "lines[].free"],
  invoices: ["id", "number", "external_id", "kind", "doc_date", "order_id", "taxable", "cgst", "sgst", "igst", "round_off", "total", "irn", "place_of_supply", ...CUSTOMER,
    "lines", "lines[].sku", "lines[].description", "lines[].hsn", "lines[].base_qty", "lines[].uom", "lines[].rate", "lines[].taxable", "lines[].gst_rate", "lines[].cgst", "lines[].sgst", "lines[].igst", "lines[].total"],
  collections: ["id", "number", "external_id", "pay_date", "mode", "reference", "cheque_date", "amount", "status", ...CUSTOMER],
  stock: ["sku", "product_external_id", "distributor_id", "distributor_external_id", "batch_no", "expiry", "qty"],
  products: ["external_id", "sku", "barcode", "item_code", "item_external_id", "name", "category", "hsn", "mrp", "price", "units"],
  customers: ["external_id", "code", "name", "owner_name", "phone", "address", "city", "pincode", "state_code", "gstin", "credit_days", "credit_limit", "distributor_external_id"],
  distributors: ["external_id", "name", "email", "phone"],
};

async function customer(db: Db, id: number) {
  return (await db.query("SELECT id, code, external_id, name, gstin, city, state_code, pincode, phone, address FROM shops WHERE id=$1", [id])).rows[0] || {};
}
export async function loadRecord(db: Db, cid: number, entity: OutEntity, id: number): Promise<Record<string, any> | null> {
  if (entity === "orders") {
    const o = (await db.query("SELECT * FROM orders WHERE company_id=$1 AND id=$2", [cid, id])).rows[0]; if (!o) return null;
    const lines = (await db.query(`SELECT v.sku, v.external_id AS product_external_id, i.name, i.hsn, l.qty, l.uom, l.base_qty, l.price, l.discount_pct, l.amount, l.free, v.attrs
      FROM order_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id WHERE l.order_id=$1 ORDER BY l.id`, [id])).rows
      .map(l => ({ ...l, price: n(l.price), discount_pct: n(l.discount_pct), amount: n(l.amount), attrs: parseJson(l.attrs, {}) }));
    const d = o.distributor_id ? (await db.query("SELECT id, external_id, name, email FROM users WHERE id=$1", [o.distributor_id])).rows[0] : null;
    const rep = (await db.query("SELECT name, email FROM users WHERE id=$1", [o.rep_id])).rows[0] || {};
    return { id: o.id, client_ref: o.client_ref, external_id: o.external_id, status: o.status, created_at: new Date(o.created_at).toISOString(), created_ms: new Date(o.created_at).getTime(), date: new Date(o.created_at).toISOString().slice(0, 10),
      total: n(o.total), savings: n(o.savings), customer: await customer(db, o.shop_id), distributor: d || {}, rep, lines };
  }
  if (entity === "invoices") {
    const i = (await db.query("SELECT * FROM invoices WHERE company_id=$1 AND id=$2", [cid, id])).rows[0]; if (!i) return null;
    const lines = (await db.query("SELECT v.sku, l.description, l.hsn, l.base_qty, l.uom, l.rate, l.taxable, l.gst_rate, l.cgst, l.sgst, l.igst, l.total FROM invoice_lines l JOIN variants v ON v.id=l.variant_id WHERE l.invoice_id=$1 ORDER BY l.id", [id])).rows
      .map(l => ({ ...l, rate: n(l.rate), taxable: n(l.taxable), gst_rate: n(l.gst_rate), cgst: n(l.cgst), sgst: n(l.sgst), igst: n(l.igst), total: n(l.total) }));
    return { id: i.id, number: i.number, external_id: i.external_id, kind: i.kind, doc_date: i.doc_date, order_id: i.order_id, taxable: n(i.taxable), cgst: n(i.cgst), sgst: n(i.sgst), igst: n(i.igst),
      round_off: n(i.round_off), total: n(i.total), irn: i.irn, place_of_supply: i.place_of_supply, customer: await customer(db, i.shop_id), lines };
  }
  if (entity === "collections") {
    const p = (await db.query("SELECT * FROM payments WHERE company_id=$1 AND id=$2", [cid, id])).rows[0]; if (!p) return null;
    return { id: p.id, number: p.number, external_id: p.external_id, pay_date: p.pay_date, mode: p.mode, reference: p.reference, cheque_date: p.cheque_date, amount: n(p.amount), status: p.status, customer: await customer(db, p.shop_id) };
  }
  return null;
}
/** Ids of records changed since a time (for scheduled pushes and file exports). */
export async function changedIds(db: Db, cid: number, entity: OutEntity, since: string | null, limit = 200): Promise<number[]> {
  const t = { orders: ["orders", "updated_at"], invoices: ["invoices", "created_at"], collections: ["payments", "created_at"], stock: ["stock", "updated_at"] }[entity];
  const args: unknown[] = [cid]; let w = "company_id=$1"; if (since) { args.push(since); w += " AND " + t[1] + " >= $2"; }
  return (await db.query(`SELECT id FROM ${t[0]} WHERE ${w} ORDER BY id LIMIT ${limit}`, args)).rows.map(r => r.id);
}
export async function stockRows(db: Db, cid: number) {
  return (await db.query(`SELECT v.sku, v.external_id AS product_external_id, s.distributor_id, d.external_id AS distributor_external_id, s.batch_no, s.expiry, s.qty
    FROM stock s JOIN variants v ON v.id=s.variant_id LEFT JOIN users d ON d.id=s.distributor_id WHERE s.company_id=$1 ORDER BY s.id LIMIT 5000`, [cid])).rows;
}
