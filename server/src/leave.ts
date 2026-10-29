// Phase 3.3: leave & attendance — rep applies, manager approves; approved leave blocks check-ins on that day
// and marks the rep's beat as "on leave". Attendance = days with at least one visit, plus leave days.
import type { Db } from "./db.js";
import { bad, today, getCompany } from "./catalog.js";
import { dayKey } from "./field.js";
import { type Ctx, MGR, requireFeature, monthOk, dateOk } from "./common.js";

export const LEAVE_KINDS = ["Casual", "Sick", "Other"];
/** Approved leave covering this day for the rep (only when the Leave feature is on). */
export async function onLeave(db: Db, cid: number, repId: number, day = today()) {
  const { settings } = await getCompany(db, cid); if (!settings.features.leave) return null;
  return (await db.query("SELECT * FROM leaves WHERE company_id=$1 AND rep_id=$2 AND status='approved' AND from_date<=$3 AND to_date>=$3", [cid, repId, day])).rows[0] ?? null;
}
const days = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(+d + 864e5)) out.push(d.toISOString().slice(0, 10)); return out; };

export function registerLeaveRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.post("/api/leaves", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leave");
    const b = req.body || {}; const from = String(b.from || ""), to = String(b.to || b.from || "");
    if (!dateOk(from) || !dateOk(to)) throw bad("pick the leave dates");
    if (to < from) throw bad("the last day can't be before the first day");
    if (days(from, to).length > 60) throw bad("leave can be up to 60 days at a time");
    const kind = LEAVE_KINDS.find(k => k.toLowerCase() === String(b.kind || "Casual").toLowerCase()); if (!kind) throw bad(`type must be ${LEAVE_KINDS.join(", ")}`);
    const clash = (await db.query("SELECT id FROM leaves WHERE company_id=$1 AND rep_id=$2 AND status<>'rejected' AND from_date<=$4 AND to_date>=$3", [cid, req.user.uid, from, to])).rows[0];
    if (clash) throw bad("you already applied for leave on these days", 409);
    res.status(201).json((await db.query("INSERT INTO leaves (company_id,rep_id,from_date,to_date,kind,reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [cid, req.user.uid, from, to, kind, String(b.reason || "").slice(0, 200) || null])).rows[0]);
  }));
  app.get("/api/leaves", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leave");
    const rep = req.user.role === "sales_rep";
    res.json((await db.query(`SELECT l.*, u.name AS rep_name FROM leaves l JOIN users u ON u.id=l.rep_id WHERE l.company_id=$1 ${rep ? "AND l.rep_id=$2" : ""} ORDER BY l.from_date DESC, l.id DESC`,
      rep ? [cid, req.user.uid] : [cid])).rows.map(l => ({ ...l, days: days(l.from_date, l.to_date).length })));
  }));
  app.post("/api/leaves/:id/decision", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leave");
    const to = String(req.body?.status || ""); if (!["approved", "rejected"].includes(to)) throw bad("status must be approved or rejected");
    const r = await db.query("UPDATE leaves SET status=$1, decided_by=$2, decided_at=NOW(), note=$3 WHERE id=$4 AND company_id=$5 AND status='pending' RETURNING *",
      [to, req.user.uid, String(req.body?.note || "").slice(0, 200) || null, Number(req.params.id), cid]);
    if (!r.rows[0]) throw bad("pending leave not found", 404);
    res.json(r.rows[0]);
  }));
  app.post("/api/leaves/:id/cancel", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = await db.query("UPDATE leaves SET status='rejected', note='Cancelled by rep' WHERE id=$1 AND company_id=$2 AND rep_id=$3 AND status='pending' RETURNING id", [Number(req.params.id), cid, req.user.uid]);
    if (!r.rows[0]) throw bad("pending leave not found", 404); res.json({ ok: true });
  }));
  // Attendance for a month: present = days with a visit; leave = approved leave days.
  app.get("/api/attendance", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "leave");
    const month = monthOk(req.query.month) ? String(req.query.month) : today().slice(0, 7);
    const rep = req.user.role === "sales_rep";
    const reps = (await db.query(`SELECT id, name FROM users WHERE company_id=$1 AND role='sales_rep' AND active=TRUE ${rep ? "AND id=$2" : ""} ORDER BY name`, rep ? [cid, req.user.uid] : [cid])).rows;
    const vs = (await db.query("SELECT rep_id, check_in_at FROM visits WHERE company_id=$1", [cid])).rows;
    const ls = (await db.query("SELECT rep_id, from_date, to_date FROM leaves WHERE company_id=$1 AND status='approved' AND from_date<=$3 AND to_date>=$2", [cid, `${month}-01`, `${month}-31`])).rows;
    res.json({ month, reps: reps.map(r => {
      const present = [...new Set(vs.filter(v => v.rep_id === r.id).map(v => dayKey(v.check_in_at)).filter(d => d.startsWith(month)))].sort();
      const leave = [...new Set(ls.filter(l => l.rep_id === r.id).flatMap(l => days(l.from_date, l.to_date)).filter(d => d.startsWith(month)))].sort();
      return { repId: r.id, rep: r.name, present: present.length, leave: leave.length, presentDays: present, leaveDays: leave };
    }) });
  }));
}
