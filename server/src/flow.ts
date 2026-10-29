// Field rules ("flow" settings) shared by several modules: no-order reasons, must-sell lists, expiry block, stock adjustment
// approval, GRN confirmation, claim approval rules, start/end day and retailer announcements. Kept in company_kv "flow".
import type { Db } from "./db.js";
import { bad } from "./catalog.js";
import { type Ctx, MGR, kvGet, kvSet, requireFeature, monthOk } from "./common.js";
import { emit } from "./integrations/webhooks.js";

export type Flow = {
  requireNoOrderReason: boolean; noOrderReasons: string[];
  mustSell: Record<string, string[]>;            // outlet type → SKUs ("*" = every outlet)
  expiryBlockDays: number;                        // don't sell batches expiring within N days (0 = only expired are blocked)
  adjustApproval: boolean; adjustReasons: string[]; grnConfirm: boolean;
  claimLevels: { kind: string; upTo: number; role: string }[]; // first matching row decides who may approve
  damageCapPct: number;                           // damage claims per distributor per month ≤ this % of primary (company→distributor) sales; 0 = off
  dayStart: boolean; selfie: boolean;             // Start/End Day with GPS, optional selfie
  announcements: { text: string; until?: string }[];
};
export const FLOW_DEFAULT: Flow = {
  requireNoOrderReason: true, noOrderReasons: ["Shop closed", "Owner not available", "Enough stock", "Payment pending", "Price issue", "Competitor scheme", "Other"],
  mustSell: {}, expiryBlockDays: 0, adjustApproval: false, adjustReasons: ["Damaged", "Expired", "Count correction", "Theft / loss", "Sample / free issue"], grnConfirm: false,
  claimLevels: [], damageCapPct: 0, dayStart: false, selfie: false, announcements: [],
};
export const getFlow = (db: Db, cid: number) => kvGet<Flow>(db, cid, "flow", FLOW_DEFAULT);

const strList = (v: unknown, max = 30) => Array.isArray(v) ? [...new Set(v.map(x => String(x).trim()).filter(Boolean).map(x => x.slice(0, 80)))].slice(0, max) : undefined;
export function cleanFlow(b: any, cur: Flow): Flow {
  const f = { ...cur };
  if (b.requireNoOrderReason != null) f.requireNoOrderReason = !!b.requireNoOrderReason;
  if (b.noOrderReasons != null) { const l = strList(b.noOrderReasons); if (!l) throw bad("reasons must be a list"); f.noOrderReasons = l; }
  if (b.mustSell != null) { if (typeof b.mustSell !== "object") throw bad("must-sell must map outlet type to product codes"); f.mustSell = {};
    for (const [k, v] of Object.entries(b.mustSell)) { const l = strList(v, 200); if (l?.length) f.mustSell[String(k).trim().slice(0, 40) || "*"] = l; } }
  if (b.expiryBlockDays != null) { const n = Number(b.expiryBlockDays); if (!Number.isInteger(n) || n < 0 || n > 365) throw bad("expiry block must be 0–365 days"); f.expiryBlockDays = n; }
  if (b.adjustApproval != null) f.adjustApproval = !!b.adjustApproval;
  if (b.adjustReasons != null) { const l = strList(b.adjustReasons); if (!l?.length) throw bad("add at least one adjustment reason"); f.adjustReasons = l; }
  if (b.grnConfirm != null) f.grnConfirm = !!b.grnConfirm;
  if (b.claimLevels != null) { if (!Array.isArray(b.claimLevels)) throw bad("approval levels must be a list");
    f.claimLevels = b.claimLevels.map((l: any) => ({ kind: String(l.kind || "*"), upTo: Number(l.upTo), role: String(l.role) })).filter((l: any) => l.upTo >= 0);
    if (f.claimLevels.some(l => !["manager", "company_admin"].includes(l.role))) throw bad("approver must be manager or company_admin"); }
  if (b.damageCapPct != null) { const n = Number(b.damageCapPct); if (!(n >= 0 && n <= 100)) throw bad("damage cap must be 0–100%"); f.damageCapPct = n; }
  if (b.dayStart != null) f.dayStart = !!b.dayStart;
  if (b.selfie != null) f.selfie = !!b.selfie;
  if (b.announcements != null) { if (!Array.isArray(b.announcements)) throw bad("announcements must be a list");
    f.announcements = b.announcements.map((a: any) => ({ text: String(a.text || "").trim().slice(0, 300), until: a.until ? String(a.until).slice(0, 10) : undefined })).filter((a: any) => a.text).slice(0, 10); }
  return f;
}

