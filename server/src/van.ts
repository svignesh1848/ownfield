// Van sales: load stock onto a rep's van for the day, sell and invoice on the spot, and reconcile at day end.
// Van stock is its own ledger (van_lines); loaded − sold = expected at day end, and the counted figure shows any variance.
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, today, getCompany, fefoRows } from "./catalog.js";
import { logMove } from "./inventory.js";
import { priceLines } from "./field.js";
import { invoiceOrder, loadInvoice, fyOf, nextNumber, r2 } from "./billing.js";
import { emit } from "./integrations/webhooks.js";
import { type Ctx, MGR, requireFeature } from "./common.js";

async function openLoad(db: Db, cid: number, repId: number) {
  return (await db.query("SELECT * FROM van_loads WHERE company_id=$1 AND rep_id=$2 AND status='open' ORDER BY id DESC LIMIT 1", [cid, repId])).rows[0] ?? null;
}
export async function vanSummary(db: Db, load: any) {
  if (!load) return null;
  const lines = (await db.query(`SELECT l.variant_id, v.sku, v.barcode, i.name, l.loaded, l.sold, l.unloaded, l.counted FROM van_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
    WHERE l.load_id=$1 ORDER BY v.sku`, [load.id])).rows.map(l => {
      const expected = l.loaded - l.sold - l.unloaded;
      return { ...l, left: expected, expected, variance: l.counted == null ? null : l.counted - expected };
    });
  const orders = (await db.query("SELECT o.id, o.client_ref, o.total, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.van_load_id=$1 ORDER BY o.id", [load.id])).rows
    .map(o => ({ ...o, total: Number(o.total) }));
  const pays = (await db.query("SELECT mode, amount FROM van_payments WHERE load_id=$1", [load.id])).rows;
  const by = (m: string) => r2(pays.filter(p => p.mode === m).reduce((a, p) => a + Number(p.amount), 0));
  const sales_total = Math.round(orders.reduce((a, o) => a + o.total, 0) * 100) / 100;
  const signer = load.signed_off_by ? (await db.query("SELECT name FROM users WHERE id=$1", [load.signed_off_by])).rows[0]?.name : null;
  // Settlement: cash the rep should hand over vs counted, and stock left vs counted.
  const settlement = { cash: by("cash"), upi: by("upi"), credit: by("credit"), cash_counted: load.cash_counted == null ? null : Number(load.cash_counted),
    cash_diff: load.cash_counted == null ? null : r2(Number(load.cash_counted) - by("cash")),
    stock_diff_units: lines.reduce((a: number, l: any) => a + (l.variance || 0), 0), signed_off_by: signer, signed_off_at: load.signed_off_at ?? null };
  return { ...load, lines, orders, sales_total, settlement };
}

