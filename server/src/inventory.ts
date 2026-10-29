// Distributor inventory: stock per product / batch / age at each distributor, goods in/out, and a movement ledger.
// Orders (on acceptance), credit-note returns and PO receipts update stock already; each change is also written to stock_moves.
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, parseDate } from "./catalog.js";
import { checkLowStock } from "./integrations/webhooks.js";
import { type Ctx, MGR, requireFeature } from "./common.js";
import { getFlow } from "./flow.js";

export async function logMove(db: Db, cid: number, dist: number | null, vid: number, batch: string, qty: number, kind: string, ref: string | null, uid: number | null, note: string | null = null) {
  await db.query("INSERT INTO stock_moves (company_id,distributor_id,variant_id,batch_no,qty,kind,ref,user_id,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [cid, dist, vid, batch || "", qty, kind, ref, uid, note]);
}
const AGE = (d: number) => d <= 30 ? "0-30 days" : d <= 60 ? "31-60 days" : d <= 90 ? "61-90 days" : "90+ days";

export function registerInventoryRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const loc = (req: any) => req.user.role === "distributor" ? req.user.uid : req.query.distributorId === "company" || req.body?.distributorId === "company" ? null : Number(req.query.distributorId ?? req.body?.distributorId) || null;
  app.get("/api/inventory", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "distInventory");
    const d = loc(req), args: unknown[] = [cid]; let w = "s.company_id=$1";
    if (req.user.role === "distributor" || req.query.distributorId) { if (d == null) w += " AND s.distributor_id IS NULL"; else { args.push(d); w += " AND s.distributor_id=$2"; } }
    const rows = (await db.query(`SELECT s.id, s.distributor_id, u.name AS distributor, v.sku, v.barcode, i.name, s.batch_no, s.expiry, s.qty, s.received_at FROM stock s JOIN variants v ON v.id=s.variant_id JOIN items i ON i.id=v.item_id
      LEFT JOIN users u ON u.id=s.distributor_id WHERE ${w} AND s.qty<>0 ORDER BY u.name, v.sku, s.expiry`, args)).rows;
    const now = Date.now();
    const out = rows.map(r => { const age = Math.max(0, Math.floor((now - new Date(r.received_at).getTime()) / 864e5)); const days = r.expiry ? Math.floor((Date.parse(r.expiry) - now) / 864e5) : null;
      return { ...r, distributor: r.distributor || "Company warehouse", age_days: age, age_band: AGE(age), expires_in_days: days }; });
    const bands: Record<string, number> = {}; for (const r of out) bands[r.age_band] = (bands[r.age_band] || 0) + Number(r.qty);
    res.json({ rows: out, ageing: bands });
  }));
  app.get("/api/inventory/moves", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "distInventory");
    const d = loc(req), args: unknown[] = [cid]; let w = "m.company_id=$1";
    if (req.user.role === "distributor" || req.query.distributorId) { if (d == null) w += " AND m.distributor_id IS NULL"; else { args.push(d); w += " AND m.distributor_id=$2"; } }
    res.json((await db.query(`SELECT m.id, m.created_at, m.kind, v.sku, m.batch_no, m.qty, m.reason, m.ref, m.note, u.name AS distributor FROM stock_moves m JOIN variants v ON v.id=m.variant_id LEFT JOIN users u ON u.id=m.distributor_id
      WHERE ${w} ORDER BY m.id DESC LIMIT 200`, args)).rows);
  }));
  /** Goods in (receipt), goods out (issue, damage, transfer) or a counted adjustment. kind: in | out | adjust. */
  app.post("/api/inventory/moves", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; const s = await requireFeature(db, cid, "distInventory");
    if (!s.features.stock) throw bad("turn on stock tracking first");
    const b = req.body || {}, kind = String(b.kind || ""), d = loc(req);
    if (!["in", "out", "adjust"].includes(kind)) throw bad("kind must be in, out or adjust");
    if (d != null && !(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='distributor'", [d, cid])).rows[0]) throw bad("distributor not found", 404);
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => l.sku);
    if (!lines.length) throw bad("add at least one product");
    // Adjustments and goods-out need a reason code; with approval on, a distributor's request waits for a manager.
    const flow = await getFlow(db, cid); const reason = b.reason ? String(b.reason).trim().slice(0, 80) : null;
    if (kind !== "in") { if (!reason) throw bad("Pick a reason for this stock change"); if (!flow.adjustReasons.includes(reason)) throw bad("pick one of the listed reasons"); }
    if (kind !== "in" && flow.adjustApproval && req.user.role === "distributor" && !b._approved) {
      const r = (await db.query("INSERT INTO stock_adjust_requests (company_id,distributor_id,body,reason,requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [cid, d, JSON.stringify({ ...b, distributorId: d }), reason, req.user.uid])).rows[0];
      return res.status(202).json({ pending: true, id: r.id });
    }
    const touched = await applyMoves(db, cid, s, d, kind, lines, b, reason, req.user.uid);
    await checkLowStock(db, cid, touched, d);
    res.status(201).json({ ok: true, lines: lines.length });
  }));
  app.get("/api/inventory/adjustments", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "distInventory");
    const own = req.user.role === "distributor";
    res.json((await db.query(`SELECT r.*, u.name AS distributor, q.name AS requested_by_name FROM stock_adjust_requests r LEFT JOIN users u ON u.id=r.distributor_id LEFT JOIN users q ON q.id=r.requested_by
      WHERE r.company_id=$1 ${own ? "AND r.distributor_id=$2" : ""} ORDER BY r.id DESC LIMIT 100`, own ? [cid, req.user.uid] : [cid])).rows.map(r => ({ ...r, body: JSON.parse(r.body) })));
  }));
  app.post("/api/inventory/adjustments/:id/decide", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; const s = await requireFeature(db, cid, "distInventory");
    const r = (await db.query("SELECT * FROM stock_adjust_requests WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!r) throw bad("request not found", 404);
    if (r.status !== "pending") throw bad("already decided", 409);
    const approve = req.body?.approve === true;
    if (!approve && !String(req.body?.note || "").trim()) throw bad("give a reason for rejecting");
    if (approve) { const b = JSON.parse(r.body); const touched = await applyMoves(db, cid, s, r.distributor_id, String(b.kind), b.lines, b, r.reason, req.user.uid); await checkLowStock(db, cid, touched, r.distributor_id); }
    await db.query("UPDATE stock_adjust_requests SET status=$1, decided_by=$2, decided_at=NOW(), note=$3 WHERE id=$4", [approve ? "approved" : "rejected", req.user.uid, req.body?.note ? String(req.body.note).slice(0, 200) : null, r.id]);
    res.json({ ok: true, status: approve ? "approved" : "rejected" });
  }));
}

