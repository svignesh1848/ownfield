// SPDX-License-Identifier: AGPL-3.0-only
// Report builder data sources. This is the ONLY place that knows table names: users pick sources/fields by key,
// never SQL. Every source query is fixed text below, always scoped by company ($1) and, when it has a date, by an
// IST date range ($2 = from 00:00 IST, $3 = to+1 day 00:00 IST, as timestamps or YYYY-MM-DD text).
// To add a data source or a field, see "Custom reports → Adding a data source" in README.md.
import type { Db } from "../db.js";
import { dayKey } from "../field.js";
import { parseJson } from "../catalog.js";
import { ledger } from "../collections.js";

export type FieldType = "text" | "number" | "money" | "date" | "bool";
export type Field = { label: string; type: FieldType; get: (r: any) => unknown };
/** Standard filters every source may support. The value is the SQL column (in the source's FROM) to compare. */
export type Dim = "rep" | "distributor" | "shop" | "area" | "beat" | "product" | "category";
export type Where = { sql: string; args: unknown[]; checks: [string, unknown[]][] };
export type Range = { from: string; to: string; lo: string; hi: string };
export type Source = {
  label: string; description: string;
  /** Fixed SQL. Must contain "WHERE <company col>=$1" and, when dateKind is set, use $2/$3 for the coarse date range. */
  sql: string;
  /** "ts" = TIMESTAMPTZ compared with $2/$3 as instants; "text" = YYYY-MM-DD column compared with $2/$3 as dates; null = no date. */
  dateKind: "ts" | "text" | null;
  /** Field (key) holding the IST day used for date ranges, comparisons and day/week/month grouping. */
  dateField?: string;
  dims: Partial<Record<Dim, string>>;
  fields: Record<string, Field>;
  /** Optional: add computed values after loading (e.g. productive call). Runs on at most MAX_ROWS rows. */
  enrich?: (db: Db, cid: number, rows: any[], range: Range | null) => Promise<void>;
  /** Optional: build rows in code instead of SQL (still company scoped). */
  load?: (db: Db, cid: number, range: Range | null, where: Where) => Promise<any[]>;
  /** Max days in one run (protects generated sources). */
  maxDays?: number;
  /** No date column, but enrich() uses the chosen date range (e.g. rep activity in the period). */
  usesRange?: boolean;
};

const n = (v: unknown) => v == null || v === "" ? null : Number(v);
const txt = (v: unknown) => v == null ? "" : String(v);
const f = (label: string, type: FieldType, get: (r: any) => unknown): Field => ({ label, type, get });
const col = (label: string, type: FieldType, k: string): Field => f(label, type, r => type === "number" || type === "money" ? n(r[k]) : type === "bool" ? !!r[k] : type === "date" ? (r[k] ? (String(r[k]).length === 10 ? String(r[k]) : dayKey(r[k])) : "") : txt(r[k]));
const attrs = (v: unknown) => Object.values(parseJson<Record<string, unknown>>(v, {})).join(" / ");

const SHOP_FIELDS = { outlet: col("Outlet", "text", "shop_name"), outlet_code: col("Outlet code", "text", "shop_code"), area: col("Area / city", "text", "shop_city"), outlet_type: col("Outlet type", "text", "shop_type") };
const SHOP_COLS = "s.name AS shop_name, s.code AS shop_code, s.city AS shop_city, s.outlet_type AS shop_type";
const beatDim = (shopCol: string) => `${shopCol} IN (SELECT bs.shop_id FROM beat_shops bs WHERE bs.beat_id IN (?))`;

