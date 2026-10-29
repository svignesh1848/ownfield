// Step 5c: trade schemes. Percent / flat-per-unit / buy-X-get-Y / qty-or-value slabs, scoped by product, category,
// distributor and validity dates. Applied automatically when orders are priced (and therefore on invoices built from them).
import type { Express } from "express";
import { bad, parseJson, parseDate, today } from "./catalog.js";
import { r2 } from "./billing.js";

export const SCHEME_TYPES = ["percent", "flat", "bxgy", "slab"] as const;
export type Scheme = { id: number; name: string; type: string; item_id: number | null; category: string | null; distributor_id: number | null;
  starts_on: string | null; ends_on: string | null; min_qty: number; discount_pct: number; config: any };
export type PriceLine = { vid: number; itemId: number; category: string | null; base: number; price: number };
export type Applied = { gross: number; amount: number; disc: number; schemeId: number | null; scheme: string | null; free: { base: number; schemeId: number; scheme: string } | null };

export async function activeSchemes(db: any, cid: number, on = today()): Promise<Scheme[]> {
  return (await db.query("SELECT * FROM schemes WHERE company_id=$1 AND active=TRUE ORDER BY id", [cid])).rows
    .map((s: any) => ({ ...s, type: s.type || "percent", min_qty: Number(s.min_qty), discount_pct: Number(s.discount_pct || 0), config: parseJson(s.config, {}) }))
    .filter((s: Scheme) => (!s.starts_on || s.starts_on <= on) && (!s.ends_on || s.ends_on >= on));
}

const inScope = (s: Scheme, l: PriceLine, dist: number | null) =>
  (s.item_id == null || s.item_id === l.itemId) && (!s.category || (l.category || "").toLowerCase() === s.category.toLowerCase()) &&
  (s.distributor_id == null || s.distributor_id === dist);

/** Discount (₹) a scheme gives on a line, or 0 if it doesn't qualify. bxgy is handled separately (free goods). */
function discountOf(s: Scheme, l: PriceLine, gross: number) {
  if (l.base < s.min_qty) return 0;
  if (s.type === "percent") return gross * s.discount_pct / 100;
  if (s.type === "flat") return Math.min(gross, Number(s.config.amount || 0) * l.base);
  if (s.type === "slab") {
    const v = s.config.basis === "value" ? gross : l.base;
    const hit = (s.config.slabs || []).filter((x: any) => v >= Number(x.min)).sort((a: any, b: any) => b.pct - a.pct)[0];
    return hit ? gross * Number(hit.pct) / 100 : 0;
  }
  return 0;
}

/** Best price-discount scheme per line + best buy-X-get-Y free quantity. Pure; used by order placement and preview. */
export function applySchemes(schemes: Scheme[], l: PriceLine, dist: number | null): Applied {
  const gross = r2(l.base * l.price);
  let best = { d: 0, s: null as Scheme | null };
  let free: Applied["free"] = null;
  for (const s of schemes) {
    if (!inScope(s, l, dist)) continue;
    if (s.type === "bxgy") {
      const buy = Number(s.config.buy), get = Number(s.config.get);
      const n = buy > 0 && l.base >= Math.max(buy, s.min_qty) ? Math.floor(l.base / buy) * get : 0;
      if (n > (free?.base ?? 0)) free = { base: n, schemeId: s.id, scheme: s.name };
    } else {
      const d = r2(discountOf(s, l, gross));
      if (d > best.d) best = { d, s };
    }
  }
  return { gross, amount: r2(gross - best.d), disc: gross ? r2(best.d / gross * 100) : 0, schemeId: best.s?.id ?? null, scheme: best.s?.name ?? null, free };
}

export function validateScheme(b: any) {
  const type = String(b.type || "percent");
  if (!(SCHEME_TYPES as readonly string[]).includes(type)) throw bad(`type must be one of ${SCHEME_TYPES.join(", ")}`);
  if (!b.name) throw bad("name required");
  const mq = Number(b.minQty ?? 1); if (!Number.isInteger(mq) || mq < 1) throw bad("minQty must be an integer ≥ 1");
  const startsOn = b.startsOn ? parseDate(b.startsOn) : null, endsOn = b.endsOn ? parseDate(b.endsOn) : null;
  if ((b.startsOn && !startsOn) || (b.endsOn && !endsOn)) throw bad("dates must be YYYY-MM-DD");
  if (startsOn && endsOn && startsOn > endsOn) throw bad("startsOn must be on or before endsOn");
  let pct = 0, config: any = {};
  if (type === "percent") { pct = Number(b.discountPct); if (!(pct > 0 && pct <= 100)) throw bad("discountPct must be 0–100"); }
  if (type === "flat") { const a = Number(b.amount); if (!(a > 0)) throw bad("amount (₹ off per base unit) must be > 0"); config = { amount: a }; }
  if (type === "bxgy") { const buy = Number(b.buy), get = Number(b.get); if (!(Number.isInteger(buy) && buy > 0 && Number.isInteger(get) && get > 0)) throw bad("buy and get must be positive integers"); config = { buy, get }; }
  if (type === "slab") {
    const basis = b.basis === "value" ? "value" : "qty";
    const slabs = (Array.isArray(b.slabs) ? b.slabs : []).map((x: any) => ({ min: Number(x.min), pct: Number(x.pct) }));
    if (!slabs.length || slabs.some((x: any) => !(x.min > 0) || !(x.pct > 0 && x.pct <= 100))) throw bad("slabs need min > 0 and pct 0–100");
    config = { basis, slabs: slabs.sort((a: any, c: any) => a.min - c.min) };
  }
  return { type, name: String(b.name), minQty: mq, pct, config, startsOn, endsOn, category: b.category ? String(b.category) : null,
    itemId: b.itemId == null || b.itemId === "" ? null : Number(b.itemId), distributorId: b.distributorId == null || b.distributorId === "" ? null : Number(b.distributorId) };
}

