// Van sales: load stock onto a rep's van for the day, sell and invoice on the spot, and reconcile at day end.
// Van stock is its own ledger (van_lines); loaded − sold = expected at day end, and the counted figure shows any variance.
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, today, getCompany } from "./catalog.js";
import { priceLines } from "./field.js";
import { invoiceOrder, loadInvoice } from "./billing.js";
import { emit } from "./integrations/webhooks.js";
import { type Ctx, MGR, requireFeature } from "./common.js";

async function openLoad(db: Db, cid: number, repId: number) {
  return (await db.query("SELECT * FROM van_loads WHERE company_id=$1 AND rep_id=$2 AND status='open' ORDER BY id DESC LIMIT 1", [cid, repId])).rows[0] ?? null;
}
export async function vanSummary(db: Db, load: any) {
  if (!load) return null;
  const lines = (await db.query(`SELECT l.variant_id, v.sku, v.barcode, i.name, l.loaded, l.sold, l.counted FROM van_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
    WHERE l.load_id=$1 ORDER BY v.sku`, [load.id])).rows.map(l => {
      const expected = l.loaded - l.sold;
      return { ...l, left: expected, expected, variance: l.counted == null ? null : l.counted - expected };
    });
  const orders = (await db.query("SELECT o.id, o.client_ref, o.total, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.van_load_id=$1 ORDER BY o.id", [load.id])).rows
    .map(o => ({ ...o, total: Number(o.total) }));
  return { ...load, lines, orders, sales_total: Math.round(orders.reduce((a, o) => a + o.total, 0) * 100) / 100 };
}

