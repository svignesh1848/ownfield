import { dayOpenCheck } from "./workday.js";
import { emit, checkLowStock } from "./integrations/webhooks.js";
import { logMove } from "./inventory.js";
import { geofenceCheck } from "./tracking.js";
// Step 2: beats, visits (GPS check-in/out), orders, distributor inbox, manager dashboard.
import type { Express, Request, Response, NextFunction } from "express";
import { withTx, type Db } from "./db.js";
import { getCompany, cleanCustom, fefoRows, parseJson } from "./catalog.js";
import { getFlow } from "./flow.js";
import type { Uom } from "./templates.js";
import { activeSchemes, applySchemes } from "./schemes.js";
import { creditCheck } from "./collections.js";
import { onLeave } from "./leave.js";

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void; tenant: (req: any, res: Response) => number | null };
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const coord = (lat: unknown, lng: unknown) => {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) throw bad("valid lat/lng required");
  return [a, b];
};
const coordOpt = (on: boolean, lat: unknown, lng: unknown) => on || (lat != null && lng != null) ? coord(lat, lng) : [null, null];
type Priced = { vid: number; sku: string; uom: string; qty: number; base: number; price: number; disc: number; gross: number; amount: number; saving: number; schemeId: number | null; scheme: string | null; free: boolean };
/** Price order lines: unit conversion, schemes (best discount + buy-X-get-Y free lines at ₹0), and base-unit stock demand. */
export async function priceLines(db: any, cid: number, settings: any, items: any[], dist: number | null, shop: any = null) {
  // Channel price list: a price set for this outlet type (e.g. Wholesale, Modern trade) wins over the standard billing price.
  const channel = new Map<number, number>();
  if (shop?.outlet_type) for (const r of (await db.query("SELECT variant_id, price FROM channel_prices WHERE company_id=$1 AND lower(outlet_type)=lower($2)", [cid, shop.outlet_type])).rows) channel.set(r.variant_id, Number(r.price));
  const f = settings.features;
  const schemes = f.schemes ? await activeSchemes(db, cid) : [];
  const priced: Priced[] = [], need = new Map<number, { sku: string; n: number }>();
  for (const l of items) {
    const qty = Number(l.qty);
    if (!Number.isInteger(qty)) throw bad("qty must be an integer");
    const v = (await db.query(`SELECT v.id, v.sku, v.billing_price, i.id AS item_id, i.category, i.kind, i.uoms FROM variants v JOIN items i ON i.id=v.item_id
      WHERE v.company_id=$1 AND (v.id=$2 OR v.sku=$3)`, [cid, Number(l.productId ?? l.variantId) || 0, String(l.sku ?? "")])).rows[0];
    if (!v) throw bad(`product ${l.sku ?? l.productId} not found`, 404);
    const uoms = parseJson<Uom[]>(v.uoms, settings.uoms);
    const u = l.uom ? uoms.find(x => x.code === String(l.uom).toUpperCase()) : uoms.find(x => x.factor === 1);
    if (!u) throw bad(`unit ${l.uom} not defined for ${v.sku}`);
    const base = qty * u.factor, price = channel.get(v.id) ?? Number(v.billing_price);
    const a = applySchemes(schemes, { vid: v.id, itemId: v.item_id, category: v.category, base, price }, dist);
    priced.push({ vid: v.id, sku: v.sku, uom: u.code, qty, base, price, disc: a.disc, gross: a.gross, amount: a.amount, saving: Math.round((a.gross - a.amount) * 100) / 100, schemeId: a.schemeId, scheme: a.scheme, free: false });
    let n = base;
    if (a.free) {
      const bu = uoms.find(x => x.factor === 1)?.code || u.code;
      const fv = Math.round(a.free.base * price * 100) / 100;
      priced.push({ vid: v.id, sku: v.sku, uom: bu, qty: a.free.base, base: a.free.base, price, disc: 100, gross: fv, amount: 0, saving: fv, schemeId: a.free.schemeId, scheme: a.free.scheme, free: true });
      n += a.free.base;
    }
    if (f.stock && v.kind === "goods") need.set(v.id, { sku: v.sku, n: (need.get(v.id)?.n ?? 0) + n });
  }
  return { priced, need };
}

export const TRANSITIONS: Record<string, string[]> = { placed: ["accepted", "rejected"], accepted: ["dispatched", "fulfilled"], dispatched: ["fulfilled"] };

export async function orderEvent(q: Db, orderId: number, status: string, uid: number | null, note: string | null = null) {
  await q.query("INSERT INTO order_events (order_id,status,user_id,note) VALUES ($1,$2,$3,$4)", [orderId, status, uid, note]);
}
/** In-app notification; template + args are translated in the app (t(template, ...args)). */
export async function notify(q: Db, cid: number, userId: number, template: string, args: unknown[], note: string | null = null, link: string | null = null) {
  await q.query("INSERT INTO notifications (company_id,user_id,template,args,note,link) VALUES ($1,$2,$3,$4,$5,$6)", [cid, userId, template, JSON.stringify(args), note, link]);
}
export const dayKey = (d: Date | string, tz = process.env.REPORT_TZ || "Asia/Kolkata") => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });

export function registerFieldRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const MGR = ["company_admin", "manager"];
  const userIn = async (cid: number, id: unknown, role: string) =>
    (await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role=$3", [Number(id), cid, role])).rows[0];
  const shopIn = async (cid: number, id: unknown) => (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(id), cid])).rows[0];

  // ---- Distributor mapping ----
  app.post("/api/shops/:id/distributor", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    if (!(await shopIn(cid, req.params.id))) throw bad("shop not found", 404);
    const d = req.body?.distributorId;
    if (d != null && !(await userIn(cid, d, "distributor"))) throw bad("distributor not found", 404);
    await db.query("UPDATE shops SET updated_at=NOW(), distributor_id=$1 WHERE id=$2", [d == null ? null : Number(d), Number(req.params.id)]);
    res.json({ ok: true });
  }));
  app.get("/api/distributors", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id,name,email FROM users WHERE company_id=$1 AND role='distributor' AND active=TRUE ORDER BY name", [cid])).rows);
  }));
  app.get("/api/reps", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id,name,email FROM users WHERE company_id=$1 AND role='sales_rep' AND active=TRUE ORDER BY name", [cid])).rows);
  }));

  // ---- Beats ----
  app.post("/api/beats", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { name, repId, shopIds = [], weekday = null } = req.body || {};
    if (!name) throw bad("name required");
    if (repId != null && !(await userIn(cid, repId, "sales_rep"))) throw bad("rep not found", 404);
    for (const s of shopIds) if (!(await shopIn(cid, s))) throw bad(`shop ${s} not found`, 404);
    const b = (await db.query("INSERT INTO beats (company_id,name,rep_id,weekday) VALUES ($1,$2,$3,$4) RETURNING *", [cid, name, repId ?? null, weekday])).rows[0];
    for (const [i, s] of (shopIds as unknown[]).entries()) await db.query("INSERT INTO beat_shops (beat_id,shop_id,seq) VALUES ($1,$2,$3)", [b.id, Number(s), i + 1]);
    res.status(201).json(b);
  }));
  app.get("/api/beats", auth("company_admin", "manager", "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const mine = req.user.role === "sales_rep";
    const beats = (await db.query(`SELECT b.*, u.name AS rep_name FROM beats b LEFT JOIN users u ON u.id=b.rep_id
      WHERE b.company_id=$1 ${mine ? "AND b.rep_id=$2" : ""} ORDER BY b.id`, mine ? [cid, req.user.uid] : [cid])).rows;
    const leaveCache = new Map<number, boolean>();
    for (const b of beats) {
      b.shops = (await db.query(`SELECT s.id,s.code,s.name,s.city,bs.seq FROM beat_shops bs JOIN shops s ON s.id=bs.shop_id
      WHERE bs.beat_id=$1 ORDER BY bs.seq`, [b.id])).rows;
      if (b.rep_id) { if (!leaveCache.has(b.rep_id)) leaveCache.set(b.rep_id, !!(await onLeave(db, cid, b.rep_id))); if (leaveCache.get(b.rep_id)) b.onLeaveToday = true; }
    }
    res.json(beats);
  }));

  // ---- Visits ----
  app.post("/api/visits/checkin", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    const [lat, lng] = coordOpt(settings.features.gps, req.body?.lat, req.body?.lng);
    if (!(await shopIn(cid, req.body?.shopId))) throw bad("shop not found", 404);
    if (await onLeave(db, cid, req.user.uid)) throw bad("You are on approved leave today, so visits are paused.", 409);
    await dayOpenCheck(db, cid, req.user.uid);
    const open = (await db.query("SELECT id FROM visits WHERE rep_id=$1 AND check_out_at IS NULL", [req.user.uid])).rows[0];
    if (open) throw bad("check out of the current visit first", 409);
    await geofenceCheck(db, cid, Number(req.body.shopId), lat, lng);
    res.status(201).json((await db.query("INSERT INTO visits (company_id,rep_id,shop_id,in_lat,in_lng) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [cid, req.user.uid, Number(req.body.shopId), lat, lng])).rows[0]);
  }));
  // A whole visit captured offline (check-in and check-out times from the phone), sent when back online. Deduped by clientRef.
  app.post("/api/visits/offline", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const b = req.body || {}; if (!b.clientRef) throw bad("clientRef required");
    const dup = (await db.query("SELECT * FROM visits WHERE company_id=$1 AND client_ref=$2", [cid, String(b.clientRef).slice(0, 60)])).rows[0];
    if (dup) return res.json({ ...dup, duplicate: true });
    if (!(await shopIn(cid, b.shopId))) throw bad("shop not found", 404);
    const tin = new Date(b.checkInAt), tout = b.checkOutAt ? new Date(b.checkOutAt) : null, now = Date.now();
    if (isNaN(+tin) || +tin > now + 60_000 || +tin < now - 3 * 864e5 || (tout && (isNaN(+tout) || tout < tin || +tout > now + 60_000))) throw bad("visit times look wrong");
    const { settings } = await getCompany(db, cid);
    const [lat, lng] = coordOpt(false, b.lat, b.lng);
    await geofenceCheck(db, cid, Number(b.shopId), lat, lng);
    res.status(201).json((await db.query("INSERT INTO visits (company_id,rep_id,shop_id,check_in_at,in_lat,in_lng,check_out_at,out_lat,out_lng,notes,custom,client_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$5,$6,$8,$9,$10) RETURNING *",
      [cid, req.user.uid, Number(b.shopId), tin.toISOString(), lat, lng, tout ? tout.toISOString() : tin.toISOString(), b.notes ?? null, JSON.stringify(cleanCustom(settings.customFields.visit, b.custom || {}, false)), String(b.clientRef).slice(0, 60)])).rows[0]);
  }));
  app.post("/api/visits/:id/checkout", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    const [lat, lng] = coordOpt(settings.features.gps, req.body?.lat, req.body?.lng);
    const custom = JSON.stringify(cleanCustom(settings.customFields.visit, req.body?.custom || {}));
    // Productive call = an order at this outlet during the visit; otherwise the rep picks a no-order reason.
    const v = (await db.query("SELECT * FROM visits WHERE id=$1 AND company_id=$2 AND rep_id=$3 AND check_out_at IS NULL", [Number(req.params.id), cid, req.user.uid])).rows[0];
    if (!v) throw bad("open visit not found", 404);
    const ordered = (await db.query("SELECT id FROM orders WHERE company_id=$1 AND shop_id=$2 AND rep_id=$3 AND created_at>=$4 LIMIT 1", [cid, v.shop_id, req.user.uid, v.check_in_at])).rows[0];
    const flow = await getFlow(db, cid); let reason: string | null = null;
    if (!ordered) {
      reason = req.body?.noOrderReason ? String(req.body.noOrderReason).trim().slice(0, 80) : null;
      if (flow.requireNoOrderReason && !reason) throw Object.assign(bad("No order taken — pick a reason before you check out"), { body: { reasons: flow.noOrderReasons } });
      if (reason && flow.noOrderReasons.length && !flow.noOrderReasons.includes(reason)) throw bad("pick one of the listed reasons");
    }
    const r = await db.query(`UPDATE visits SET check_out_at=NOW(), out_lat=$1, out_lng=$2, notes=$3, custom=$4, no_order_reason=$8
      WHERE id=$5 AND company_id=$6 AND rep_id=$7 AND check_out_at IS NULL RETURNING *`, [lat, lng, req.body?.notes ?? null, custom, Number(req.params.id), cid, req.user.uid, reason]);
    if (!r.rows[0]) throw bad("open visit not found", 404);
    res.json(r.rows[0]);
  }));
  app.get("/api/visits", auth("company_admin", "manager", "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const mine = req.user.role === "sales_rep";
    res.json((await db.query(`SELECT v.*, s.name AS shop_name, u.name AS rep_name FROM visits v JOIN shops s ON s.id=v.shop_id JOIN users u ON u.id=v.rep_id
      WHERE v.company_id=$1 ${mine ? "AND v.rep_id=$2" : ""} ORDER BY v.id DESC`, mine ? [cid, req.user.uid] : [cid])).rows.map(v => ({ ...v, custom: parseJson(v.custom, {}) })));
  }));

  // Retailers order for their own outlet only (Retailer app feature); the order goes to the outlet's distributor like a rep order.
  const retailerShop = async (req: any, cid: number) => {
    if (req.user.role !== "retailer") return null;
    const { settings } = await getCompany(db, cid); if (!settings.features.retailerApp) throw bad("the retailer app is turned off for this company", 403);
    const u = (await db.query("SELECT shop_id FROM users WHERE id=$1 AND company_id=$2", [req.user.uid, cid])).rows[0];
    if (!u?.shop_id) throw bad("your login is not linked to an outlet", 403);
    return u.shop_id as number;
  };
  app.get("/api/retailer/me", auth("retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const sid = await retailerShop(req, cid);
    const s = (await db.query("SELECT s.id,s.code,s.name,s.city,s.phone,d.name AS distributor_name FROM shops s LEFT JOIN users d ON d.id=s.distributor_id WHERE s.id=$1", [sid])).rows[0];
    res.json(s);
  }));
  // ---- Orders (idempotent on clientRef so the offline queue can safely retry) ----
  // Life cycle (like FieldAssist / Bizom secondary orders): [pending_approval →] placed → accepted → dispatched → fulfilled (full or partial),
  // or rejected / cancelled. Every step is written to order_events (who, when, why) and the order taker gets an in-app notification.
  const shopName = async (q: Db, id: number) => (await q.query("SELECT name FROM shops WHERE id=$1", [id])).rows[0]?.name ?? "";
  const tell = async (q: Db, cid: number, o: any, status: string, by: number, reason: string | null = null) => {
    const name = await shopName(q, o.shop_id);
    if (o.rep_id !== by) await notify(q, cid, o.rep_id, "Order #{0} at {1}: {2}", [o.id, name, status], reason, `orders#${o.id}`);
    if (status === "placed" && o.distributor_id && o.distributor_id !== by) await notify(q, cid, o.distributor_id, "New order #{0} from {1}", [o.id, name], null, `inbox#${o.id}`);
  };
  const needsApproval = (settings: any, total: number) => { const a = settings.approval || { levels: 0, above: 0 }; return a.levels > 0 && total >= (a.above || 0); };
  const checkCart = async (cid: number, settings: any, shop: any, lines: any, editing: number | null = null) => {
    const items = (Array.isArray(lines) ? lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!items.length) throw bad("at least one line with qty > 0");
    const loc: number | null = shop.distributor_id ?? null;
    const { priced, need } = await priceLines(db, cid, settings, items, loc, shop);
    for (const [vid, { sku, n }] of need) {
      // When editing, this order's own hold goes back to the pool first, so it counts as available to itself.
      const own = editing == null ? 0 : Number((await db.query("SELECT COALESCE(SUM(a.qty),0) AS n FROM order_allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1 AND l.variant_id=$2", [editing, vid])).rows[0].n);
      const avail = (await fefoRows(db, cid, loc, vid)).reduce((a, r) => a + r.qty, 0) + own;
      if (avail < n) throw bad(`insufficient stock for ${sku}: ${avail} available, ${n} ordered (base units)`, 409);
    }
    const r = (n: number) => Math.round(n * 100) / 100;
    const total = r(priced.reduce((a, l) => a + l.amount, 0)), savings = r(priced.reduce((a, l) => a + l.saving, 0));
    const credit = await creditCheck(db, cid, settings, shop, total);
    if (!credit.ok && credit.action === "block") throw Object.assign(bad(`credit hold: ${credit.reasons.join("; ")}`, 409), { credit });
    return { priced, total, savings, credit, loc };
  };
  const insertLines = async (tx: Db, oid: number, priced: any[]) => {
    for (const l of priced) await tx.query("INSERT INTO order_lines (order_id,variant_id,uom,qty,base_qty,price,discount_pct,amount,gross,scheme_id,free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [oid, l.vid, l.uom, l.qty, l.base, l.price, l.disc, l.amount, l.gross, l.schemeId, l.free]);
  };
  app.post("/api/orders", auth("sales_rep", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = await retailerShop(req, cid);
    const { clientRef, lines } = req.body || {}; const shopId = own ?? req.body?.shopId;
    if (!clientRef) throw bad("clientRef required");
    const dup = (await db.query("SELECT * FROM orders WHERE company_id=$1 AND client_ref=$2", [cid, String(clientRef)])).rows[0];
    if (dup) return res.status(200).json({ ...dup, duplicate: true });
    const shop = await shopIn(cid, shopId); if (!shop) throw bad("shop not found", 404);
    const { settings } = await getCompany(db, cid);
    const { priced, total, savings, credit, loc } = await checkCart(cid, settings, shop, lines);
    const status = needsApproval(settings, total) ? "pending_approval" : "placed";
    const o = await withTx(db, async tx => {
      const o = (await tx.query("INSERT INTO orders (company_id,client_ref,rep_id,shop_id,distributor_id,total,savings,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [cid, String(clientRef), req.user.uid, shop.id, loc, total, savings, status])).rows[0];
      await insertLines(tx, o.id, priced);
      // Hold stock the moment the order is placed (also while waiting for approval), so two orders cannot promise the same units.
      if (settings.features.stock) await allocateStock(tx, cid, o);
      await orderEvent(tx, o.id, status, req.user.uid, credit.ok ? null : credit.reasons.join("; "));
      if (status === "placed") await tell(tx, cid, o, "placed", req.user.uid);
      else for (const m of (await tx.query("SELECT id FROM users WHERE company_id=$1 AND role IN ('company_admin','manager') AND active", [cid])).rows)
        await notify(tx, cid, m.id, "Order #{0} at {1} needs your approval", [o.id, shop.name], null, `orders#${o.id}`);
      await emit(tx, cid, "order.created", { id: o.id, client_ref: o.client_ref, shop_id: o.shop_id, distributor_id: o.distributor_id, total: Number(o.total), status: o.status });
      return o;
    });
    res.status(201).json(credit.ok ? o : { ...o, creditWarning: credit.reasons });
  }));
  // Edit while the order is still new (not yet accepted): the order taker or a manager replaces the lines; prices/schemes/stock/credit are re-checked.
  app.put("/api/orders/:id", auth("sales_rep", "retailer", "company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = await retailerShop(req, cid);
    const o = (await db.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    const role = req.user.role;
    if (!o || (role === "sales_rep" && o.rep_id !== req.user.uid) || (role === "retailer" && o.shop_id !== own)) throw bad("order not found", 404);
    if (!["placed", "pending_approval"].includes(o.status)) throw bad("only new orders can be edited", 409);
    const shop = await shopIn(cid, o.shop_id);
    const { settings } = await getCompany(db, cid);
    const { priced, total, savings, credit } = await checkCart(cid, settings, shop, req.body?.lines, o.id);
    const status = needsApproval(settings, total) ? "pending_approval" : o.status === "pending_approval" && o.approval_level > 0 ? "pending_approval" : "placed";
    const u = await withTx(db, async tx => {
      const u = (await tx.query("UPDATE orders SET updated_at=NOW(), total=$1, savings=$2, status=$3, approval_level=0 WHERE id=$4 AND status=$5 RETURNING *", [total, savings, status, o.id, o.status])).rows[0];
      if (!u) throw bad("order changed meanwhile — reload", 409);
      await releaseStock(tx, cid, o, req.user.uid, "order edited");
      await tx.query("DELETE FROM order_lines WHERE order_id=$1", [o.id]);
      await insertLines(tx, o.id, priced);
      if (settings.features.stock) await allocateStock(tx, cid, u);
      await orderEvent(tx, o.id, "edited", req.user.uid, `${o.total} → ${total}`);
      if (o.rep_id !== req.user.uid) await notify(tx, cid, o.rep_id, "Order #{0} at {1}: {2}", [o.id, shop.name, "edited"], null, `orders#${o.id}`);
      await emit(tx, cid, "order.status_changed", { id: u.id, client_ref: u.client_ref, from: o.status, status: "edited", total });
      return u;
    });
    res.json(credit.ok ? u : { ...u, creditWarning: credit.reasons });
  }));
  // Multi-level approval (Settings → Orders: levels and amount; off by default). Each level needs a different manager/admin.
  app.post("/api/orders/:id/approve", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const o = (await db.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!o) throw bad("order not found", 404);
    if (o.status !== "pending_approval") throw bad("this order is not waiting for approval", 409);
    const reject = req.body?.decision === "reject", reason = String(req.body?.reason || "").trim().slice(0, 300) || null;
    if (!reject && (await db.query("SELECT 1 FROM order_events WHERE order_id=$1 AND status='approved' AND user_id=$2 AND at>=$3", [o.id, req.user.uid, o.updated_at])).rows[0])
      throw bad("you already approved this order — another approver is needed", 409);
    const { settings } = await getCompany(db, cid);
    const levels = settings.approval?.levels || 1, level = o.approval_level + 1;
    const to = reject ? "rejected" : level >= levels ? "placed" : "pending_approval";
    const u = await withTx(db, async tx => {
      const u = (await tx.query("UPDATE orders SET status=$1, approval_level=$2, status_reason=COALESCE($3,status_reason), status_by=$4 WHERE id=$5 AND status='pending_approval' AND approval_level=$6 RETURNING *",
        [to, reject ? o.approval_level : level, reason, req.user.uid, o.id, o.approval_level])).rows[0];
      if (!u) throw bad("order changed meanwhile — reload", 409);
      if (reject) await releaseStock(tx, cid, o, req.user.uid, reason || "rejected");
      await orderEvent(tx, o.id, reject ? "rejected" : "approved", req.user.uid, reason ?? (reject ? null : `level ${level} of ${levels}`));
      if (to !== "pending_approval") await tell(tx, cid, u, to, req.user.uid, reason);
      if (to !== "pending_approval") await emit(tx, cid, "order.status_changed", { id: u.id, client_ref: u.client_ref, from: o.status, status: to, total: Number(u.total) });
      return u;
    });
    res.json(u);
  }));
  // Preview: price a cart (schemes applied) without placing it — the rep app shows savings before submitting.
  app.post("/api/orders/preview", auth("sales_rep", "company_admin", "manager", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = await retailerShop(req, cid);
    const shop = await shopIn(cid, own ?? req.body?.shopId); if (!shop) throw bad("shop not found", 404);
    const items = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l: any) => Number(l.qty) > 0);
    const { settings } = await getCompany(db, cid);
    const { priced } = await priceLines(db, cid, settings, items, shop.distributor_id ?? null, shop);
    const r = (n: number) => Math.round(n * 100) / 100;
    res.json({ lines: priced, gross: r(priced.reduce((a, l) => a + l.gross, 0)), savings: r(priced.reduce((a, l) => a + l.saving, 0)), total: r(priced.reduce((a, l) => a + l.amount, 0)) });
  }));
  app.get("/api/orders", auth("company_admin", "manager", "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    if (req.user.role === "retailer") await retailerShop(req, cid);
    const scope = req.user.role === "sales_rep" ? "AND o.rep_id=$2" : req.user.role === "distributor" ? "AND o.distributor_id=$2 AND o.status<>'pending_approval'" : req.user.role === "retailer" ? "AND o.shop_id=(SELECT shop_id FROM users WHERE id=$2)" : "";
    const orders = (await db.query(`SELECT o.*, s.name AS shop_name, u.name AS rep_name, u.role AS placed_by_role FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users u ON u.id=o.rep_id
      WHERE o.company_id=$1 ${scope} ORDER BY o.id DESC`, scope ? [cid, req.user.uid] : [cid])).rows;
    for (const o of orders) {
      o.lines = (await db.query(`SELECT l.id,l.qty,l.ordered_qty,l.uom,l.base_qty,l.price,l.discount_pct,l.amount,l.gross,l.free,l.scheme_id,l.variant_id,sc.name AS scheme,v.sku,v.attrs,i.name AS item_name,i.kind FROM order_lines l
        JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id LEFT JOIN schemes sc ON sc.id=l.scheme_id WHERE l.order_id=$1 ORDER BY l.id`, [o.id])).rows.map(l => ({ ...l, attrs: parseJson(l.attrs, {}) }));
      o.invoice = (await db.query("SELECT id, number FROM invoices WHERE order_id=$1 AND kind='invoice'", [o.id])).rows[0] ?? null;
      for (const l of o.lines) l.allocations = (await db.query("SELECT batch_no, expiry, qty FROM order_allocations WHERE order_line_id=$1 ORDER BY id", [l.id])).rows;
      o.history = (await db.query("SELECT e.status, e.note, e.at, u.name AS by FROM order_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.order_id=$1 ORDER BY e.id", [o.id])).rows;
      o.partial = o.lines.some((l: any) => l.ordered_qty != null && Number(l.ordered_qty) > Number(l.qty));
    }
    res.json(orders);
  }));
  app.post("/api/orders/:id/status", auth("distributor", "company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const o = (await db.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!o || (req.user.role === "distributor" && (o.distributor_id !== req.user.uid || o.status === "pending_approval"))) throw bad("order not found", 404);
    const to = String(req.body?.status || "");
    const reason = String(req.body?.reason || "").trim().slice(0, 300) || null;
    if (!(TRANSITIONS[o.status] || []).includes(to)) throw bad(`cannot move ${o.status} -> ${to}`, 409);
    const { settings } = await getCompany(db, cid);
    // Partial delivery: delivered quantities per line (in the line's unit); anything short is taken off the order (and back into stock).
    const given = Array.isArray(req.body?.lines) && to === "fulfilled" ? req.body.lines : null;
    let partial = false;
    if (given) { // validate before changing anything
      if ((await db.query("SELECT id FROM invoices WHERE order_id=$1 AND kind='invoice'", [o.id])).rows[0]) throw bad("order is invoiced — record short supply as a return / credit note", 409);
      const ls = (await db.query("SELECT id, qty FROM order_lines WHERE order_id=$1", [o.id])).rows;
      for (const g of given) {
        const l = ls.find(x => x.id === Number(g.id)); if (!l) throw bad("line not found", 404);
        const d = Number(g.qty); if (!(Number.isInteger(d) && d >= 0 && d <= Number(l.qty))) throw bad(`delivered quantity must be a whole number from 0 to ${l.qty}`);
      }
    }
    const updated = await withTx(db, async tx => {
      // Status compare-and-set + stock allocation commit together or not at all.
      const u = (await tx.query("UPDATE orders SET updated_at=NOW(), status=$1, status_reason=COALESCE($4, status_reason), status_by=$5 WHERE id=$2 AND status=$3 RETURNING *", [to, o.id, o.status, reason, req.user.uid])).rows[0];
      if (!u) throw bad("order changed meanwhile — reload", 409);
      // The hold taken at placement becomes the allocation; only orders placed before holds existed (no allocation yet) are allocated now.
      if (to === "accepted" && settings.features.stock && !(await hasAllocation(tx, o.id))) await allocateStock(tx, cid, o);
      if (to === "rejected") await releaseStock(tx, cid, o, req.user.uid, reason || "rejected");
      if (given) {
        if ((await tx.query("SELECT id FROM invoices WHERE order_id=$1 AND kind='invoice'", [o.id])).rows[0]) throw bad("order is invoiced — record short supply as a return / credit note", 409);
        const lines = (await tx.query("SELECT * FROM order_lines WHERE order_id=$1", [o.id])).rows;
        for (const g of given) {
          const l = lines.find(x => x.id === Number(g.id)); if (!l) throw bad("line not found", 404);
          const d = Number(g.qty), q = Number(l.qty);
          if (!(Number.isInteger(d) && d >= 0 && d <= q)) throw bad(`delivered quantity must be a whole number from 0 to ${q}`);
          if (d === q) continue;
          partial = true;
          const f = q ? d / q : 0, r = (n: number) => Math.round(n * 100) / 100, base = Math.round(Number(l.base_qty) * f), back = Number(l.base_qty) - base;
          await tx.query("UPDATE order_lines SET ordered_qty=COALESCE(ordered_qty,qty), qty=$1, base_qty=$2, amount=$3, gross=$4 WHERE id=$5",
            [d, base, r(Number(l.amount) * f), l.gross == null ? null : r(Number(l.gross) * f), l.id]);
          let left = back; // return the short quantity to the batches it was picked from (latest picks first)
          for (const a of (await tx.query("SELECT * FROM order_allocations WHERE order_line_id=$1 ORDER BY id DESC", [l.id])).rows) {
            if (left <= 0) break;
            const take = Math.min(left, Number(a.qty)); left -= take;
            await tx.query("UPDATE stock SET updated_at=NOW(), qty=qty+$1 WHERE id=$2", [take, a.stock_id]);
            await logMove(tx, cid, o.distributor_id ?? null, l.variant_id, a.batch_no || "", take, "short_delivery", `order:${o.client_ref}`, req.user.uid, reason);
            if (take === Number(a.qty)) await tx.query("DELETE FROM order_allocations WHERE id=$1", [a.id]); else await tx.query("UPDATE order_allocations SET qty=qty-$1 WHERE id=$2", [take, a.id]);
          }
        }
        if (partial) {
          const t = (await tx.query("SELECT amount, gross FROM order_lines WHERE order_id=$1", [o.id])).rows;
          const r = (n: number) => Math.round(n * 100) / 100, total = r(t.reduce((a, x) => a + Number(x.amount), 0)), gross = r(t.reduce((a, x) => a + Number(x.gross ?? x.amount), 0));
          Object.assign(u, (await tx.query("UPDATE orders SET total=$1, savings=$2 WHERE id=$3 RETURNING total, savings", [total, r(gross - total), o.id])).rows[0]);
        }
      }
      const label = partial ? "partly delivered" : to;
      await orderEvent(tx, o.id, partial ? "partly_delivered" : to, req.user.uid, reason ?? (partial ? `${o.total} → ${u.total}` : null));
      await tell(tx, cid, u, label, req.user.uid, reason);
      const ev = { id: u.id, client_ref: u.client_ref, from: o.status, status: to, total: Number(u.total), partial };
      await emit(tx, cid, "order.status_changed", ev);
      if (to === "accepted") await emit(tx, cid, "order.approved", ev);
      return u;
    });
    if (to === "accepted" && settings.features.stock) {
      const vids = (await db.query("SELECT DISTINCT variant_id FROM order_lines WHERE order_id=$1", [o.id])).rows.map(r => r.variant_id);
      await checkLowStock(db, cid, vids, o.distributor_id ?? null);
    }
    res.json({ ...updated, partial });
  }));
  // Cancel: the order taker (rep / retailer) while it is still new; the distributor or admin/manager until it is delivered.
  // Stock already picked for an accepted order goes back to the same batches. Invoiced orders need a credit note instead.
  app.post("/api/orders/:id/cancel", auth("sales_rep", "retailer", "distributor", "company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = await retailerShop(req, cid);
    const o = (await db.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    const role = req.user.role;
    const mine = !o ? false : role === "sales_rep" ? o.rep_id === req.user.uid : role === "retailer" ? o.shop_id === own : role === "distributor" ? o.distributor_id === req.user.uid && o.status !== "pending_approval" : true;
    if (!o || !mine) throw bad("order not found", 404);
    const allowed = ["sales_rep", "retailer"].includes(role) ? ["placed", "pending_approval"] : ["pending_approval", "placed", "accepted", "dispatched"];
    if (!allowed.includes(o.status)) throw bad(o.status === "accepted" || o.status === "dispatched" ? "already accepted — ask the distributor to cancel it" : `cannot cancel a ${o.status} order`, 409);
    if ((await db.query("SELECT id FROM invoices WHERE order_id=$1 AND kind='invoice'", [o.id])).rows[0]) throw bad("order is invoiced — issue a credit note instead", 409);
    const reason = String(req.body?.reason || "").trim().slice(0, 300);
    if (!reason) throw bad("reason required");
    const u = await withTx(db, async tx => {
      const u = (await tx.query("UPDATE orders SET updated_at=NOW(), status='cancelled', status_reason=$1, status_by=$2 WHERE id=$3 AND status=$4 RETURNING *", [reason, req.user.uid, o.id, o.status])).rows[0];
      if (!u) throw bad("order changed meanwhile — reload", 409);
      await releaseStock(tx, cid, o, req.user.uid, reason, "cancel");
      await orderEvent(tx, o.id, "cancelled", req.user.uid, reason);
      await tell(tx, cid, u, "cancelled", req.user.uid, reason);
      if (o.distributor_id && o.distributor_id !== req.user.uid && o.status !== "pending_approval")
        await notify(tx, cid, o.distributor_id, "Order #{0} at {1}: {2}", [o.id, await shopName(tx, o.shop_id), "cancelled"], reason, `inbox#${o.id}`);
      await emit(tx, cid, "order.status_changed", { id: u.id, client_ref: u.client_ref, from: o.status, status: "cancelled", total: Number(u.total), reason });
      return u;
    });
    res.json(u);
  }));

  // ---- In-app notifications (bell): newest first; reading marks them read ----
  app.get("/api/notifications", auth("company_admin", "manager", "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id, template, args, note, link, created_at, read_at FROM notifications WHERE company_id=$1 AND user_id=$2 ORDER BY id DESC LIMIT 50", [cid, req.user.uid])).rows
      .map(n => ({ ...n, args: parseJson(n.args, []) })));
  }));
  app.post("/api/notifications/read", auth("company_admin", "manager", "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    await db.query("UPDATE notifications SET read_at=NOW() WHERE company_id=$1 AND user_id=$2 AND read_at IS NULL", [cid, req.user.uid]);
    res.json({ ok: true });
  }));

  // ---- Manager dashboard: visits & orders by rep/day ----
  app.get("/api/dashboard", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 864e5);
    const vs = (await db.query("SELECT v.rep_id, u.name, v.check_in_at FROM visits v JOIN users u ON u.id=v.rep_id WHERE v.company_id=$1 AND v.check_in_at>=$2", [cid, since])).rows;
    const os = (await db.query("SELECT o.rep_id, u.name, o.created_at, o.total FROM orders o JOIN users u ON u.id=o.rep_id WHERE o.company_id=$1 AND o.created_at>=$2 AND u.role='sales_rep' AND o.status NOT IN ('rejected','cancelled')", [cid, since])).rows;
    const m = new Map<string, any>();
    const row = (rep: number, name: string, d: Date) => {
      const k = `${dayKey(d)}|${rep}`;
      if (!m.has(k)) m.set(k, { day: dayKey(d), repId: rep, rep: name, visits: 0, orders: 0, value: 0 });
      return m.get(k);
    };
    for (const v of vs) row(v.rep_id, v.name, v.check_in_at).visits++;
    for (const o of os) { const r = row(o.rep_id, o.name, o.created_at); r.orders++; r.value += Number(o.total); }
    res.json([...m.values()].sort((a, b) => b.day.localeCompare(a.day) || a.rep.localeCompare(b.rep)));
  }));
}