export function describeScheme(s: any) {
  const c = parseJson<any>(s.config, {});
  switch (s.type || "percent") {
    case "flat": return `₹${c.amount} off per unit`;
    case "bxgy": return `Buy ${c.buy} get ${c.get} free`;
    case "slab": return (c.slabs || []).map((x: any) => `${c.basis === "value" ? "₹" : ""}${x.min}+ → ${x.pct}%`).join(", ");
    default: return `${Number(s.discount_pct)}% off`;
  }
}

const ANY = ["company_admin", "manager", "sales_rep", "distributor"];
export function registerSchemeRoutes({ app, db, auth, wrap, tenant }: { app: Express; db: any; auth: (...r: any[]) => any; tenant: (req: any, res: any) => number | null; wrap: (fn: (req: any, res: any) => Promise<unknown>) => any }) {
  app.get("/api/schemes", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rows = (await db.query(`SELECT s.*, i.name AS item_name, u.name AS distributor_name FROM schemes s LEFT JOIN items i ON i.id=s.item_id
      LEFT JOIN users u ON u.id=s.distributor_id WHERE s.company_id=$1 ORDER BY s.id`, [cid])).rows;
    const t = today();
    res.json(rows.filter((s: any) => req.user.role !== "distributor" || s.distributor_id == null || s.distributor_id === req.user.uid)
      .map((s: any) => ({ ...s, type: s.type || "percent", config: parseJson(s.config, {}), rule: describeScheme(s), live: s.active && (!s.starts_on || s.starts_on <= t) && (!s.ends_on || s.ends_on >= t) })));
  }));
  app.post("/api/schemes", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const v = validateScheme(req.body || {});
    if (v.itemId != null && !(await db.query("SELECT id FROM items WHERE id=$1 AND company_id=$2", [v.itemId, cid])).rows[0]) throw bad("item not found", 404);
    if (v.distributorId != null && !(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='distributor'", [v.distributorId, cid])).rows[0]) throw bad("distributor not found", 404);
    res.status(201).json((await db.query(`INSERT INTO schemes (company_id,name,type,item_id,category,distributor_id,starts_on,ends_on,min_qty,discount_pct,config)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [cid, v.name, v.type, v.itemId, v.category, v.distributorId, v.startsOn, v.endsOn, v.minQty, v.pct, JSON.stringify(v.config)])).rows[0]);
  }));
  app.post("/api/schemes/:id/active", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = (await db.query("UPDATE schemes SET active=$1 WHERE id=$2 AND company_id=$3 RETURNING *", [!!req.body?.active, Number(req.params.id), cid])).rows[0];
    if (!r) throw bad("scheme not found", 404);
    res.json(r);
  }));
}

/** Scheme cost rows for the reports endpoint: discount given + value of free goods, per scheme. */
export async function schemeCost(db: any, cid: number, inRange: (d: string) => boolean, dayKey: (d: any) => string) {
  const rows = (await db.query(`SELECT l.order_id, l.scheme_id, l.free, l.base_qty, l.price, l.gross, l.amount, o.created_at, o.status, s.name, s.type, s.config, s.discount_pct
    FROM order_lines l JOIN orders o ON o.id=l.order_id JOIN schemes s ON s.id=l.scheme_id WHERE o.company_id=$1 AND o.status<>'rejected' ORDER BY s.id`, [cid])).rows
    .filter((r: any) => inRange(dayKey(r.created_at)));
  const m = new Map<number, any>();
  for (const r of rows) {
    const x = m.get(r.scheme_id) || { scheme: r.name, rule: describeScheme(r), orders: new Set(), discount: 0, free_qty: 0, free_value: 0 };
    x.orders.add(r.order_id);
    if (r.free) { x.free_qty += Number(r.base_qty); x.free_value = r2(x.free_value + Number(r.base_qty) * Number(r.price)); }
    else x.discount = r2(x.discount + Number(r.gross) - Number(r.amount));
    m.set(r.scheme_id, x);
  }
  return [...m.values()].map(x => ({ scheme: x.scheme, rule: x.rule, orders: x.orders.size, discount: x.discount, free_qty: x.free_qty, free_value: x.free_value, total_cost: r2(x.discount + x.free_value) }));
}
