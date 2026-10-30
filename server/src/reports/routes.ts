// SPDX-License-Identifier: AGPL-3.0-only
// Custom reports API: builder catalogue, live preview, saved reports (share with roles, pin to dashboard),
// CSV/Excel export, JSON import/export of definitions, templates, and scheduled-delivery config.
import * as XLSX from "xlsx";
import type { Db } from "../db.js";
import { bad, parseJson } from "../catalog.js";
import { type Ctx, MGR } from "../common.js";
import { audit } from "../security.js";
import { catalog, runReport, validateDef, type RunResult } from "./engine.js";
import { TEMPLATES, templateDef } from "./templates.js";
import { SOURCES, type Source, type FieldType } from "./sources.js";
import { runSql, ensureWorkspaceTables } from "../workspace/service.js";

/** Report sources for this company: the built-in ones plus its saved SQL datasets ("ds:<id>"). */
export async function companySources(db: Db, cid: number, uid: number): Promise<Record<string, Source>> {
  await ensureWorkspaceTables(db);
  const out: Record<string, Source> = { ...SOURCES };
  for (const d of (await db.query("SELECT * FROM ws_datasets WHERE company_id=$1", [cid])).rows) {
    const cols = parseJson<{ key: string; type: string }[]>(d.columns, []);
    const fields: Source["fields"] = {};
    for (const c of cols) { const type = (["number", "date", "bool"].includes(c.type) ? c.type : "text") as FieldType;
      fields[c.key] = { label: c.key, type, get: r => type === "date" && r[c.key] ? String(r[c.key]).slice(0, 10) : type === "number" && r[c.key] != null ? Number(r[c.key]) : r[c.key] }; }
    const dateField = cols.find(c => c.type === "date")?.key;
    out[`ds:${d.id}`] = { label: `SQL: ${d.name}`, description: d.description || "Saved SQL dataset", sql: "", dateKind: dateField ? "text" : null, dateField, dims: {}, fields,
      load: async () => (await runSql(db, cid, d.sql, { uid, via: `report:ds:${d.id}` })).rows };
  }
  return out;
}

export const SHARE_ROLES = ["manager", "sales_rep", "distributor"] as const;
const FREQS = ["daily", "weekly", "monthly"] as const;
const ready = new WeakMap<Db, Promise<void>>();
/** Own table, created on first use so this module stays self-contained. */
export function ensureReportTables(db: Db) {
  if (ready.has(db)) return ready.get(db)!;
  const p = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS custom_reports (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, description TEXT, def TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]', pinned BOOLEAN NOT NULL DEFAULT FALSE, schedule TEXT, template_key TEXT, created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_run_at TIMESTAMPTZ, last_status TEXT)`);
    await db.query("CREATE INDEX IF NOT EXISTS custom_reports_company ON custom_reports (company_id, id)");
  })().catch(e => { ready.delete(db); throw e; });
  ready.set(db, p); return p;
}

export function cleanSchedule(s: any) {
  if (!s || !s.enabled) return null;
  const freq = FREQS.includes(s.freq) ? s.freq : "weekly";
  const emails = (Array.isArray(s.emails) ? s.emails : String(s.emails || "").split(/[,;\s]+/)).map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean);
  if (!emails.length) throw bad("Add at least one email for scheduled delivery");
  if (emails.length > 20) throw bad("At most 20 emails");
  for (const e of emails) if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw bad(`"${e.slice(0, 60)}" is not a valid email`);
  const hour = Math.max(0, Math.min(23, Math.floor(Number(s.hour ?? 8)) || 0));
  return { enabled: true, freq, hour, weekday: Math.max(0, Math.min(6, Math.floor(Number(s.weekday ?? 1)) || 0)), day: Math.max(1, Math.min(28, Math.floor(Number(s.day ?? 1)) || 1)),
    emails, format: s.format === "csv" ? "csv" : "xlsx" };
}
const cleanRoles = (r: unknown) => (Array.isArray(r) ? r : []).map(String).filter(x => (SHARE_ROLES as readonly string[]).includes(x)).filter((x, i, a) => a.indexOf(x) === i);
const out = (r: any) => ({ id: r.id, name: r.name, description: r.description || "", def: parseJson(r.def, {}), roles: parseJson(r.roles, []), pinned: !!r.pinned,
  schedule: parseJson(r.schedule, null), templateKey: r.template_key, createdAt: r.created_at, updatedAt: r.updated_at, lastRunAt: r.last_run_at, lastStatus: r.last_status });