async function hasAllocation(db: Db, oid: number) {
  return !!(await db.query("SELECT 1 FROM order_allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1 LIMIT 1", [oid])).rows[0];
}
/** Put an order's held/allocated stock back into the same batches (cancel, reject, edit). Call inside withTx. */
export async function releaseStock(db: Db, cid: number, o: any, uid: number | null, note: string | null, kind = "release") {
  const al = (await db.query("SELECT a.id, a.stock_id, a.qty, a.batch_no, l.variant_id FROM order_allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1", [o.id])).rows;
  for (const a of al) {
    await db.query("UPDATE stock SET updated_at=NOW(), qty=qty+$1 WHERE id=$2", [a.qty, a.stock_id]);
    await logMove(db, cid, o.distributor_id ?? null, a.variant_id, a.batch_no || "", a.qty, kind, `order:${o.client_ref}`, uid, note);
    await db.query("DELETE FROM order_allocations WHERE id=$1", [a.id]);
  }
}
/** FEFO hold/allocation for an order (taken when it is placed): plan first (a shortfall changes nothing), then apply with compare-and-set. Call inside withTx. */
export async function allocateStock(db: Db, cid: number, o: any, hooks: { afterFirstUpdate?: () => Promise<void> } = {}) {
      // FEFO allocation: plan everything first so a shortfall changes nothing, then apply.
      const lines = (await db.query(`SELECT l.id, l.variant_id, l.base_qty, v.sku, i.kind FROM order_lines l JOIN variants v ON v.id=l.variant_id
        JOIN items i ON i.id=v.item_id WHERE l.order_id=$1 ORDER BY l.id`, [o.id])).rows;
      const pools = new Map<number, any[]>(), plan: { line: number; row: any; take: number }[] = [], orig = new Map<number, number>();
      for (const l of lines.filter(l => l.kind === "goods")) {
        if (!pools.has(l.variant_id)) {
          const rows = await fefoRows(db, cid, o.distributor_id ?? null, l.variant_id);
          rows.forEach(r => orig.set(r.id, r.qty)); pools.set(l.variant_id, rows);
        }
        let left = Number(l.base_qty);
        for (const r of pools.get(l.variant_id)!) { const take = Math.min(r.qty, left); if (take > 0) { plan.push({ line: l.id, row: r, take }); r.qty -= take; left -= take; } }
        if (left > 0) throw bad(`insufficient stock for ${l.sku}: short by ${left}`, 409);
      }
      // Compare-and-set on the quantity we read, so a concurrent change is detected instead of overselling.
      const after = new Map<number, number>();
      for (const p of plan) after.set(p.row.id, (after.get(p.row.id) ?? orig.get(p.row.id)!) - p.take);
      for (const [id, q] of after) {
        const ok = (await db.query("UPDATE stock SET updated_at=NOW(), qty=$1 WHERE id=$2 AND qty=$3 RETURNING id", [q, id, orig.get(id)])).rows[0];
        if (!ok) throw bad("stock changed while allocating — please retry", 409);
        if (hooks.afterFirstUpdate) { const h = hooks.afterFirstUpdate; hooks.afterFirstUpdate = undefined; await h(); }
      }
      for (const p of plan) {
        const vid = lines.find(l => l.id === p.line)!.variant_id;
        await logMove(db, cid, o.distributor_id ?? null, vid, p.row.batch_no || "", -p.take, "sale", `order:${o.client_ref}`, null);
      }
      for (const p of plan) {
        await db.query("INSERT INTO order_allocations (order_line_id,stock_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5)", [p.line, p.row.id, p.row.batch_no, p.row.expiry, p.take]);
      }
    }
