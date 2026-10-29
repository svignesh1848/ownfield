// Leads: prospect outlets or dealers, follow-ups with next dates, and conversion into a real outlet (shop).
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, today } from "./catalog.js";
import { emit } from "./integrations/webhooks.js";
import { type Ctx, MGR, requireFeature, dateOk } from "./common.js";

export const LEAD_STATUSES = ["new", "contacted", "interested", "converted", "lost"];
const t = (v: unknown, n = 120) => v == null || v === "" ? null : String(v).trim().slice(0, n);

export function registerLeadRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const mine = (req: any) => req.user.role === "sales_rep";
  const get = async (req: any, cid: number) => {
    const l = (await db.query("SELECT * FROM leads WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!l || (mine(req) && l.assigned_to !== req.user.uid && l.created_by !== req.user.uid)) throw bad("lead not found", 404); return l;
  };
  app.get("/api/leads", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const args: unknown[] = [cid]; let w = "l.company_id=$1";
    if (mine(req)) { args.push(req.user.uid); w += " AND (l.assigned_to=$2 OR l.created_by=$2)"; }
    if (req.query.status) { args.push(String(req.query.status)); w += ` AND l.status=$${args.length}`; }
    if (req.query.due) { args.push(today()); w += ` AND l.next_follow_up<=$${args.length} AND l.status NOT IN ('converted','lost')`; }
    res.json((await db.query(`SELECT l.*, u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE ${w} ORDER BY COALESCE(l.next_follow_up,'9999'), l.id DESC LIMIT 500`, args)).rows);
  }));
  app.post("/api/leads", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const b = req.body || {}; const name = t(b.name); if (!name) throw bad("enter the business name");
    const kind = b.kind === "dealer" ? "dealer" : "outlet";
    if (b.next_follow_up && !dateOk(b.next_follow_up)) throw bad("pick a valid follow-up date");
    const assigned = mine(req) ? req.user.uid : b.assigned_to ? Number(b.assigned_to) : null;
    if (assigned && !(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2", [assigned, cid])).rows[0]) throw bad("user not found", 404);
    res.status(201).json((await db.query(`INSERT INTO leads (company_id,name,kind,owner_name,phone,city,address,pincode,gstin,source,assigned_to,next_follow_up,notes,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [cid, name, kind, t(b.owner_name), t(b.phone, 20), t(b.city), t(b.address, 300), t(b.pincode, 6), t(b.gstin, 15), t(b.source), assigned, t(b.next_follow_up, 10), t(b.notes, 500), req.user.uid])).rows[0]);
  }));
  app.patch("/api/leads/:id", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const l = await get(req, cid), b = req.body || {};
    if (b.status && !LEAD_STATUSES.filter(x => x !== "converted").includes(b.status)) throw bad("use Convert to make it an outlet");
    if (b.next_follow_up && !dateOk(b.next_follow_up)) throw bad("pick a valid follow-up date");
    const f = (k: string, n?: number) => k in b ? t(b[k], n) : l[k];
    res.json((await db.query(`UPDATE leads SET name=$1, owner_name=$2, phone=$3, city=$4, address=$5, status=$6, next_follow_up=$7, notes=$8, lost_reason=$9, assigned_to=$10, updated_at=NOW() WHERE id=$11 RETURNING *`,
      [f("name") || l.name, f("owner_name"), f("phone", 20), f("city"), f("address", 300), b.status || l.status, f("next_follow_up", 10), f("notes", 500), f("lost_reason", 200), mine(req) ? l.assigned_to : b.assigned_to !== undefined ? (Number(b.assigned_to) || null) : l.assigned_to, l.id])).rows[0]);
  }));
  app.get("/api/leads/:id/followups", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const l = await get(req, cid);
    res.json((await db.query("SELECT f.*, u.name AS by_name FROM lead_followups f LEFT JOIN users u ON u.id=f.user_id WHERE f.lead_id=$1 ORDER BY f.id DESC", [l.id])).rows);
  }));
  app.post("/api/leads/:id/followups", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const l = await get(req, cid), note = t(req.body?.note, 500); if (!note) throw bad("write what happened");
    const next = req.body?.next_date ? String(req.body.next_date) : null; if (next && !dateOk(next)) throw bad("pick a valid next date");
    const f = (await db.query("INSERT INTO lead_followups (lead_id,user_id,note,outcome,next_date) VALUES ($1,$2,$3,$4,$5) RETURNING *", [l.id, req.user.uid, note, t(req.body?.outcome, 40), next])).rows[0];
    await db.query("UPDATE leads SET next_follow_up=$1, status=CASE WHEN status='new' THEN 'contacted' ELSE status END, updated_at=NOW() WHERE id=$2", [next, l.id]);
    res.status(201).json(f);
  }));
  /** Convert: creates the outlet with code LEAD-<id> (or a given code) and links it to the lead. */
  app.post("/api/leads/:id/convert", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leads");
    const l = await get(req, cid); if (l.status === "converted") throw bad("already converted", 409);
    const code = String(req.body?.code || `LEAD-${l.id}`).trim().slice(0, 40);
    const shop = await withTx(db, async tx => {
      if ((await tx.query("SELECT id FROM shops WHERE company_id=$1 AND code=$2", [cid, code])).rows[0]) throw bad(`outlet code ${code} already exists`, 409);
      const s = (await tx.query("INSERT INTO shops (company_id,code,name,owner_name,phone,address,city,pincode,gstin,state_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [cid, code, l.name, l.owner_name, l.phone, l.address, l.city, l.pincode, l.gstin, l.gstin ? String(l.gstin).slice(0, 2) : null])).rows[0];
      await tx.query("UPDATE leads SET status='converted', shop_id=$1, updated_at=NOW() WHERE id=$2", [s.id, l.id]);
      return s;
    });
    await emit(db, cid, "lead.converted", { lead_id: l.id, shop_id: shop.id, code: shop.code, name: shop.name });
    res.status(201).json({ lead_id: l.id, shop });
  }));
}