/** Turn a result into a CSV or Excel file (headers are the column labels). */
export function toFile(res: RunResult, name: string, format: string) {
  const data = res.rows.map(r => Object.fromEntries(res.columns.map(c => [c.label, r[c.key] ?? ""])));
  const ws = XLSX.utils.json_to_sheet(data.length ? data : [{ Note: "No rows for this period" }], { header: data.length ? res.columns.map(c => c.label) : undefined });
  const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report";
  const file = `${safe}${res.range ? `-${res.range.from}-to-${res.range.to}` : ""}`;
  if (format === "csv") return { file: `${file}.csv`, mime: "text/csv", body: Buffer.from("\ufeff" + XLSX.utils.sheet_to_csv(ws)) };
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Report");
  return { file: `${file}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
}

// Simple per-user rate limit for running reports (protects the database from a stuck refresh loop).
const hits = new Map<number, number[]>();
const RUNS_PER_MIN = Number(process.env.REPORT_RUNS_PER_MIN || 60);
function throttle(uid: number) {
  const now = Date.now(), h = (hits.get(uid) || []).filter(t => now - t < 60000);
  if (h.length >= RUNS_PER_MIN) throw bad("Too many report runs. Please wait a minute.", 429);
  h.push(now); hits.set(uid, h); if (hits.size > 5000) hits.clear();
}

export function registerCustomReportRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const viewer = auth("company_admin", "manager", "sales_rep", "distributor");
  const ctx = async (req: any, res: any) => { const cid = tenant(req, res); if (cid == null) return null; await ensureReportTables(db); return cid; };
  const force = (req: any) => req.user.role === "sales_rep" ? { rep: [req.user.uid] } : req.user.role === "distributor" ? { distributor: [req.user.uid] } : {};
  const canSee = (req: any, r: any) => MGR.includes(req.user.role) || parseJson<string[]>(r.roles, []).includes(req.user.role);
  const get = async (req: any, cid: number) => {
    const r = (await db.query("SELECT * FROM custom_reports WHERE id=$1 AND company_id=$2", [Number(req.params.id) || 0, cid])).rows[0];
    if (!r || !canSee(req, r)) throw bad("Report not found", 404); return r;
  };
  const override = (def: any, q: any) => q.preset ? { ...def, filters: { ...def.filters, dateRange: { preset: String(q.preset), from: q.from, to: q.to } } } : def;

  app.get("/api/report-builder/catalog", auth(...MGR), wrap(async (_req, _res) => { const res = _res;
    const cid = tenant(_req, _res); if (cid == null) return; const srcs = await companySources(db, cid, _req.user.uid);
    const cat = catalog(); cat.sources.push(...Object.entries(srcs).filter(([k]) => k.startsWith("ds:")).map(([key, s]) => ({ key, label: s.label, description: s.description, hasDate: !!s.dateField, maxDays: null, dims: [], fields: Object.entries(s.fields).map(([k, f]) => ({ key: k, label: f.label, type: f.type })) })));
    res.json({ ...cat, templates: TEMPLATES.map(t => ({ key: t.key, name: t.name, description: t.description, def: templateDef(t) })), shareRoles: SHARE_ROLES, smtp: !!process.env.SMTP_HOST });
  }));
  app.post("/api/report-builder/preview", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; throttle(req.user.uid);
    res.json(await runReport(db, cid, req.body?.def, { sources: await companySources(db, cid, req.user.uid), limit: 500 }));
  }));
  app.post("/api/report-builder/export", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; throttle(req.user.uid);
    const f = toFile(await runReport(db, cid, req.body?.def, { sources: await companySources(db, cid, req.user.uid) }), String(req.body?.name || "report"), String(req.query.format || "xlsx"));
    res.type(f.mime).attachment(f.file).send(f.body);
  }));

  app.get("/api/custom-reports", viewer, wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    res.json((await db.query("SELECT * FROM custom_reports WHERE company_id=$1 ORDER BY pinned DESC, name", [cid])).rows.filter(r => canSee(req, r)).map(out));
  }));
  const save = async (req: any, cid: number, body: any, id?: number) => {
    const name = String(body?.name || "").trim().slice(0, 80); if (!name) throw bad("Give the report a name");
    const def = validateDef(body.def, await companySources(db, cid, req.user.uid));
    const vals = [name, String(body.description || "").slice(0, 300) || null, JSON.stringify(def), JSON.stringify(cleanRoles(body.roles)), !!body.pinned, JSON.stringify(cleanSchedule(body.schedule))];
    if (id) return (await db.query("UPDATE custom_reports SET name=$1,description=$2,def=$3,roles=$4,pinned=$5,schedule=$6,updated_at=NOW() WHERE id=$7 AND company_id=$8 RETURNING *", [...vals, id, cid])).rows[0];
    const n = (await db.query("SELECT COUNT(*) AS n FROM custom_reports WHERE company_id=$1", [cid])).rows[0].n;
    if (Number(n) >= 200) throw bad("This company already has 200 reports. Delete some first.", 409);
    return (await db.query("INSERT INTO custom_reports (company_id,name,description,def,roles,pinned,schedule,template_key,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [cid, ...vals, body.templateKey ? String(body.templateKey).slice(0, 40) : null, req.user.uid])).rows[0];
  };
  app.post("/api/custom-reports", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    const r = await save(req, cid, req.body); await audit(db, { companyId: cid, userId: req.user.uid, action: "report.create", target: r.name, ip: req.ip });
    res.status(201).json(out(r));
  }));
  app.post("/api/custom-reports/import", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    const list = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.reports) ? req.body.reports : [req.body];
    if (list.length > 50) throw bad("Import at most 50 reports at a time");
    const made = []; for (const b of list) made.push(out(await save(req, cid, { ...b, pinned: false, schedule: null })));
    await audit(db, { companyId: cid, userId: req.user.uid, action: "report.import", detail: { n: made.length }, ip: req.ip });
    res.status(201).json(made);
  }));
  app.post("/api/custom-reports/from-template/:key", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    const t = TEMPLATES.find(x => x.key === req.params.key); if (!t) throw bad("Template not found", 404);
    res.status(201).json(out(await save(req, cid, { name: String(req.body?.name || t.name), description: t.description, def: templateDef(t), roles: [], templateKey: t.key })));
  }));
  app.get("/api/custom-reports/export", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    const rows = (await db.query("SELECT * FROM custom_reports WHERE company_id=$1 ORDER BY id", [cid])).rows.map(out).map(r => ({ name: r.name, description: r.description, def: r.def, roles: r.roles }));
    res.attachment("ownfield-reports.json").json({ format: "ownfield-reports", version: 1, reports: rows });
  }));
  app.get("/api/custom-reports/pinned", viewer, wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return;
    const list = (await db.query("SELECT * FROM custom_reports WHERE company_id=$1 AND pinned=TRUE ORDER BY name", [cid])).rows.filter(r => canSee(req, r)).slice(0, 8);
    const outp = [];
    for (const r of list) { try { outp.push({ ...out(r), result: await runReport(db, cid, parseJson(r.def, {}), { sources: await companySources(db, cid, req.user.uid), force: force(req), limit: 50 }) }); } catch (e: any) { outp.push({ ...out(r), error: e.message }); } }
    res.json(outp);
  }));
  app.get("/api/custom-reports/:id", viewer, wrap(async (req, res) => { const cid = await ctx(req, res); if (cid == null) return; res.json(out(await get(req, cid))); }));
  app.get("/api/custom-reports/:id/json", viewer, wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; const r = out(await get(req, cid));
    res.attachment(`report-${r.id}.json`).json({ format: "ownfield-reports", version: 1, reports: [{ name: r.name, description: r.description, def: r.def, roles: r.roles }] });
  }));
  app.put("/api/custom-reports/:id", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; await get(req, cid);
    res.json(out(await save(req, cid, req.body, Number(req.params.id))));
  }));
  app.patch("/api/custom-reports/:id/pin", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; await get(req, cid);
    res.json(out((await db.query("UPDATE custom_reports SET pinned=$1 WHERE id=$2 AND company_id=$3 RETURNING *", [!!req.body?.pinned, Number(req.params.id), cid])).rows[0]));
  }));
  app.delete("/api/custom-reports/:id", auth(...MGR), wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; const r = await get(req, cid);
    await db.query("DELETE FROM custom_reports WHERE id=$1 AND company_id=$2", [r.id, cid]);
    await audit(db, { companyId: cid, userId: req.user.uid, action: "report.delete", target: r.name, ip: req.ip });
    res.json({ ok: true });
  }));
  app.get("/api/custom-reports/:id/run", viewer, wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; throttle(req.user.uid); const r = await get(req, cid);
    res.json(await runReport(db, cid, override(parseJson(r.def, {}), req.query), { sources: await companySources(db, cid, req.user.uid), force: force(req), limit: 1000 }));
  }));
  app.get("/api/custom-reports/:id/export", viewer, wrap(async (req, res) => {
    const cid = await ctx(req, res); if (cid == null) return; throttle(req.user.uid); const r = await get(req, cid);
    const f = toFile(await runReport(db, cid, override(parseJson(r.def, {}), req.query), { sources: await companySources(db, cid, req.user.uid), force: force(req) }), r.name, String(req.query.format || "xlsx"));
    res.type(f.mime).attachment(f.file).send(f.body);
  }));
}
