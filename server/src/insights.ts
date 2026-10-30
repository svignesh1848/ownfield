// Step 4: targets vs achievement, visit photos, Excel/CSV report exports.
import { schemeCost } from "./schemes.js";
import { ageingRows } from "./collections.js";
import type { Express, Response, Request, NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Db } from "./db.js";
import { bad, parseJson, parseDate, today } from "./catalog.js";
import { dayKey } from "./field.js";
import { photoStore } from "./storage.js";

export const METRICS = ["value", "orders", "visits"] as const;
const monthOk = (m: unknown) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));

export async function achievement(db: Db, cid: number, month: string, repId?: number) {
  const reps = (await db.query(`SELECT id, name, email FROM users WHERE company_id=$1 AND role='sales_rep' AND active=TRUE ${repId ? "AND id=$2" : ""} ORDER BY name`, repId ? [cid, repId] : [cid])).rows;
  const tg = (await db.query("SELECT rep_id, metric, target FROM targets WHERE company_id=$1 AND month=$2", [cid, month])).rows;
  const orders = (await db.query("SELECT rep_id, total, created_at FROM orders WHERE company_id=$1 AND status NOT IN ('rejected','cancelled')", [cid])).rows.filter(o => dayKey(o.created_at).startsWith(month));
  const visits = (await db.query("SELECT rep_id, check_in_at FROM visits WHERE company_id=$1", [cid])).rows.filter(v => dayKey(v.check_in_at).startsWith(month));
  return reps.map(r => {
    const mine = orders.filter(o => o.rep_id === r.id);
    const actual = { value: Math.round(mine.reduce((a, o) => a + Number(o.total), 0) * 100) / 100, orders: mine.length, visits: visits.filter(v => v.rep_id === r.id).length };
    const metrics = METRICS.map(m => { const t = tg.find(x => x.rep_id === r.id && x.metric === m); const target = t ? Number(t.target) : null;
      return { metric: m, target, actual: actual[m], pct: target ? Math.round(actual[m] / target * 1000) / 10 : null }; });
    return { repId: r.id, rep: r.name, email: r.email, month, metrics };
  });
}

export async function setTarget(db: Db, cid: number, t: { repId?: number; repEmail?: string; month: string; metric: string; target: number }) {
  if (!monthOk(t.month)) throw bad("month must be YYYY-MM");
  if (!(METRICS as readonly string[]).includes(t.metric)) throw bad(`metric must be ${METRICS.join("/")}`);
  const target = Number(t.target); if (!(target > 0)) throw bad("target must be > 0");
  const rep = (await db.query(`SELECT id FROM users WHERE company_id=$1 AND role='sales_rep' AND ${t.repId ? "id=$2" : "email=$2"}`, [cid, t.repId ?? String(t.repEmail || "").toLowerCase().trim()])).rows[0];
  if (!rep) throw bad("sales rep not found", 404);
  const ex = (await db.query("SELECT id FROM targets WHERE company_id=$1 AND rep_id=$2 AND month=$3 AND metric=$4", [cid, rep.id, t.month, t.metric])).rows[0];
  if (ex) { await db.query("UPDATE targets SET target=$1 WHERE id=$2", [target, ex.id]); return "updated"; }
  await db.query("INSERT INTO targets (company_id,rep_id,month,metric,target) VALUES ($1,$2,$3,$4,$5)", [cid, rep.id, t.month, t.metric, target]);
  return "inserted";
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void };