export function registerFlowRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/flow-settings", auth(...MGR, "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await getFlow(db, cid));
  }));
  app.put("/api/flow-settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const f = cleanFlow(req.body || {}, await getFlow(db, cid)); await kvSet(db, cid, "flow", f); res.json(f);
  }));
  // Must-sell: the list for an outlet's type (plus the "*" list for every outlet).
  app.get("/api/must-sell", auth(...MGR, "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const shop = (await db.query("SELECT id, outlet_type FROM shops WHERE id=$1 AND company_id=$2", [Number(req.query.shopId), cid])).rows[0]; if (!shop) throw bad("shop not found", 404);
    res.json({ outlet_type: shop.outlet_type, skus: mustSellFor(await getFlow(db, cid), shop.outlet_type) });
  }));
  app.post("/api/orders/suggest", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const shop = (await db.query("SELECT id FROM shops WHERE id=$1 AND company_id=$2", [Number(req.body?.shopId), cid])).rows[0]; if (!shop) throw bad("shop not found", 404);
    const shelf: Record<string, number> = {}; for (const [k, v] of Object.entries(req.body?.shelf || {})) { const n = Number(v); if (!(n >= 0)) throw bad("shelf stock must be ≥ 0"); shelf[k] = n; }
    res.json(await suggestOrder(db, cid, shop.id, shelf));
  }));
  app.post("/api/claims/auto-schemes", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "claims");
    const month = String(req.body?.month || ""); if (!monthOk(month)) throw bad("pick a month (YYYY-MM)");
    const made = await autoSchemeClaims(db, cid, month, req.user.role === "distributor" ? req.user.uid : null);
    res.json({ created: made.length, ids: made });
  }));
  app.put("/api/shops/:id/type", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const v = String(req.body?.outletType ?? "").trim().slice(0, 40) || null;
    const r = await db.query("UPDATE shops SET outlet_type=$1, updated_at=NOW() WHERE id=$2 AND company_id=$3 RETURNING id, outlet_type", [v, Number(req.params.id), cid]);
    if (!r.rows[0]) throw bad("shop not found", 404); res.json(r.rows[0]);
  }));
}
// Suggested order: average quantity over the outlet's last 3 orders, minus the shelf stock the rep counts. The rep can accept or edit.
export async function suggestOrder(db: Db, cid: number, shopId: number, shelf: Record<string, number>) {
  const last = (await db.query("SELECT id FROM orders WHERE company_id=$1 AND shop_id=$2 AND status<>'rejected' ORDER BY created_at DESC, id DESC LIMIT 3", [cid, shopId])).rows.map(r => r.id);
  if (!last.length) return { orders: 0, lines: [] as any[] };
  const rows = (await db.query(`SELECT v.sku, i.name, l.base_qty AS q, l.free FROM order_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
    WHERE l.order_id IN (${last.map((_, k) => `$${k + 1}`).join(",")})`, last)).rows.filter(r => !r.free);
  const by = new Map<string, { name: string; total: number }>();
  for (const r of rows) { const x = by.get(r.sku) || { name: r.name, total: 0 }; x.total += Number(r.q); by.set(r.sku, x); }
  const lines = [...by].map(([sku, x]) => { const avg = Math.round((x.total / last.length) * 10) / 10, sh = Math.max(0, Number(shelf[sku]) || 0);
    return { sku, name: x.name, avg, shelf: sh, suggested: Math.max(0, Math.ceil(avg - sh)) }; }).sort((a, b) => a.sku.localeCompare(b.sku));
  return { orders: last.length, lines };
}
/** Scheme claims from invoices: for each distributor and scheme, the discount (incl. free goods) it gave on its invoices in the month.
 *  One claim per distributor + scheme + month (auto_ref keeps it from being created twice). */
