// Phase 3.1: store audits — admin-defined checklist templates answered during a visit, shelf photos, manager report.
import { bad, today } from "./catalog.js";
import { dayKey } from "./field.js";
import { type Ctx, MGR, requireFeature, dateOk } from "./common.js";
import { smallUpload, savePhoto, readPhoto } from "./photos.js";

export const Q_TYPES = ["yes_no", "number", "text", "photo"] as const;
type Q = { key: string; label: string; type: (typeof Q_TYPES)[number]; required?: boolean; target?: number; weight?: number };
/** Perfect store: each yes/no question scores 1 for "yes"; a number question with a target scores value/target (max 1). Weighted average, 0–100. */
export function perfectScore(qs: Q[], ans: Record<string, any>) {
  let got = 0, max = 0;
  for (const q of qs) {
    const w = q.weight ?? 1;
    if (q.type === "yes_no" && q.key in ans) { max += w; got += ans[q.key] ? w : 0; }
    else if (q.type === "number" && q.target && q.key in ans) { max += w; got += w * Math.min(Math.max(Number(ans[q.key]) / q.target, 0), 1); }
  }
  return max ? Math.round((got / max) * 100) : null;
}
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export function cleanQuestions(input: unknown): Q[] {
  if (!Array.isArray(input) || !input.length) throw bad("add at least one question");
  if (input.length > 30) throw bad("up to 30 questions");
  const out = input.map((q: any) => {
    const label = String(q?.label || "").trim().slice(0, 120); const type = String(q?.type || "yes_no");
    if (!label) throw bad("each question needs a label");
    if (!(Q_TYPES as readonly string[]).includes(type)) throw bad(`question type must be ${Q_TYPES.join("/")}`);
    const o: Q = { key: keyOf(q.key || label), label, type: type as Q["type"], required: !!q.required };
    if (q.target != null && q.target !== "") { const tg = Number(q.target); if (type !== "number" || !(tg > 0)) throw bad("a target can only be set on number questions, and must be more than 0"); o.target = tg; }
    if (q.weight != null && q.weight !== "") { const w = Number(q.weight); if (!(w > 0 && w <= 10)) throw bad("weight must be between 0 and 10"); if (w !== 1) o.weight = w; }
    return o;
  });
  if (new Set(out.map(q => q.key)).size !== out.length) throw bad("question labels must be different");
  return out;
}
/** Check answers against the template (photo questions are answered by uploading photos). */
export function cleanAnswers(qs: Q[], a: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const q of qs) {
    if (q.type === "photo") continue;
    const v = a?.[q.key];
    if (v == null || v === "") { if (q.required) throw bad(`answer "${q.label}"`); continue; }
    if (q.type === "yes_no") { if (![true, false, "yes", "no"].includes(v as any)) throw bad(`"${q.label}" must be yes or no`); out[q.key] = v === true || v === "yes"; }
    else if (q.type === "number") { const n = Number(v); if (!Number.isFinite(n)) throw bad(`"${q.label}" must be a number`); out[q.key] = n; }
    else out[q.key] = String(v).trim().slice(0, 500);
  }
  return out;
}