const MAGIC: [string, (b: Buffer) => boolean][] = [["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8], ["image/png", b => b.subarray(0, 4).toString("hex") === "89504e47"],
  ["image/webp", b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"]];

export function registerInsightRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const MGR = ["company_admin", "manager"];

  // ---- Targets ----
  app.put("/api/targets", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    await setTarget(db, cid, req.body || {}); res.json({ ok: true });
  }));
  app.get("/api/targets", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const month = String(req.query.month || today().slice(0, 7)); if (!monthOk(month)) throw bad("month must be YYYY-MM");
    res.json(await achievement(db, cid, month, req.user.role === "sales_rep" ? req.user.uid : undefined));
  }));

  // ---- Visit photos ----
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.post("/api/visits/:id/photos", auth("sales_rep"), upload.single("photo"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const v = (await db.query("SELECT * FROM visits WHERE id=$1 AND company_id=$2 AND rep_id=$3", [Number(req.params.id), cid, req.user.uid])).rows[0];
    if (!v) throw bad("visit not found", 404);
    if (v.check_out_at && dayKey(v.check_in_at) !== today()) throw bad("photos can only be added to today's visits", 409);
    if (!req.file) throw bad("photo required");
    const mime = MAGIC.find(([, ok]) => ok(req.file!.buffer))?.[0]; if (!mime) throw bad("only JPEG, PNG or WebP images");
    const n = (await db.query("SELECT COUNT(*) AS n FROM visit_photos WHERE visit_id=$1", [v.id])).rows[0].n;
    if (Number(n) >= 10) throw bad("max 10 photos per visit", 409);
    const rel = path.join(String(cid), `${crypto.randomUUID()}.${mime.split("/")[1]}`);
    await photoStore().put(rel, req.file.buffer, mime);
    res.status(201).json((await db.query("INSERT INTO visit_photos (company_id,visit_id,file,mime,size,caption) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,visit_id,mime,size,caption,created_at",
      [cid, v.id, rel, mime, req.file.size, String(req.body?.caption || "").slice(0, 200) || null])).rows[0]);
  }));
  const photoScope = (req: any) => req.user.role === "sales_rep" ? "AND v.rep_id=$3" : "";
  app.get("/api/visits/:id/photos", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const p = [Number(req.params.id), cid, ...(req.user.role === "sales_rep" ? [req.user.uid] : [])];
    res.json((await db.query(`SELECT p.id,p.mime,p.size,p.caption,p.created_at FROM visit_photos p JOIN visits v ON v.id=p.visit_id WHERE p.visit_id=$1 AND p.company_id=$2 ${photoScope(req)} ORDER BY p.id`, p)).rows);
  }));
  app.get("/api/photos/:id", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const p = [Number(req.params.id), cid, ...(req.user.role === "sales_rep" ? [req.user.uid] : [])];
    const ph = (await db.query(`SELECT p.* FROM visit_photos p JOIN visits v ON v.id=p.visit_id WHERE p.id=$1 AND p.company_id=$2 ${photoScope(req)}`, p)).rows[0];
    if (!ph) throw bad("photo not found", 404);
    res.type(ph.mime).set("Cache-Control", "private, max-age=86400").send(await photoStore().get(ph.file));
  }));

  // ---- Reports (Excel / CSV) ----
  app.get("/api/reports/:kind", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const to = req.query.to ? parseDate(req.query.to)! : today(), from = req.query.from ? parseDate(req.query.from)! : `${to.slice(0, 8)}01`;
    if (from > to) throw bad("from must be on or before to");
    const inRange = (d: string) => d >= from && d <= to;
    let rows: Record<string, unknown>[];
    switch (req.params.kind) {
      case "orders": rows = (await db.query(`SELECT o.id, o.created_at, o.status, u.name AS rep, s.code AS outlet_code, s.name AS outlet, d.name AS distributor, v.sku, i.name AS item, v.attrs,
          l.qty, l.uom, l.base_qty, l.price, l.discount_pct, l.amount, l.free, sc.name AS scheme FROM orders o JOIN order_lines l ON l.order_id=o.id JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
          JOIN users u ON u.id=o.rep_id JOIN shops s ON s.id=o.shop_id LEFT JOIN users d ON d.id=o.distributor_id LEFT JOIN schemes sc ON sc.id=l.scheme_id WHERE o.company_id=$1 ORDER BY o.id, l.id`, [cid])).rows
        .filter(r => inRange(dayKey(r.created_at))).map(r => ({ order_id: r.id, date: dayKey(r.created_at), status: r.status, rep: r.rep, outlet_code: r.outlet_code, outlet: r.outlet,
          distributor: r.distributor || "Company", sku: r.sku, item: r.item, variant: Object.values(parseJson(r.attrs, {})).join(" / "), qty: Number(r.qty), unit: r.uom,
          base_qty: Number(r.base_qty), price: Number(r.price), discount_pct: Number(r.discount_pct), amount: Number(r.amount), scheme: r.scheme || "", free: r.free ? "yes" : "" })); break;
      case "visits": {
        const vs = (await db.query(`SELECT v.*, u.name AS rep, s.code, s.name AS outlet FROM visits v JOIN users u ON u.id=v.rep_id JOIN shops s ON s.id=v.shop_id
          WHERE v.company_id=$1 ORDER BY v.id`, [cid])).rows.filter(r => inRange(dayKey(r.check_in_at)));
        const pc = new Map<number, number>();
        for (const p of (await db.query("SELECT visit_id FROM visit_photos WHERE company_id=$1", [cid])).rows) pc.set(p.visit_id, (pc.get(p.visit_id) ?? 0) + 1);
        for (const r of vs) r.photos = pc.get(r.id) ?? 0;
        rows = vs.map(r => ({ visit_id: r.id, date: dayKey(r.check_in_at), rep: r.rep, outlet_code: r.code, outlet: r.outlet, check_in: new Date(r.check_in_at).toISOString(),
          check_out: r.check_out_at ? new Date(r.check_out_at).toISOString() : "", minutes: r.check_out_at ? Math.round((+new Date(r.check_out_at) - +new Date(r.check_in_at)) / 60000) : "",
          lat: r.in_lat ?? "", lng: r.in_lng ?? "", photos: Number(r.photos), ...parseJson<Record<string, unknown>>(r.custom, {}) })); break;
      }
      case "gst": rows = (await db.query(`SELECT i.number, i.kind, i.doc_date, i.buyer, i.place_of_supply, l.hsn, l.description, l.base_qty, l.uom, l.taxable, l.gst_rate, l.cgst, l.sgst, l.igst, l.total
          FROM invoices i JOIN invoice_lines l ON l.invoice_id=i.id WHERE i.company_id=$1 ORDER BY i.id, l.id`, [cid])).rows.filter(r => inRange(r.doc_date)).map(r => {
          const b = parseJson<any>(r.buyer, {}), sign = r.kind === "credit_note" ? -1 : 1;
          return { document: r.number, type: r.kind === "invoice" ? "Invoice" : "Credit note", date: r.doc_date, buyer: b.name, buyer_gstin: b.gstin || "", place_of_supply: r.place_of_supply,
            hsn: r.hsn || "", description: r.description, qty: Number(r.base_qty) * sign, unit: r.uom, taxable: Number(r.taxable) * sign, gst_rate: Number(r.gst_rate),
            cgst: Number(r.cgst) * sign, sgst: Number(r.sgst) * sign, igst: Number(r.igst) * sign, total: Number(r.total) * sign }; }); break;
      case "stock": rows = (await db.query(`SELECT st.*, v.sku, i.name, u.name AS location FROM stock st JOIN variants v ON v.id=st.variant_id JOIN items i ON i.id=v.item_id
          LEFT JOIN users u ON u.id=st.distributor_id WHERE st.company_id=$1 ORDER BY v.sku, st.expiry`, [cid])).rows.map(r => ({ location: r.location || "Company stock", sku: r.sku, item: r.name,
          batch: r.batch_no, expiry: r.expiry || "", qty_base: Number(r.qty), expired: r.expiry && r.expiry < today() ? "yes" : "" })); break;
      case "targets": rows = (await achievement(db, cid, String(req.query.month || to.slice(0, 7)))).flatMap(r => r.metrics.map(m => ({ month: r.month, rep: r.rep, metric: m.metric, target: m.target ?? "", actual: m.actual, pct: m.pct ?? "" }))); break;
      case "ageing": rows = await ageingRows(db, cid, to); break;
      case "schemes": rows = await schemeCost(db, cid, inRange, dayKey); break;
      default: throw bad("unknown report — use orders, visits, gst, stock, targets, schemes or ageing", 404);
    }
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "no rows for this period" }]);
    const name = `${req.params.kind}-${from}-to-${to}`;
    if (req.query.format === "csv") return res.type("text/csv").attachment(`${name}.csv`).send(XLSX.utils.sheet_to_csv(ws));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, req.params.kind);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`${name}.xlsx`).send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  }));
}