export async function autoSchemeClaims(db: Db, cid: number, month: string, distributorId: number | null) {
  const lo = `${month}-01`, hi = `${month}-31`;
  const rows = (await db.query(`SELECT i.issuer, i.number, l.scheme_id, l.gross, l.amount FROM invoices i JOIN order_lines l ON l.order_id=i.order_id
    WHERE i.company_id=$1 AND i.kind='invoice' AND i.issuer LIKE 'd%' AND i.doc_date>=$2 AND i.doc_date<=$3 AND l.scheme_id IS NOT NULL`, [cid, lo, hi])).rows;
  const groups = new Map<string, { dist: number; scheme: number; amount: number; invoices: Set<string> }>();
  for (const r of rows) {
    const dist = Number(String(r.issuer).slice(1)); if (distributorId != null && dist !== distributorId) continue;
    const k = `${dist}:${r.scheme_id}`, g = groups.get(k) || { dist, scheme: r.scheme_id, amount: 0, invoices: new Set<string>() };
    g.amount += Number(r.gross) - Number(r.amount); g.invoices.add(r.number); groups.set(k, g);
  }
  const made: number[] = [];
  for (const g of groups.values()) {
    const amount = Math.round(g.amount * 100) / 100; if (amount <= 0) continue;
    const ref = `scheme:${g.dist}:${g.scheme}:${month}`;
    if ((await db.query("SELECT id FROM claims WHERE company_id=$1 AND auto_ref=$2", [cid, ref])).rows[0]) continue;
    const sc = (await db.query("SELECT name FROM schemes WHERE id=$1", [g.scheme])).rows[0];
    const c = (await db.query("INSERT INTO claims (company_id,distributor_id,kind,scheme_id,description,lines,amount,auto_ref) VALUES ($1,$2,'scheme',$3,$4,$5,$6,$7) RETURNING id",
      [cid, g.dist, g.scheme, `Scheme ${sc?.name ?? g.scheme} on invoices in ${month} (auto): ${[...g.invoices].slice(0, 20).join(", ")}${g.invoices.size > 20 ? " …" : ""}`.slice(0, 500), "[]", amount, ref])).rows[0];
    await emit(db, cid, "claim.submitted", { id: c.id, kind: "scheme", amount, distributor_id: g.dist, auto: true }); made.push(c.id);
  }
  return made;
}
export const mustSellFor = (f: Flow, type: string | null) => [...new Set([...(f.mustSell["*"] || []), ...(type ? f.mustSell[type] || [] : [])])];
/** Must-sell compliance: orders that contain every must-sell SKU for the outlet, per rep. */
export async function mustSellStats(db: Db, cid: number, lo: string, hi: string) {
  const f = await getFlow(db, cid); if (!Object.keys(f.mustSell).length) return new Map<number, { orders: number; complete: number; missing: Record<string, number> }>();
  const rows = (await db.query(`SELECT o.id, o.rep_id, s.outlet_type, v.sku FROM orders o JOIN shops s ON s.id=o.shop_id JOIN order_lines l ON l.order_id=o.id JOIN variants v ON v.id=l.variant_id
    WHERE o.company_id=$1 AND o.created_at>=$2 AND o.created_at<$3 AND o.status<>'rejected' AND o.rep_id IS NOT NULL`, [cid, lo, hi])).rows;
  const byOrder = new Map<number, { rep: number; type: string | null; skus: Set<string> }>();
  for (const r of rows) { const o = byOrder.get(r.id) || { rep: r.rep_id, type: r.outlet_type, skus: new Set<string>() }; o.skus.add(r.sku); byOrder.set(r.id, o); }
  const out = new Map<number, { orders: number; complete: number; missing: Record<string, number> }>();
  for (const o of byOrder.values()) {
    const need = mustSellFor(f, o.type); if (!need.length) continue;
    const st = out.get(o.rep) || { orders: 0, complete: 0, missing: {} }; st.orders++;
    const miss = need.filter(k => !o.skus.has(k)); if (!miss.length) st.complete++; for (const k of miss) st.missing[k] = (st.missing[k] || 0) + 1;
    out.set(o.rep, st);
  }
  return out;
}