export function registerVanRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  // Load (or top up) today's van. Managers load for a rep; a rep can record their own load.
  app.post("/api/van/load", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const repId = req.user.role === "sales_rep" ? req.user.uid : Number(req.body?.repId);
    if (!(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='sales_rep' AND active=TRUE", [repId, cid])).rows[0]) throw bad("pick a sales rep");
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!lines.length) throw bad("add at least one product with a quantity");
    const load = await withTx(db, async tx => {
      let L = await openLoad(tx, cid, repId);
      if (!L) L = (await tx.query("INSERT INTO van_loads (company_id,rep_id,day,loaded_by) VALUES ($1,$2,$3,$4) RETURNING *", [cid, repId, today(), req.user.uid])).rows[0];
      for (const l of lines) {
        const v = (await tx.query("SELECT id FROM variants WHERE company_id=$1 AND (sku=$2 OR barcode=$2)", [cid, String(l.sku ?? "").trim()])).rows[0];
        if (!v) throw bad(`product ${l.sku} not found`, 404);
        const q = Number(l.qty); if (!Number.isInteger(q) || q <= 0 || q > 100000) throw bad("quantities must be whole numbers");
        const ex = (await tx.query("SELECT id, loaded FROM van_lines WHERE load_id=$1 AND variant_id=$2", [L.id, v.id])).rows[0];
        if (ex) await tx.query("UPDATE van_lines SET loaded=$1 WHERE id=$2", [ex.loaded + q, ex.id]);
        else await tx.query("INSERT INTO van_lines (load_id,variant_id,loaded) VALUES ($1,$2,$3)", [L.id, v.id, q]);
      }
      return L;
    });
    res.status(201).json(await vanSummary(db, load));
  }));
  app.get("/api/van/today", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    res.json(await vanSummary(db, await openLoad(db, cid, req.user.uid)));
  }));
  app.get("/api/van/loads", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const day = String(req.query.day || today());
    const loads = (await db.query("SELECT l.*, u.name AS rep_name FROM van_loads l JOIN users u ON u.id=l.rep_id WHERE l.company_id=$1 AND l.day=$2 ORDER BY l.id", [cid, day])).rows;
    res.json(await Promise.all(loads.map(l => vanSummary(db, l))));
  }));
  // On-the-spot sale from the van: the order is fulfilled at once and (with invoicing on) invoiced by the company.
  app.post("/api/van/sale", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; const settings = await requireFeature(db, cid, "vanSales");
    const L = await openLoad(db, cid, req.user.uid); if (!L) throw bad("load your van first", 409);
    const { clientRef, shopId } = req.body || {}; if (!clientRef) throw bad("clientRef required");
    const dup = (await db.query("SELECT * FROM orders WHERE company_id=$1 AND client_ref=$2", [cid, String(clientRef)])).rows[0];
    if (dup) return res.json({ order: dup, duplicate: true });
    const shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(shopId), cid])).rows[0]; if (!shop) throw bad("shop not found", 404);
    const items = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l: any) => Number(l.qty) > 0); if (!items.length) throw bad("add at least one product");
    const { priced } = await priceLines(db, cid, settings, items, null);
    const want = new Map<number, number>(); for (const l of priced) want.set(l.vid, (want.get(l.vid) || 0) + l.base);
    const gstOk = settings.features.invoicing && settings.gst.gstin && settings.gst.stateCode && settings.gst.legalName;
    const out = await withTx(db, async tx => {
      for (const [vid, n] of want) {
        const vl = (await tx.query("SELECT id, loaded, sold FROM van_lines WHERE load_id=$1 AND variant_id=$2", [L.id, vid])).rows[0];
        const left = vl ? vl.loaded - vl.sold : 0;
        if (left < n) throw bad(`not enough on the van for ${priced.find(p => p.vid === vid)!.sku}: ${left} left`, 409);
        if (!(await tx.query("UPDATE van_lines SET sold=$1 WHERE id=$2 AND sold=$3 RETURNING id", [vl.sold + n, vl.id, vl.sold])).rows[0]) throw bad("van stock changed — retry", 409);
      }
      const total = Math.round(priced.reduce((a, l) => a + l.amount, 0) * 100) / 100, savings = Math.round(priced.reduce((a, l) => a + l.saving, 0) * 100) / 100;
      const o = (await tx.query("INSERT INTO orders (company_id,client_ref,rep_id,shop_id,distributor_id,status,total,savings,van_load_id) VALUES ($1,$2,$3,$4,NULL,'fulfilled',$5,$6,$7) RETURNING *",
        [cid, String(clientRef), req.user.uid, shop.id, total, savings, L.id])).rows[0];
      for (const l of priced) await tx.query("INSERT INTO order_lines (order_id,variant_id,uom,qty,base_qty,price,discount_pct,amount,gross,scheme_id,free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [o.id, l.vid, l.uom, l.qty, l.base, l.price, l.disc, l.amount, l.gross, l.schemeId, l.free]);
      await emit(tx, cid, "order.created", { id: o.id, client_ref: o.client_ref, shop_id: o.shop_id, total, status: o.status, van: true });
      const inv = gstOk ? await invoiceOrder(tx, cid, req.user.uid, settings, { key: "company", g: settings.gst }, o, today()) : null;
      return { o, inv };
    });
    res.status(201).json({ order: out.o, invoice: out.inv ? await loadInvoice(db, cid, out.inv.id) : null, van: await vanSummary(db, L) });
  }));
  // Day end: enter what is physically left on the van; the load closes and variances are kept for the manager.
  app.post("/api/van/close", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const repId = req.user.role === "sales_rep" ? req.user.uid : Number(req.body?.repId);
    const L = await openLoad(db, cid, repId); if (!L) throw bad("no open van load", 404);
    const counts = new Map<string, number>();
    for (const c of Array.isArray(req.body?.counts) ? req.body.counts : []) { const q = Number(c.qty); if (!Number.isInteger(q) || q < 0) throw bad("counts must be whole numbers ≥ 0"); counts.set(String(c.sku), q); }
    const sum = await vanSummary(db, L);
    for (const l of sum!.lines) await db.query("UPDATE van_lines SET counted=$1 WHERE load_id=$2 AND variant_id=$3", [counts.has(l.sku) ? counts.get(l.sku) : l.expected, L.id, l.variant_id]);
    await db.query("UPDATE van_loads SET status='closed', closed_at=NOW(), closed_by=$1 WHERE id=$2", [req.user.uid, L.id]);
    const done = await vanSummary(db, (await db.query("SELECT * FROM van_loads WHERE id=$1", [L.id])).rows[0]);
    await emit(db, cid, "van.closed", { id: L.id, rep_id: repId, day: L.day, variances: done!.lines.filter((l: any) => l.variance).map((l: any) => ({ sku: l.sku, variance: l.variance })) });
    res.json(done);
  }));
}