export function registerVanRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  // Load (or top up) today's van. Managers load for a rep; a rep can record their own load.
  app.post("/api/van/load", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const repId = req.user.role === "sales_rep" ? req.user.uid : Number(req.body?.repId);
    if (!(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='sales_rep' AND active=TRUE", [repId, cid])).rows[0]) throw bad("pick a sales rep");
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!lines.length) throw bad("add at least one product with a quantity");
    const { settings } = await getCompany(db, cid);
    // Source of the goods: a distributor's stock or the company warehouse. With stock tracking on, loading deducts it (FEFO).
    const src = req.body?.sourceId == null || req.body.sourceId === "" || req.body.sourceId === "company" ? null : Number(req.body.sourceId);
    if (src != null && !(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='distributor'", [src, cid])).rows[0]) throw bad("distributor not found", 404);
    const fromStock = !!settings.features.stock;
    const load = await withTx(db, async tx => {
      let L = await openLoad(tx, cid, repId);
      if (!L) L = (await tx.query("INSERT INTO van_loads (company_id,rep_id,day,loaded_by,source_distributor_id,from_stock) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [cid, repId, today(), req.user.uid, src, fromStock])).rows[0];
      else if (L.from_stock && (L.source_distributor_id ?? null) !== src) throw bad("this van was loaded from another source today — unload it first", 409);
      for (const l of lines) {
        const v = (await tx.query("SELECT id FROM variants WHERE company_id=$1 AND (sku=$2 OR barcode=$2)", [cid, String(l.sku ?? "").trim()])).rows[0];
        if (!v) throw bad(`product ${l.sku} not found`, 404);
        const q = Number(l.qty); if (!Number.isInteger(q) || q <= 0 || q > 100000) throw bad("quantities must be whole numbers");
        if (L.from_stock) {
          let need = q;
          for (const r of await fefoRows(tx, cid, L.source_distributor_id ?? null, v.id)) {
            if (need <= 0) break; const take = Math.min(need, r.qty);
            if (!(await tx.query("UPDATE stock SET qty=$1, updated_at=NOW() WHERE id=$2 AND qty=$3 RETURNING id", [r.qty - take, r.id, r.qty])).rows[0]) throw bad("stock changed — retry", 409);
            await tx.query("INSERT INTO van_takes (load_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5)", [L.id, v.id, r.batch_no, r.expiry, take]);
            await logMove(tx, cid, L.source_distributor_id ?? null, v.id, r.batch_no, -take, "van_load", `van ${L.id}`, req.user.uid);
            need -= take;
          }
          if (need > 0) throw bad(`not enough stock of ${l.sku} at the source: short by ${need}`, 409);
        }
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
    const pb = req.body?.payment || {}, pay = { mode: String(pb.mode || "cash"), amount: pb.amount == null || pb.amount === "" ? null : Number(pb.amount), reference: pb.reference ? String(pb.reference).slice(0, 60) : null };
    if (!["cash", "upi", "credit"].includes(pay.mode)) throw bad("payment must be cash, UPI or credit");
    if (pay.amount != null && !(pay.amount >= 0)) throw bad("amount must be ≥ 0");
    if (pay.mode === "credit" && !settings.features.invoicing) throw bad("credit sales need invoicing turned on");
    const { priced } = await priceLines(db, cid, settings, items, null);
    const want = new Map<number, number>(); for (const l of priced) want.set(l.vid, (want.get(l.vid) || 0) + l.base);
    const gstOk = settings.features.invoicing && settings.gst.gstin && settings.gst.stateCode && settings.gst.legalName;
    const out = await withTx(db, async tx => {
      for (const [vid, n] of want) {
        const vl = (await tx.query("SELECT id, loaded, sold, unloaded FROM van_lines WHERE load_id=$1 AND variant_id=$2", [L.id, vid])).rows[0];
        const left = vl ? vl.loaded - vl.sold - (vl.unloaded || 0) : 0;
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
      // Payment at the counter: cash, UPI or credit (unpaid part stays outstanding on the invoice).
      const due = inv ? Number(inv.total) : total;
      const paid = pay.mode === "credit" ? 0 : Math.min(due, pay.amount == null ? due : pay.amount);
      if (paid > 0) {
        let pid: number | null = null;
        if (inv) {
          const fy = fyOf(today()), number = `RCPT/${fy}/${String(await nextNumber(tx, cid, "receipt", fy)).padStart(4, "0")}`;
          const p = (await tx.query(`INSERT INTO payments (company_id,issuer,number,fy,shop_id,pay_date,mode,reference,amount,collected_by) VALUES ($1,'company',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [cid, number, fy, shop.id, today(), pay.mode, pay.reference, paid, req.user.uid])).rows[0];
          await tx.query("INSERT INTO payment_allocations (payment_id,invoice_id,amount) VALUES ($1,$2,$3)", [p.id, inv.id, paid]); pid = p.id;
        }
        await tx.query("INSERT INTO van_payments (load_id,order_id,mode,amount,reference,payment_id) VALUES ($1,$2,$3,$4,$5,$6)", [L.id, o.id, pay.mode, paid, pay.reference, pid]);
      }
      if (due - paid > 0.004) await tx.query("INSERT INTO van_payments (load_id,order_id,mode,amount) VALUES ($1,$2,'credit',$3)", [L.id, o.id, r2(due - paid)]);
      return { o, inv };
    });
    res.status(201).json({ order: out.o, invoice: out.inv ? await loadInvoice(db, cid, out.inv.id) : null, van: await vanSummary(db, L) });
  }));
  // Unload: put what is left on the van back into the source stock (latest-expiry batches taken go back first).
  app.post("/api/van/unload", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const repId = req.user.role === "sales_rep" ? req.user.uid : Number(req.body?.repId);
    const L = await openLoad(db, cid, repId); if (!L) throw bad("no open van load", 404);
    const want = new Map<string, number>(); for (const c of Array.isArray(req.body?.lines) ? req.body.lines : []) { const q = Number(c.qty); if (!Number.isInteger(q) || q < 0) throw bad("quantities must be whole numbers"); want.set(String(c.sku), q); }
    const sum = await vanSummary(db, L);
    await withTx(db, async tx => {
      for (const l of sum!.lines) {
        const q = want.size ? (want.get(l.sku) ?? 0) : l.left; if (q <= 0) continue;
        if (q > l.left) throw bad(`only ${l.left} of ${l.sku} left on the van`, 409);
        await tx.query("UPDATE van_lines SET unloaded=$1 WHERE load_id=$2 AND variant_id=$3", [l.unloaded + q, L.id, l.variant_id]);
        if (!L.from_stock) continue;
        let back = q;
        for (const tk of (await tx.query("SELECT * FROM van_takes WHERE load_id=$1 AND variant_id=$2 AND qty>0 ORDER BY expiry DESC NULLS FIRST, id DESC", [L.id, l.variant_id])).rows) {
          if (back <= 0) break; const n = Math.min(back, tk.qty);
          await tx.query("UPDATE van_takes SET qty=$1 WHERE id=$2", [tk.qty - n, tk.id]);
          const d = L.source_distributor_id ?? null;
          const ex = (await tx.query(`SELECT id, qty FROM stock WHERE company_id=$1 AND variant_id=$2 AND batch_no=$3 AND ${d == null ? "distributor_id IS NULL" : "distributor_id=$4"}`, d == null ? [cid, l.variant_id, tk.batch_no] : [cid, l.variant_id, tk.batch_no, d])).rows[0];
          if (ex) await tx.query("UPDATE stock SET qty=$1, updated_at=NOW() WHERE id=$2", [Number(ex.qty) + n, ex.id]);
          else await tx.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5,$6)", [cid, d, l.variant_id, tk.batch_no, tk.expiry, n]);
          await logMove(tx, cid, d, l.variant_id, tk.batch_no, n, "van_unload", `van ${L.id}`, req.user.uid);
          back -= n;
        }
      }
    });
    res.json(await vanSummary(db, L));
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
    const cc = req.body?.cashCounted; if (cc != null && cc !== "" && !(Number(cc) >= 0)) throw bad("cash counted must be ≥ 0");
    await db.query("UPDATE van_loads SET status='closed', closed_at=NOW(), closed_by=$1, cash_counted=$3, settle_note=$4 WHERE id=$2", [req.user.uid, L.id, cc == null || cc === "" ? null : Number(cc), req.body?.note ? String(req.body.note).slice(0, 300) : null]);
    const done = await vanSummary(db, (await db.query("SELECT * FROM van_loads WHERE id=$1", [L.id])).rows[0]);
    await emit(db, cid, "van.closed", { id: L.id, rep_id: repId, day: L.day, variances: done!.lines.filter((l: any) => l.variance).map((l: any) => ({ sku: l.sku, variance: l.variance })) });
    res.json(done);
  }));
  // Manager sign-off on a closed van day (after checking the stock and cash differences).
  app.post("/api/van/loads/:id/signoff", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "vanSales");
    const L = (await db.query("SELECT * FROM van_loads WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!L) throw bad("van load not found", 404);
    if (L.status !== "closed") throw bad("close the day first", 409); if (L.signed_off_by) throw bad("already signed off", 409);
    await db.query("UPDATE van_loads SET signed_off_by=$1, signed_off_at=NOW(), settle_note=COALESCE($2, settle_note) WHERE id=$3", [req.user.uid, req.body?.note ? String(req.body.note).slice(0, 300) : null, L.id]);
    res.json(await vanSummary(db, (await db.query("SELECT * FROM van_loads WHERE id=$1", [L.id])).rows[0]));
  }));
}