export const SOURCES: Record<string, Source> = {
  orders: {
    label: "Orders", description: "One row per order (header).",
    sql: `SELECT o.id, o.created_at, o.status, o.total, o.savings, r.name AS rep_name, d.name AS dist_name, ${SHOP_COLS}
      FROM orders o JOIN users r ON r.id=o.rep_id JOIN shops s ON s.id=o.shop_id LEFT JOIN users d ON d.id=o.distributor_id WHERE o.company_id=$1 AND o.created_at>=$2 AND o.created_at<$3`,
    dateKind: "ts", dateField: "date",
    dims: { rep: "o.rep_id", distributor: "o.distributor_id", shop: "o.shop_id", area: "s.city", beat: beatDim("o.shop_id") },
    fields: { order_id: col("Order no.", "number", "id"), date: col("Date", "date", "created_at"), status: col("Status", "text", "status"), rep: col("Sales rep", "text", "rep_name"),
      distributor: f("Distributor", "text", r => r.dist_name || "Company"), ...SHOP_FIELDS, value: col("Order value", "money", "total"), savings: col("Discount given", "money", "savings") },
  },
  order_lines: {
    label: "Order lines (products)", description: "One row per product line in an order.",
    sql: `SELECT o.id, o.created_at, o.status, l.qty, l.base_qty, l.uom, l.price, l.discount_pct, l.amount, l.free, v.sku, v.attrs, i.name AS item_name, i.category, r.name AS rep_name, d.name AS dist_name, ${SHOP_COLS}
      FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id JOIN users r ON r.id=o.rep_id JOIN shops s ON s.id=o.shop_id
      LEFT JOIN users d ON d.id=o.distributor_id WHERE o.company_id=$1 AND o.created_at>=$2 AND o.created_at<$3`,
    dateKind: "ts", dateField: "date",
    dims: { rep: "o.rep_id", distributor: "o.distributor_id", shop: "o.shop_id", area: "s.city", beat: beatDim("o.shop_id"), product: "v.item_id", category: "i.category" },
    fields: { order_id: col("Order no.", "number", "id"), date: col("Date", "date", "created_at"), status: col("Status", "text", "status"), rep: col("Sales rep", "text", "rep_name"),
      distributor: f("Distributor", "text", r => r.dist_name || "Company"), ...SHOP_FIELDS, product: col("Product", "text", "item_name"), sku: col("Product code", "text", "sku"),
      variant: f("Variant", "text", r => attrs(r.attrs)), category: f("Category", "text", r => r.category || "—"), qty: col("Qty (base units)", "number", "base_qty"),
      price: col("Price", "money", "price"), discount_pct: col("Discount %", "number", "discount_pct"), value: col("Line value", "money", "amount"), free: col("Free item", "bool", "free") },
  },
  visits: {
    label: "Visits (calls)", description: "One row per outlet visit. Productive = an order was taken at that outlet the same day.",
    sql: `SELECT v.id, v.rep_id, v.shop_id, v.check_in_at, v.check_out_at, v.no_order_reason, r.name AS rep_name, ${SHOP_COLS}
      FROM visits v JOIN users r ON r.id=v.rep_id JOIN shops s ON s.id=v.shop_id WHERE v.company_id=$1 AND v.check_in_at>=$2 AND v.check_in_at<$3`,
    dateKind: "ts", dateField: "date",
    dims: { rep: "v.rep_id", distributor: "s.distributor_id", shop: "v.shop_id", area: "s.city", beat: beatDim("v.shop_id") },
    fields: { visit_id: col("Visit no.", "number", "id"), date: col("Date", "date", "check_in_at"), rep: col("Sales rep", "text", "rep_name"), ...SHOP_FIELDS,
      minutes: f("Minutes at outlet", "number", r => r.check_out_at ? Math.round((+new Date(r.check_out_at) - +new Date(r.check_in_at)) / 60000) : null),
      productive: f("Productive call (1 = yes)", "number", r => r._productive ? 1 : 0), no_order_reason: f("No-order reason", "text", r => r.no_order_reason || "") },
    enrich: async (db, cid, rows, range) => {
      if (!rows.length || !range) return;
      const o = (await db.query("SELECT rep_id, shop_id, created_at FROM orders WHERE company_id=$1 AND created_at>=$2 AND created_at<$3 AND status<>'rejected'", [cid, range.lo, range.hi])).rows;
      const sold = new Set(o.map(x => `${x.rep_id}|${x.shop_id}|${dayKey(x.created_at)}`));
      for (const r of rows) r._productive = !r.no_order_reason && sold.has(`${r.rep_id}|${r.shop_id}|${dayKey(r.check_in_at)}`);
    },
  },
  beat_plan: {
    label: "Beat plan vs visits", description: "One row per planned outlet call (from beat plans) per day, with whether it was visited.",
    sql: "", dateKind: "ts", dateField: "date", maxDays: 92,
    dims: { rep: "b.rep_id", shop: "bs.shop_id", area: "s.city", beat: "b.id", distributor: "s.distributor_id" },
    fields: { date: col("Date", "date", "day"), rep: col("Sales rep", "text", "rep_name"), beat: col("Beat", "text", "beat_name"), ...SHOP_FIELDS,
      planned: f("Planned", "number", () => 1), visited: f("Visited", "number", r => r.visited ? 1 : 0), missed: f("Missed", "number", r => r.visited ? 0 : 1) },
    load: async (db, cid, range, where) => {
      if (!range) return [];
      const plan = (await db.query(`SELECT b.id AS beat_id, b.name AS beat_name, b.rep_id, b.weekday, bs.shop_id, r.name AS rep_name, ${SHOP_COLS}
        FROM beats b JOIN beat_shops bs ON bs.beat_id=b.id JOIN shops s ON s.id=bs.shop_id JOIN users r ON r.id=b.rep_id WHERE b.company_id=$1${where.sql}`, [cid, ...where.args])).rows;
      const seen = new Set((await db.query("SELECT rep_id, shop_id, check_in_at FROM visits WHERE company_id=$1 AND check_in_at>=$2 AND check_in_at<$3", [cid, range.lo, range.hi])).rows
        .map(v => `${v.rep_id}|${v.shop_id}|${dayKey(v.check_in_at)}`));
      const out: any[] = [];
      for (let d = new Date(range.from + "T00:00:00Z"); d <= new Date(range.to + "T00:00:00Z"); d = new Date(+d + 864e5)) {
        const day = d.toISOString().slice(0, 10), wd = d.getUTCDay();
        for (const p of plan) if (p.weekday == null ? wd !== 0 : Number(p.weekday) === wd) out.push({ ...p, day, visited: seen.has(`${p.rep_id}|${p.shop_id}|${day}`) });
      }
      return out;
    },
  },
  attendance: {
    label: "Attendance (work day)", description: "One row per rep per day they started work.",
    sql: `SELECT d.day, d.start_at, d.end_at, r.name AS rep_name FROM rep_days d JOIN users r ON r.id=d.rep_id WHERE d.company_id=$1 AND d.day>=$2 AND d.day<=$3`,
    dateKind: "text", dateField: "date", dims: { rep: "d.rep_id" },
    fields: { date: col("Date", "date", "day"), rep: col("Sales rep", "text", "rep_name"),
      start: f("Start time", "text", r => r.start_at ? new Date(r.start_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : ""),
      end: f("End time", "text", r => r.end_at ? new Date(r.end_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : ""),
      hours: f("Hours worked", "number", r => r.start_at && r.end_at ? Math.round((+new Date(r.end_at) - +new Date(r.start_at)) / 36e5 * 10) / 10 : null),
      present: f("Present", "number", () => 1) },
  },
  collections: {
    label: "Collections (payments)", description: "One row per payment received.",
    sql: `SELECT p.number, p.pay_date, p.mode, p.status, p.amount, p.issuer, c.name AS rep_name, ${SHOP_COLS}
      FROM payments p JOIN shops s ON s.id=p.shop_id LEFT JOIN users c ON c.id=p.collected_by WHERE p.company_id=$1 AND p.pay_date>=$2 AND p.pay_date<=$3`,
    dateKind: "text", dateField: "date",
    dims: { rep: "p.collected_by", shop: "p.shop_id", area: "s.city", beat: beatDim("p.shop_id"), distributor: "s.distributor_id" },
    fields: { receipt: col("Receipt no.", "text", "number"), date: col("Date", "date", "pay_date"), mode: f("Mode", "text", r => String(r.mode || "").toUpperCase()), status: col("Status", "text", "status"),
      rep: f("Collected by", "text", r => r.rep_name || ""), ...SHOP_FIELDS, amount: col("Amount", "money", "amount") },
  },
  outstanding: {
    label: "Outstanding invoices (ageing)", description: "Unpaid invoices today with age in days and ageing bucket.",
    sql: "", dateKind: null, dims: { shop: "shop_id", area: "city", distributor: "distributor_id" },
    fields: { invoice: col("Invoice no.", "text", "number"), date: col("Invoice date", "date", "doc_date"), ...SHOP_FIELDS, issuer: f("Billed by", "text", r => r.seller || ""),
      age: col("Age (days)", "number", "age"), bucket: col("Ageing bucket", "text", "bucket"), outstanding: col("Outstanding", "money", "outstanding") },
    load: async (db, cid, _r, where) => {
      const shops = new Map((await db.query(`SELECT s.id, ${SHOP_COLS}, s.city, s.distributor_id FROM shops s WHERE s.company_id=$1`, [cid])).rows.map((s: any) => [s.id, s]));
      const { invoices } = await ledger(db, cid);
      return invoices.filter(i => i.outstanding > 0.004).map(i => ({ ...i, ...shops.get(i.shop_id) })).filter(r => matchDims(r, where));
    },
  },
  returns: {
    label: "Returns (credit notes)", description: "One row per credit note.",
    sql: `SELECT i.number, i.doc_date, i.reason, i.taxable, i.total, ${SHOP_COLS} FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE i.company_id=$1 AND i.kind='credit_note' AND i.doc_date>=$2 AND i.doc_date<=$3`,
    dateKind: "text", dateField: "date", dims: { shop: "i.shop_id", area: "s.city", beat: beatDim("i.shop_id"), distributor: "s.distributor_id" },
    fields: { number: col("Credit note no.", "text", "number"), date: col("Date", "date", "doc_date"), ...SHOP_FIELDS, reason: col("Reason", "text", "reason"),
      taxable: col("Value before tax", "money", "taxable"), total: col("Total", "money", "total") },
  },
  invoices: {
    label: "Invoices", description: "One row per invoice.",
    sql: `SELECT i.number, i.doc_date, i.issuer, i.taxable, i.total, i.cgst, i.sgst, i.igst, ${SHOP_COLS} FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE i.company_id=$1 AND i.kind='invoice' AND i.doc_date>=$2 AND i.doc_date<=$3`,
    dateKind: "text", dateField: "date", dims: { shop: "i.shop_id", area: "s.city", beat: beatDim("i.shop_id"), distributor: "s.distributor_id" },
    fields: { number: col("Invoice no.", "text", "number"), date: col("Date", "date", "doc_date"), ...SHOP_FIELDS, taxable: col("Value before tax", "money", "taxable"),
      tax: f("Tax", "money", r => Number(r.cgst) + Number(r.sgst) + Number(r.igst)), total: col("Total", "money", "total") },
  },
  stock: {
    label: "Stock (current)", description: "Current stock by location, product and batch.",
    sql: `SELECT st.qty, st.batch_no, st.expiry, v.sku, v.attrs, v.billing_price, i.name AS item_name, i.category, u.name AS loc FROM stock st JOIN variants v ON v.id=st.variant_id JOIN items i ON i.id=v.item_id
      LEFT JOIN users u ON u.id=st.distributor_id WHERE st.company_id=$1`,
    dateKind: null, dims: { distributor: "st.distributor_id", product: "v.item_id", category: "i.category" },
    fields: { location: f("Location", "text", r => r.loc || "Company stock"), product: col("Product", "text", "item_name"), sku: col("Product code", "text", "sku"), variant: f("Variant", "text", r => attrs(r.attrs)),
      category: f("Category", "text", r => r.category || "—"), batch: col("Batch", "text", "batch_no"), expiry: col("Expiry", "text", "expiry"), qty: col("Qty (base units)", "number", "qty"),
      value: f("Stock value", "money", r => Math.round(Number(r.qty) * Number(r.billing_price) * 100) / 100) },
  },
  shops: {
    label: "Outlets", description: "One row per outlet, with ordering activity in the chosen period and days since the last order.",
    sql: `SELECT s.id, s.credit_limit, d.name AS dist_name, ${SHOP_COLS} FROM shops s LEFT JOIN users d ON d.id=s.distributor_id WHERE s.company_id=$1`,
    dateKind: null, dims: { shop: "s.id", area: "s.city", beat: beatDim("s.id"), distributor: "s.distributor_id" },
    fields: { ...SHOP_FIELDS, distributor: f("Distributor", "text", r => r.dist_name || "Company"), credit_limit: col("Credit limit", "money", "credit_limit"),
      last_order: f("Last order date", "date", r => r._last || ""), days_since_order: f("Days since last order", "number", r => r._last ? Math.round((Date.now() - Date.parse(r._last + "T00:00:00+05:30")) / 864e5) : null),
      orders_90d: f("Orders (last 90 days)", "number", r => r._n90 || 0), value_90d: f("Order value (last 90 days)", "money", r => Math.round((r._v90 || 0) * 100) / 100),
      at_risk: f("At risk (no order 30+ days)", "bool", r => !r._last || (Date.now() - Date.parse(r._last + "T00:00:00+05:30")) / 864e5 > 30) },
    enrich: async (db, cid, rows) => {
      if (!rows.length) return;
      const lo = new Date(Date.now() - 90 * 864e5).toISOString();
      const o = (await db.query("SELECT shop_id, created_at, total FROM orders WHERE company_id=$1 AND status<>'rejected'", [cid])).rows;
      const m = new Map<number, any>(rows.map(r => [r.id, r]));
      for (const x of o) { const r = m.get(x.shop_id); if (!r) continue; const d = dayKey(x.created_at); if (!r._last || d > r._last) r._last = d;
        if (new Date(x.created_at).toISOString() >= lo) { r._n90 = (r._n90 || 0) + 1; r._v90 = (r._v90 || 0) + Number(x.total); } }
    },
  },
  reps: {
    label: "Sales reps", description: "One row per sales rep with orders, value and visits in the chosen period.",
    sql: `SELECT u.id, u.name, u.email, u.active FROM users u WHERE u.company_id=$1 AND u.role='sales_rep'`,
    dateKind: null, usesRange: true, dims: { rep: "u.id" },
    fields: { rep: col("Sales rep", "text", "name"), email: col("Email", "text", "email"), active: col("Active", "bool", "active"),
      orders: f("Orders", "number", r => r._o || 0), value: f("Order value", "money", r => Math.round((r._v || 0) * 100) / 100), visits: f("Visits", "number", r => r._vi || 0),
      outlets: f("Outlets ordered", "number", r => r._s?.size || 0) },
    enrich: async (db, cid, rows, range) => {
      if (!rows.length) return;
      const lo = range?.lo ?? new Date(Date.now() - 30 * 864e5).toISOString(), hi = range?.hi ?? new Date(Date.now() + 864e5).toISOString();
      const m = new Map<number, any>(rows.map(r => [r.id, r]));
      for (const x of (await db.query("SELECT rep_id, shop_id, total FROM orders WHERE company_id=$1 AND created_at>=$2 AND created_at<$3 AND status<>'rejected'", [cid, lo, hi])).rows) {
        const r = m.get(x.rep_id); if (!r) continue; r._o = (r._o || 0) + 1; r._v = (r._v || 0) + Number(x.total); (r._s ||= new Set()).add(x.shop_id); }
      for (const x of (await db.query("SELECT rep_id FROM visits WHERE company_id=$1 AND check_in_at>=$2 AND check_in_at<$3", [cid, lo, hi])).rows) { const r = m.get(x.rep_id); if (r) r._vi = (r._vi || 0) + 1; }
    },
  },
};

/** In-memory dim check for code-built sources (keys of the row named by the dim column). */
function matchDims(r: any, where: Where) {
  return where.checks.every(([k, vs]) => vs.map(String).includes(String(r[k])));
}

export const DIMS: Record<Dim, string> = { rep: "Sales rep", distributor: "Distributor", shop: "Outlet", area: "Area / city", beat: "Beat", product: "Product", category: "Category" };
