// Custom survey forms: an admin builds a form (text, number, yes/no, choice, competitor price), reps fill it at an outlet.
// Responses can arrive later from the offline outbox, so they are deduped by clientRef.
import { bad } from "./catalog.js";
import { emit } from "./integrations/webhooks.js";
import { type Ctx, MGR, requireFeature } from "./common.js";

export const Q_TYPES = ["text", "number", "yesno", "select", "price"] as const;
type Q = { key: string; label: string; type: typeof Q_TYPES[number]; options?: string[]; brand?: string; required?: boolean };

export function cleanQuestions(raw: unknown): Q[] {
  if (!Array.isArray(raw) || !raw.length) throw bad("add at least one question");
  if (raw.length > 40) throw bad("keep it to 40 questions");
  const seen = new Set<string>();
  return raw.map((q: any, i) => {
    const label = String(q?.label ?? "").trim().slice(0, 160); if (!label) throw bad(`question ${i + 1} needs a label`);
    const type = Q_TYPES.includes(q.type) ? q.type : "text";
    let key = String(q.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `q${i + 1}`;
    while (seen.has(key)) key += "_"; seen.add(key);
    const out: Q = { key, label, type, required: !!q.required };
    if (type === "select") { out.options = (Array.isArray(q.options) ? q.options : String(q.options || "").split(",")).map((o: any) => String(o).trim().slice(0, 60)).filter(Boolean).slice(0, 20); if (!out.options!.length) throw bad(`"${label}" needs choices`); }
    if (type === "price") out.brand = String(q.brand || "").trim().slice(0, 80) || label;
    return out;
  });
}

function cleanAnswers(qs: Q[], raw: any) {
  const a: Record<string, unknown> = {};
  for (const q of qs) {
    const v = raw?.[q.key];
    if (v == null || v === "") { if (q.required) throw bad(`answer "${q.label}"`); continue; }
    if (q.type === "number" || q.type === "price") { const n = Number(v); if (!isFinite(n) || n < 0 || n > 1e9) throw bad(`"${q.label}" must be a number`); a[q.key] = Math.round(n * 100) / 100; }
    else if (q.type === "yesno") a[q.key] = v === true || v === "yes" || v === "true";
    else if (q.type === "select") { if (!q.options!.includes(String(v))) throw bad(`pick a choice for "${q.label}"`); a[q.key] = String(v); }
    else a[q.key] = String(v).slice(0, 500);
  }
  return a;
}

const form = (r: any) => ({ ...r, questions: JSON.parse(r.questions) });

export function registerSurveyRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const gate = async (req: any, res: any) => { const cid = tenant(req, res); if (cid == null) return null; await requireFeature(db, cid, "surveys"); return cid; };
  app.get("/api/surveys/forms", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const all = req.user.role !== "sales_rep" && req.query.all;
    res.json((await db.query(`SELECT * FROM survey_forms WHERE company_id=$1 ${all ? "" : "AND active"} ORDER BY id`, [cid])).rows.map(form));
  }));
  app.post("/api/surveys/forms", auth("company_admin"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const name = String(req.body?.name || "").trim().slice(0, 120); if (!name) throw bad("name the survey");
    res.status(201).json(form((await db.query("INSERT INTO survey_forms (company_id,name,questions) VALUES ($1,$2,$3) RETURNING *", [cid, name, JSON.stringify(cleanQuestions(req.body.questions))])).rows[0]));
  }));
  app.put("/api/surveys/forms/:id", auth("company_admin"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const f = (await db.query("SELECT * FROM survey_forms WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!f) throw bad("survey not found", 404);
    const b = req.body || {};
    const r = await db.query("UPDATE survey_forms SET name=$1, questions=$2, active=$3 WHERE id=$4 RETURNING *",
      [b.name ? String(b.name).trim().slice(0, 120) : f.name, b.questions ? JSON.stringify(cleanQuestions(b.questions)) : f.questions, b.active == null ? f.active : !!b.active, f.id]);
    res.json(form(r.rows[0]));
  }));
  app.post("/api/surveys/responses", auth("sales_rep", ...MGR), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const b = req.body || {}, ref = b.clientRef ? String(b.clientRef).slice(0, 64) : null;
    if (ref) { const d = (await db.query("SELECT id FROM survey_responses WHERE company_id=$1 AND client_ref=$2", [cid, ref])).rows[0]; if (d) return void res.json({ id: d.id, duplicate: true }); }
    const f = (await db.query("SELECT * FROM survey_forms WHERE id=$1 AND company_id=$2 AND active", [Number(b.formId), cid])).rows[0]; if (!f) throw bad("survey not found", 404);
    let shop: number | null = null;
    if (b.shopId) { if (!(await db.query("SELECT id FROM shops WHERE id=$1 AND company_id=$2", [Number(b.shopId), cid])).rows[0]) throw bad("outlet not found", 404); shop = Number(b.shopId); }
    const answers = cleanAnswers(JSON.parse(f.questions), b.answers);
    const r = (await db.query("INSERT INTO survey_responses (company_id,form_id,shop_id,user_id,answers,client_ref) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at",
      [cid, f.id, shop, req.user.uid, JSON.stringify(answers), ref])).rows[0];
    await emit(db, cid, "survey.submitted", { id: r.id, formId: f.id, shopId: shop, answers });
    res.status(201).json({ id: r.id, answers });
  }));
  app.get("/api/surveys/responses", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const args: unknown[] = [cid]; let w = "r.company_id=$1";
    if (req.query.formId) { args.push(Number(req.query.formId)); w += ` AND r.form_id=$${args.length}`; }
    if (req.user.role === "sales_rep") { args.push(req.user.uid); w += ` AND r.user_id=$${args.length}`; }
    res.json((await db.query(`SELECT r.*, f.name AS form_name, s.name AS shop_name, u.name AS user_name FROM survey_responses r JOIN survey_forms f ON f.id=r.form_id
      LEFT JOIN shops s ON s.id=r.shop_id LEFT JOIN users u ON u.id=r.user_id WHERE ${w} ORDER BY r.id DESC LIMIT 300`, args)).rows.map(r => ({ ...r, answers: JSON.parse(r.answers) })));
  }));
  // Competitor price report: every "price" question across responses, with min / average / max and how many outlets reported it.
  app.get("/api/surveys/competitor-prices", auth(...MGR), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const forms = new Map((await db.query("SELECT * FROM survey_forms WHERE company_id=$1", [cid])).rows.map(f => [f.id, JSON.parse(f.questions) as Q[]]));
    const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : "1970-01-01";
    const rows = (await db.query("SELECT form_id, shop_id, answers FROM survey_responses WHERE company_id=$1 AND created_at >= $2 ORDER BY id DESC LIMIT 5000", [cid, since])).rows;
    const agg = new Map<string, { brand: string; question: string; prices: number[]; shops: Set<number> }>();
    for (const r of rows) for (const q of forms.get(r.form_id) || []) {
      if (q.type !== "price") continue; const v = JSON.parse(r.answers)[q.key]; if (typeof v !== "number") continue;
      const k = `${q.brand}|${q.label}`; const e = agg.get(k) || { brand: q.brand!, question: q.label, prices: [], shops: new Set() };
      e.prices.push(v); if (r.shop_id) e.shops.add(r.shop_id); agg.set(k, e);
    }
    res.json([...agg.values()].map(e => ({ brand: e.brand, question: e.question, reports: e.prices.length, outlets: e.shops.size,
      min: Math.min(...e.prices), max: Math.max(...e.prices), avg: Math.round(e.prices.reduce((a, b) => a + b, 0) / e.prices.length * 100) / 100 })).sort((a, b) => a.brand.localeCompare(b.brand)));
  }));
}