export function registerAuditRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const tpl = async (cid: number, id: unknown) => (await db.query("SELECT * FROM audit_templates WHERE id=$1 AND company_id=$2", [Number(id), cid])).rows[0];
  const shape = (t: any) => ({ ...t, questions: JSON.parse(t.questions) });

  app.get("/api/audit-templates", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const all = req.user.role !== "sales_rep" && req.query.all;
    res.json((await db.query(`SELECT * FROM audit_templates WHERE company_id=$1 ${all ? "" : "AND active=TRUE"} ORDER BY id`, [cid])).rows.map(shape));
  }));
  app.post("/api/audit-templates", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const name = String(req.body?.name || "").trim().slice(0, 80); if (!name) throw bad("give the checklist a name");
    res.status(201).json(shape((await db.query("INSERT INTO audit_templates (company_id,name,questions) VALUES ($1,$2,$3) RETURNING *", [cid, name, JSON.stringify(cleanQuestions(req.body?.questions))])).rows[0]));
  }));
  app.put("/api/audit-templates/:id", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const t = await tpl(cid, req.params.id); if (!t) throw bad("checklist not found", 404);
    const b = req.body || {};
    const r = await db.query("UPDATE audit_templates SET name=$1, questions=$2, active=$3 WHERE id=$4 RETURNING *",
      [String(b.name ?? t.name).trim() || t.name, b.questions ? JSON.stringify(cleanQuestions(b.questions)) : t.questions, b.active == null ? t.active : !!b.active, t.id]);
    res.json(shape(r.rows[0]));
  }));

  // Rep fills a checklist during a visit (today's visits only).
  app.post("/api/visits/:id/audits", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const v = (await db.query("SELECT * FROM visits WHERE id=$1 AND company_id=$2 AND rep_id=$3", [Number(req.params.id), cid, req.user.uid])).rows[0];
    if (!v) throw bad("visit not found", 404);
    if (dayKey(v.check_in_at) !== today()) throw bad("audits can only be filled for today's visits", 409);
    const t = await tpl(cid, req.body?.templateId); if (!t || !t.active) throw bad("checklist not found", 404);
    const answers = cleanAnswers(JSON.parse(t.questions), req.body?.answers || {});
    const ex = (await db.query("SELECT id FROM audits WHERE visit_id=$1 AND template_id=$2", [v.id, t.id])).rows[0];
    const r = ex ? await db.query("UPDATE audits SET answers=$1 WHERE id=$2 RETURNING *", [JSON.stringify(answers), ex.id])
      : await db.query("INSERT INTO audits (company_id,visit_id,template_id,rep_id,shop_id,answers) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [cid, v.id, t.id, req.user.uid, v.shop_id, JSON.stringify(answers)]);
    res.status(ex ? 200 : 201).json({ ...r.rows[0], answers });
  }));
  // Shelf / photo answers. Photos are compressed on the phone; server accepts small images only.
  app.post("/api/audits/:id/photos", auth("sales_rep"), smallUpload.single("photo"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const a = (await db.query("SELECT a.*, t.questions FROM audits a JOIN audit_templates t ON t.id=a.template_id WHERE a.id=$1 AND a.company_id=$2 AND a.rep_id=$3", [Number(req.params.id), cid, req.user.uid])).rows[0];
    if (!a) throw bad("audit not found", 404);
    if (dayKey(a.created_at) !== today()) throw bad("photos can only be added on the day of the audit", 409);
    const qk = String(req.body?.question || "shelf");
    const qs = JSON.parse(a.questions) as Q[];
    if (qk !== "shelf" && !qs.some(q => q.key === qk && q.type === "photo")) throw bad("not a photo question");
    const n = Number((await db.query("SELECT COUNT(*) AS n FROM audit_photos WHERE audit_id=$1", [a.id])).rows[0].n);
    if (n >= 6) throw bad("max 6 photos per audit", 409);
    const p = (await savePhoto(cid, req.file))!;
    res.status(201).json((await db.query("INSERT INTO audit_photos (company_id,audit_id,question,file,mime,size) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,audit_id,question,mime,size",
      [cid, a.id, qk, p.file, p.mime, p.size])).rows[0]);
  }));
  app.get("/api/audit-photos/:id", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rep = req.user.role === "sales_rep";
    const p = (await db.query(`SELECT p.* FROM audit_photos p JOIN audits a ON a.id=p.audit_id WHERE p.id=$1 AND p.company_id=$2 ${rep ? "AND a.rep_id=$3" : ""}`,
      rep ? [Number(req.params.id), cid, req.user.uid] : [Number(req.params.id), cid])).rows[0];
    if (!p) throw bad("photo not found", 404);
    res.type(p.mime).set("Cache-Control", "private, max-age=86400").send(await readPhoto(p.file));
  }));
  // Manager report: one row per audit with plain-language answers and photo ids.
  app.get("/api/audits", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "audits");
    const to = dateOk(req.query.to) ? String(req.query.to) : today(), from = dateOk(req.query.from) ? String(req.query.from) : `${to.slice(0, 8)}01`;
    const rep = req.user.role === "sales_rep";
    const rows = (await db.query(`SELECT a.*, t.name AS checklist, t.questions, s.name AS shop_name, u.name AS rep_name FROM audits a JOIN audit_templates t ON t.id=a.template_id
      JOIN shops s ON s.id=a.shop_id JOIN users u ON u.id=a.rep_id WHERE a.company_id=$1 ${rep ? "AND a.rep_id=$2" : ""} ORDER BY a.id DESC`, rep ? [cid, req.user.uid] : [cid])).rows
      .filter(r => { const d = dayKey(r.created_at); return d >= from && d <= to; });
    const out = [];
    for (const r of rows) {
      const qs = JSON.parse(r.questions) as Q[], ans = JSON.parse(r.answers);
      const photos = (await db.query("SELECT id, question FROM audit_photos WHERE audit_id=$1 ORDER BY id", [r.id])).rows;
      const yn = qs.filter(q => q.type === "yes_no" && q.key in ans);
      out.push({ id: r.id, visit_id: r.visit_id, day: dayKey(r.created_at), rep_name: r.rep_name, shop_name: r.shop_name, checklist: r.checklist,
        score: yn.length ? `${yn.filter(q => ans[q.key]).length}/${yn.length} yes` : "", perfect_score: perfectScore(qs, ans), shop_id: r.shop_id,
        answers: qs.filter(q => q.type !== "photo").map(q => ({ label: q.label, value: q.key in ans ? (q.type === "yes_no" ? (ans[q.key] ? "Yes" : "No") : ans[q.key]) : "" })),
        photos });
    }
    // Outlet score = the latest audit's perfect-store score for each outlet in the period (average across checklists done that day).
    const latest = new Map<number, { day: string; scores: number[]; shop_name: string }>();
    for (const r of out) { if (r.perfect_score == null) continue; const c = latest.get(r.shop_id); if (!c || r.day > c.day) latest.set(r.shop_id, { day: r.day, scores: [r.perfect_score], shop_name: r.shop_name }); else if (r.day === c.day) c.scores.push(r.perfect_score); }
    const outlets = [...latest.entries()].map(([shop_id, c]) => ({ shop_id, shop_name: c.shop_name, day: c.day, outlet_score: Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length) })).sort((a, b) => a.outlet_score - b.outlet_score);
    res.json({ from, to, rows: out, outlets });
  }));
}
