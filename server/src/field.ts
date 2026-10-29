// Step 2: beats, visits (GPS check-in/out), orders, distributor inbox, manager dashboard.
import type { Express, Request, Response, NextFunction } from "express";
import type { Db } from "./db.js";

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void; tenant: (req: any, res: Response) => number | null };
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const coord = (lat: unknown, lng: unknown) => {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) throw bad("valid lat/lng required");
  return [a, b];
};
export const TRANSITIONS: Record<string, string[]> = { placed: ["accepted", "rejected"], accepted: ["fulfilled"] };
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
    await db.query("UPDATE shops SET distributor_id=$1 WHERE id=$2", [d == null ? null : Number(d), Number(req.params.id)]);
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
    for (const b of beats) b.shops = (await db.query(`SELECT s.id,s.code,s.name,s.city,bs.seq FROM beat_shops bs JOIN shops s ON s.id=bs.shop_id
      WHERE bs.beat_id=$1 ORDER BY bs.seq`, [b.id])).rows;
    res.json(beats);
  }));

  // ---- Visits ----
  app.post("/api/visits/checkin", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const [lat, lng] = coord(req.body?.lat, req.body?.lng);
    if (!(await shopIn(cid, req.body?.shopId))) throw bad("shop not found", 404);
    const open = (await db.query("SELECT id FROM visits WHERE rep_id=$1 AND check_out_at IS NULL", [req.user.uid])).rows[0];
    if (open) throw bad("check out of the current visit first", 409);
    res.status(201).json((await db.query("INSERT INTO visits (company_id,rep_id,shop_id,in_lat,in_lng) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [cid, req.user.uid, Number(req.body.shopId), lat, lng])).rows[0]);
  }));
  app.post("/api/visits/:id/checkout", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const [lat, lng] = coord(req.body?.lat, req.body?.lng);
    const r = await db.query(`UPDATE visits SET check_out_at=NOW(), out_lat=$1, out_lng=$2, notes=$3
      WHERE id=$4 AND company_id=$5 AND rep_id=$6 AND check_out_at IS NULL RETURNING *`, [lat, lng, req.body?.notes ?? null, Number(req.params.id), cid, req.user.uid]);
    if (!r.rows[0]) throw bad("open visit not found", 404);
    res.json(r.rows[0]);
  }));
  app.get("/api/visits", auth("company_admin", "manager", "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const mine = req.user.role === "sales_rep";
    res.json((await db.query(`SELECT v.*, s.name AS shop_name, u.name AS rep_name FROM visits v JOIN shops s ON s.id=v.shop_id JOIN users u ON u.id=v.rep_id
      WHERE v.company_id=$1 ${mine ? "AND v.rep_id=$2" : ""} ORDER BY v.id DESC`, mine ? [cid, req.user.uid] : [cid])).rows);
  }));

  // ---- Orders (idempotent on clientRef so the offline queue can safely retry) ----
  app.post("/api/orders", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { clientRef, shopId, lines } = req.body || {};
    if (!clientRef) throw bad("clientRef required");
    const dup = (await db.query("SELECT * FROM orders WHERE company_id=$1 AND client_ref=$2", [cid, String(clientRef)])).rows[0];
    if (dup) return res.status(200).json({ ...dup, duplicate: true });
    const shop = await shopIn(cid, shopId); if (!shop) throw bad("shop not found", 404);
    const items = (Array.isArray(lines) ? lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!items.length) throw bad("at least one line with qty > 0");
    const priced = [] as { pid: number; qty: number; price: number }[];
    for (const l of items) {
      if (!Number.isInteger(Number(l.qty))) throw bad("qty must be an integer");
      const p = (await db.query("SELECT id,billing_price FROM products WHERE company_id=$1 AND (id=$2 OR sku=$3)", [cid, Number(l.productId) || 0, String(l.sku ?? "")])).rows[0];
      if (!p) throw bad(`product ${l.sku ?? l.productId} not found`, 404);
      priced.push({ pid: p.id, qty: Number(l.qty), price: Number(p.billing_price) });
    }
    const total = priced.reduce((a, l) => a + l.qty * l.price, 0);
    const o = (await db.query("INSERT INTO orders (company_id,client_ref,rep_id,shop_id,distributor_id,total) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [cid, String(clientRef), req.user.uid, shop.id, shop.distributor_id ?? null, total])).rows[0];
    for (const l of priced) await db.query("INSERT INTO order_lines (order_id,product_id,qty,price) VALUES ($1,$2,$3,$4)", [o.id, l.pid, l.qty, l.price]);
    res.status(201).json(o);
  }));
  app.get("/api/orders", auth("company_admin", "manager", "sales_rep", "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const scope = req.user.role === "sales_rep" ? "AND o.rep_id=$2" : req.user.role === "distributor" ? "AND o.distributor_id=$2" : "";
    const orders = (await db.query(`SELECT o.*, s.name AS shop_name, u.name AS rep_name FROM orders o JOIN shops s ON s.id=o.shop_id JOIN users u ON u.id=o.rep_id
      WHERE o.company_id=$1 ${scope} ORDER BY o.id DESC`, scope ? [cid, req.user.uid] : [cid])).rows;
    for (const o of orders) o.lines = (await db.query(`SELECT l.qty,l.price,p.sku,p.style,p.size FROM order_lines l JOIN products p ON p.id=l.product_id WHERE l.order_id=$1 ORDER BY l.id`, [o.id])).rows;
    res.json(orders);
  }));
  app.post("/api/orders/:id/status", auth("distributor", "company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const o = (await db.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!o || (req.user.role === "distributor" && o.distributor_id !== req.user.uid)) throw bad("order not found", 404);
    const to = String(req.body?.status || "");
    if (!(TRANSITIONS[o.status] || []).includes(to)) throw bad(`cannot move ${o.status} -> ${to}`, 409);
    res.json((await db.query("UPDATE orders SET status=$1 WHERE id=$2 RETURNING *", [to, o.id])).rows[0]);
  }));

  // ---- Manager dashboard: visits & orders by rep/day ----
  app.get("/api/dashboard", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 864e5);
    const vs = (await db.query("SELECT v.rep_id, u.name, v.check_in_at FROM visits v JOIN users u ON u.id=v.rep_id WHERE v.company_id=$1 AND v.check_in_at>=$2", [cid, since])).rows;
    const os = (await db.query("SELECT o.rep_id, u.name, o.created_at, o.total FROM orders o JOIN users u ON u.id=o.rep_id WHERE o.company_id=$1 AND o.created_at>=$2", [cid, since])).rows;
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
