// Phase 3.2: expense claims — rep submits amount, category and receipt photo; manager approves or rejects; monthly report.
import { bad, today } from "./catalog.js";
import { type Ctx, MGR, requireFeature, monthOk, dateOk } from "./common.js";
import { smallUpload, savePhoto, readPhoto } from "./photos.js";

export const EXPENSE_CATEGORIES = ["Travel", "Fuel", "Food", "Stay", "Phone", "Other"];

export function registerExpenseRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/expenses/categories", auth(...MGR, "sales_rep"), (_q: any, res: any) => res.json(EXPENSE_CATEGORIES));
  app.post("/api/expenses", auth("sales_rep"), smallUpload.single("receipt"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "expenses");
    const b = req.body || {};
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!(amount > 0) || amount > 1e6) throw bad("enter the amount you spent");
    const category = EXPENSE_CATEGORIES.find(c => c.toLowerCase() === String(b.category || "").toLowerCase());
    if (!category) throw bad(`pick a category: ${EXPENSE_CATEGORIES.join(", ")}`);
    const spentOn = b.spentOn ? String(b.spentOn) : today();
    if (!dateOk(spentOn) || spentOn > today()) throw bad("date can't be in the future");
    const p = savePhoto(cid, req.file, true)!; // receipt photo required
    res.status(201).json((await db.query(`INSERT INTO expenses (company_id,rep_id,spent_on,amount,category,note,receipt_file,receipt_mime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id,rep_id,spent_on,amount,category,note,status,created_at`, [cid, req.user.uid, spentOn, amount, category, String(b.note || "").slice(0, 300) || null, p.file, p.mime])).rows[0]);
  }));
  app.get("/api/expenses", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "expenses");
    const rep = req.user.role === "sales_rep", p: unknown[] = [cid]; let w = "";
    if (rep) { p.push(req.user.uid); w += ` AND e.rep_id=$${p.length}`; }
    if (req.query.status) { p.push(String(req.query.status)); w += ` AND e.status=$${p.length}`; }
    if (monthOk(req.query.month)) { p.push(`${req.query.month}%`); w += ` AND e.spent_on LIKE $${p.length}`; }
    res.json((await db.query(`SELECT e.id,e.rep_id,u.name AS rep_name,e.spent_on,e.amount,e.category,e.note,e.status,e.reason,e.decided_at FROM expenses e JOIN users u ON u.id=e.rep_id
      WHERE e.company_id=$1${w} ORDER BY e.id DESC`, p)).rows.map(r => ({ ...r, amount: Number(r.amount) })));
  }));
  app.post("/api/expenses/:id/decision", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "expenses");
    const to = String(req.body?.status || ""); if (!["approved", "rejected"].includes(to)) throw bad("status must be approved or rejected");
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    if (to === "rejected" && !reason) throw bad("tell the rep why it was rejected");
    const r = await db.query("UPDATE expenses SET status=$1, reason=$2, decided_by=$3, decided_at=NOW() WHERE id=$4 AND company_id=$5 AND status='pending' RETURNING id,status,reason",
      [to, reason || null, req.user.uid, Number(req.params.id), cid]);
    if (!r.rows[0]) throw bad("pending claim not found", 404);
    res.json(r.rows[0]);
  }));
  app.get("/api/expenses/:id/receipt", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rep = req.user.role === "sales_rep";
    const e = (await db.query(`SELECT receipt_file, receipt_mime FROM expenses WHERE id=$1 AND company_id=$2 ${rep ? "AND rep_id=$3" : ""}`, rep ? [Number(req.params.id), cid, req.user.uid] : [Number(req.params.id), cid])).rows[0];
    if (!e) throw bad("claim not found", 404);
    if (!e.receipt_file) throw bad("no bill photo for this sample claim", 404);
    res.type(e.receipt_mime).set("Cache-Control", "private, max-age=86400").send(readPhoto(e.receipt_file));
  }));
  // Monthly report: per rep, approved / pending / rejected totals and approved amount by category.
  app.get("/api/expenses/report", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "expenses");
    const month = monthOk(req.query.month) ? String(req.query.month) : today().slice(0, 7);
    const rep = req.user.role === "sales_rep";
    const rows = (await db.query(`SELECT e.rep_id, u.name, e.amount, e.category, e.status FROM expenses e JOIN users u ON u.id=e.rep_id WHERE e.company_id=$1 AND e.spent_on LIKE $2 ${rep ? "AND e.rep_id=$3" : ""}`,
      rep ? [cid, `${month}%`, req.user.uid] : [cid, `${month}%`])).rows;
    const m = new Map<number, any>(); const r2 = (n: number) => Math.round(n * 100) / 100;
    for (const e of rows) {
      if (!m.has(e.rep_id)) m.set(e.rep_id, { repId: e.rep_id, rep: e.name, approved: 0, pending: 0, rejected: 0, byCategory: {} as Record<string, number> });
      const x = m.get(e.rep_id), a = Number(e.amount); x[e.status] = r2(x[e.status] + a);
      if (e.status === "approved") x.byCategory[e.category] = r2((x.byCategory[e.category] || 0) + a);
    }
    const reps = [...m.values()].sort((a, b) => a.rep.localeCompare(b.rep));
    res.json({ month, reps, total: { approved: r2(reps.reduce((a, r) => a + r.approved, 0)), pending: r2(reps.reduce((a, r) => a + r.pending, 0)) } });
  }));
}