async function applyMoves(db: Db, cid: number, s: any, d: number | null, kind: string, lines: any[], b: any, reason: string | null, uid: number) {
    const touched: number[] = [];
    await withTx(db, async tx => {
      for (const l of lines) {
        const v = (await tx.query("SELECT v.id, v.sku FROM variants v WHERE v.company_id=$1 AND (v.sku=$2 OR v.barcode=$2)", [cid, String(l.sku).trim()])).rows[0];
        if (!v) throw bad(`product ${l.sku} not found`, 404);
        const q = Number(l.qty); if (!Number.isInteger(q) || q < 0 || (kind !== "adjust" && q === 0)) throw bad("quantities must be whole numbers");
        const batch = String(l.batch_no ?? l.batch ?? "").trim(), expiry = l.expiry ? parseDate(l.expiry) : null;
        if (s.features.batches && kind === "in" && (!batch || !expiry)) throw bad("batch and expiry required");
        const ex = (await tx.query(`SELECT id, qty FROM stock WHERE company_id=$1 AND variant_id=$2 AND batch_no=$3 AND ${d == null ? "distributor_id IS NULL" : "distributor_id=$4"}`, d == null ? [cid, v.id, batch] : [cid, v.id, batch, d])).rows[0];
        const cur = ex ? Number(ex.qty) : 0, next = kind === "in" ? cur + q : kind === "out" ? cur - q : q;
        if (next < 0) throw bad(`only ${cur} of ${v.sku} in stock`, 409);
        if (ex) { if (!(await tx.query("UPDATE stock SET updated_at=NOW(), qty=$1 WHERE id=$2 AND qty=$3 RETURNING id", [next, ex.id, ex.qty])).rows[0]) throw bad("stock changed — retry", 409); }
        else await tx.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5,$6)", [cid, d, v.id, batch, expiry, next]);
        await logMove(tx, cid, d, v.id, batch, next - cur, kind, b.ref ? String(b.ref).slice(0, 60) : null, uid, b.note ? String(b.note).slice(0, 200) : null);
        if (reason) await tx.query("UPDATE stock_moves SET reason=$1 WHERE id=(SELECT MAX(id) FROM stock_moves WHERE company_id=$2)", [reason, cid]);
        touched.push(v.id);
      }
    });
    return touched;
}
