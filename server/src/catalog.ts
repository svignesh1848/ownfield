// Step 3: industry templates, company settings & feature toggles, configurable catalogue (items + variants + units),
// custom fields, stock with batch/expiry (FEFO), schemes, and attribute-aware Excel/CSV import.
import type { Express, Response, Request, NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import type { Db } from "./db.js";
import { TEMPLATES, INDUSTRIES, FEATURE_KEYS, FIELD_TYPES, ENTITIES, templateSettings, withDefaults, type Settings, type CustomField, type Uom } from "./templates.js";

export const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
export const norm = (k: unknown) => String(k ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
export const parseJson = <T>(v: unknown, d: T): T => {
  if (v == null || v === "") return d;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return d; } }
  return v as T;
};
const empty = (v: unknown) => v == null || String(v).trim() === "";
export const today = (tz = process.env.REPORT_TZ || "Asia/Kolkata") => new Date().toLocaleDateString("en-CA", { timeZone: tz });

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw bad(`invalid date ${y}-${m}-${d}`);
  return dt.toISOString().slice(0, 10);
};
/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, MM/YYYY (→ last day of month, common for expiry) and Excel serial dates. */
export function parseDate(v: unknown): string | null {
  if (empty(v)) return null;
  if (typeof v === "number") { if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); throw bad(`invalid date ${v}`); }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) return iso(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[/-](\d{4})$/); if (m) return iso(+m[2], +m[1], new Date(Date.UTC(+m[2], +m[1], 0)).getUTCDate());
  throw bad(`invalid date "${s}" (use YYYY-MM-DD or DD/MM/YYYY)`);
}

/** "PCS=1|BOX=12|CASE=144" → [{code,factor}] ; must include a base unit (factor 1). */
export function parseUnits(v: unknown): Uom[] {
  const list = Array.isArray(v) ? v : String(v).split(/[|;,]/).map(p => p.trim()).filter(Boolean).map(p => {
    const [code, f] = p.split("="); return { code, factor: f == null ? 1 : Number(f) };
  });
  const out = list.map((u: any) => ({ code: String(u.code || "").trim().toUpperCase(), factor: Number(u.factor) }));
  for (const u of out) if (!/^[A-Z0-9_]{1,12}$/.test(u.code) || !Number.isInteger(u.factor) || u.factor < 1) throw bad(`invalid unit ${u.code}=${u.factor}`);
  if (new Set(out.map(u => u.code)).size !== out.length) throw bad("duplicate unit code");
  if (out.filter(u => u.factor === 1).length !== 1) throw bad("units need exactly one base unit with factor 1");
  return out.sort((a, b) => a.factor - b.factor);
}

export function cleanCustom(defs: CustomField[], input: Record<string, unknown>, enforceRequired = true) {
  const out: Record<string, string | number> = {};
  for (const d of defs) {
    const v = input[d.key] ?? input[norm(d.label)];
    if (empty(v)) { if (d.required && enforceRequired) throw bad(`${d.label} is required`); continue; }
    if (d.type === "number") { const n = Number(v); if (!Number.isFinite(n)) throw bad(`${d.label} must be a number`); out[d.key] = n; }
    else if (d.type === "date") out[d.key] = parseDate(v)!;
    else if (d.type === "select") {
      const hit = (d.options || []).find(o => o.toLowerCase() === String(v).trim().toLowerCase());
      if (!hit) throw bad(`${d.label} must be one of ${(d.options || []).join(", ")}`); out[d.key] = hit;
    } else out[d.key] = String(v).trim().slice(0, 500);
  }
  return out;
}

export function validateSettings(input: any, base: Settings): Settings {
  const s: Settings = JSON.parse(JSON.stringify(base));
  if (input.features) for (const k of FEATURE_KEYS) if (k in input.features) s.features[k] = !!input.features[k];
  if (input.attributes) {
    const a = (Array.isArray(input.attributes) ? input.attributes : String(input.attributes).split(",")).map(norm).filter(Boolean);
    if (a.length > 4 || new Set(a).size !== a.length) throw bad("up to 4 distinct attributes");
    s.attributes = a;
  }
  if (input.uoms) s.uoms = parseUnits(input.uoms);
  if (input.customFields) for (const e of ENTITIES) if (input.customFields[e]) {
    s.customFields[e] = (input.customFields[e] as any[]).map(f => {
      const type = String(f.type || "text"); const label = String(f.label || f.key || "").trim(); const key = norm(f.key || label);
      if (!key || !label) throw bad("custom field needs a label");
      if (!(FIELD_TYPES as readonly string[]).includes(type)) throw bad(`custom field type must be ${FIELD_TYPES.join("/")}`);
      const options = type === "select" ? (Array.isArray(f.options) ? f.options : String(f.options || "").split(",")).map((o: unknown) => String(o).trim()).filter(Boolean) : undefined;
      if (type === "select" && !options?.length) throw bad(`select field ${label} needs options`);
      return { key, label, type, ...(options ? { options } : {}), required: !!f.required } as CustomField;
    });
    if (new Set(s.customFields[e].map(f => f.key)).size !== s.customFields[e].length) throw bad(`duplicate ${e} custom field`);
  }
  if (input.gst) {
    const g = { ...s.gst, ...input.gst };
    g.gstin = String(g.gstin || "").toUpperCase().trim(); g.stateCode = String(g.stateCode || "").trim();
    if (g.gstin && !/^\d{2}[A-Z0-9]{13}$/.test(g.gstin)) throw bad("GSTIN must be 15 characters starting with the 2-digit state code");
    if (g.stateCode && !/^\d{2}$/.test(g.stateCode)) throw bad("state code must be 2 digits");
    if (g.gstin && g.stateCode && g.gstin.slice(0, 2) !== g.stateCode) throw bad("GSTIN does not match state code");
    const rate = (r: unknown) => { const n = Number(r); if (!(n >= 0 && n <= 100)) throw bad(`invalid GST rate ${r}`); return n; };
    g.defaultRate = rate(g.defaultRate);
    g.hsnRates = (Array.isArray(g.hsnRates) ? g.hsnRates : String(g.hsnRates || "").split(",").map(p => p.trim()).filter(Boolean).map(p => { const [prefix, r] = p.split("="); return { prefix, rate: r }; }))
      .map((h: any) => { const prefix = String(h.prefix).trim(); if (!/^\d{2,8}$/.test(prefix)) throw bad(`invalid HSN/SAC prefix ${prefix}`); return { prefix, rate: rate(h.rate) }; });
    if (!String(g.numberFormat).includes("{seq")) throw bad("number format must contain {seq}");
    for (const k of ["invoicePrefix", "creditPrefix"] as const) if (!/^[A-Z0-9-]{1,6}$/i.test(String(g[k]))) throw bad(`${k} must be 1–6 letters/digits`);
    s.gst = g;
  }
  return s;
}

export async function getCompany(db: Db, cid: number) {
  const c = (await db.query("SELECT industry, settings FROM companies WHERE id=$1", [cid])).rows[0];
  if (!c) throw bad("company not found", 404);
  return { industry: c.industry as string, settings: withDefaults(c.industry, parseJson<Partial<Settings>>(c.settings, {})) };
}

/** Sellable stock rows at a location in FEFO order (earliest expiry first, expired excluded). */
export async function fefoRows(db: Db, cid: number, loc: number | null, variantId: number) {
  const rows = (await db.query(`SELECT * FROM stock WHERE company_id=$1 AND variant_id=$2 AND qty>0 AND ${loc == null ? "distributor_id IS NULL" : "distributor_id=$3"}`,
    loc == null ? [cid, variantId] : [cid, variantId, loc])).rows;
  const t = today();
  return rows.filter(r => !r.expiry || r.expiry >= t).map(r => ({ ...r, qty: Number(r.qty) }))
    .sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.id - b.id);
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void;
  addUser: (cid: number, u: any) => Promise<any>; companyUsage: (cid: number) => Promise<any> };
type Imp = { db: Db; cid: number; s: Settings; role: string; uid: number; addUser: Ctx["addUser"] };

async function importShop({ db, cid, s }: Imp, r: any) {
  if (empty(r.code) || empty(r.name)) throw bad("code and name required");
  const custom = JSON.stringify(cleanCustom(s.customFields.outlet, r));
  const dl = s.features.drugLicence ? String(r.drug_licence ?? r.drug_licence_no ?? r.dl_no ?? "").trim() || null : null;
  let dist: number | null = null;
  if (!empty(r.distributor_email)) {
    dist = (await db.query("SELECT id FROM users WHERE company_id=$1 AND email=$2 AND role='distributor'", [cid, String(r.distributor_email).toLowerCase().trim()])).rows[0]?.id;
    if (!dist) throw bad(`distributor ${r.distributor_email} not found`);
  }
  const gstin = String(r.gstin ?? "").toUpperCase().trim() || null;
  if (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin)) throw bad("invalid GSTIN");
  const state = String(r.state_code ?? "").trim().padStart(empty(r.state_code) ? 0 : 2, "0") || gstin?.slice(0, 2) || null;
  if (state && !/^\d{2}$/.test(state)) throw bad("state code must be 2 digits");
  const vals = [String(r.name), r.owner_name || null, String(r.phone || "") || null, r.address || null, r.city || null, gstin, dl, custom, state];
  const ex = (await db.query("SELECT id, distributor_id FROM shops WHERE company_id=$1 AND code=$2", [cid, String(r.code)])).rows[0];
  if (ex) {
    await db.query("UPDATE shops SET name=$1,owner_name=$2,phone=$3,address=$4,city=$5,gstin=$6,drug_licence=$7,custom=$8,state_code=$9,distributor_id=$10 WHERE id=$11", [...vals, dist ?? ex.distributor_id, ex.id]);
    return "updated";
  }
  await db.query("INSERT INTO shops (name,owner_name,phone,address,city,gstin,drug_licence,custom,state_code,distributor_id,company_id,code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [...vals, dist, cid, String(r.code)]);
  return "inserted";
}

async function importProduct({ db, cid, s }: Imp, r: any) {
  const code = String(r.item_code ?? r.style ?? r.product_code ?? "").trim(), sku = String(r.sku ?? "").trim();
  if (!code || !sku) throw bad("item code (or style) and sku required");
  const kind = /serv|amc|visit|non/.test(String(r.type ?? r.kind ?? "").toLowerCase()) ? "service" : "goods";
  if (kind === "service" && !s.features.services) throw bad("service items are disabled (turn on the Services feature)");
  const bp = Number(r.billing_price), mrp = empty(r.mrp) && kind === "service" ? bp : Number(r.mrp);
  if (!(mrp > 0) || !(bp > 0)) throw bad("mrp and billing_price must be positive numbers");
  if (bp > mrp) throw bad("billing_price cannot exceed mrp");
  const attrs: Record<string, string> = {};
  for (const a of s.attributes) if (!empty(r[a])) attrs[a] = String(r[a]).trim();
  const uoms = JSON.stringify(empty(r.units) ? s.uoms : parseUnits(r.units));
  const custom = JSON.stringify(cleanCustom(s.customFields.product, r));
  const name = String(r.item_name ?? r.product_name ?? r.name ?? code).trim() || code;
  let item = (await db.query("SELECT id FROM items WHERE company_id=$1 AND code=$2", [cid, code])).rows[0];
  if (item) await db.query("UPDATE items SET name=$1,category=$2,kind=$3,hsn=$4,uoms=$5,custom=$6 WHERE id=$7", [name, r.category || null, kind, String(r.hsn ?? "") || null, uoms, custom, item.id]);
  else item = (await db.query("INSERT INTO items (company_id,code,name,category,kind,hsn,uoms,custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [cid, code, name, r.category || null, kind, String(r.hsn ?? "") || null, uoms, custom])).rows[0];
  const v = (await db.query("SELECT id FROM variants WHERE company_id=$1 AND sku=$2", [cid, sku])).rows[0];
  if (v) { await db.query("UPDATE variants SET item_id=$1,attrs=$2,mrp=$3,billing_price=$4 WHERE id=$5", [item.id, JSON.stringify(attrs), mrp, bp, v.id]); return "updated"; }
  await db.query("INSERT INTO variants (company_id,item_id,sku,attrs,mrp,billing_price) VALUES ($1,$2,$3,$4,$5,$6)", [cid, item.id, sku, JSON.stringify(attrs), mrp, bp]);
  return "inserted";
}

/** Stock upload SETS the quantity for (location, SKU, batch). */
async function importStock({ db, cid, s, role, uid }: Imp, r: any) {
  if (!s.features.stock) throw bad("stock tracking is disabled");
  const v = (await db.query("SELECT v.id, i.kind, i.uoms FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 AND v.sku=$2", [cid, String(r.sku ?? "").trim()])).rows[0];
  if (!v) throw bad(`sku ${r.sku} not found`);
  if (v.kind === "service") throw bad("service items carry no stock");
  let loc: number | null = role === "distributor" ? uid : null;
  if (role !== "distributor" && !empty(r.distributor_email)) {
    loc = (await db.query("SELECT id FROM users WHERE company_id=$1 AND email=$2 AND role='distributor'", [cid, String(r.distributor_email).toLowerCase().trim()])).rows[0]?.id;
    if (!loc) throw bad(`distributor ${r.distributor_email} not found`);
  }
  const uoms = parseJson<Uom[]>(v.uoms, s.uoms), unit = empty(r.unit ?? r.uom) ? uoms.find(u => u.factor === 1) : uoms.find(u => u.code === String(r.unit ?? r.uom).toUpperCase());
  if (!unit) throw bad(`unit ${r.unit ?? r.uom} not defined for ${r.sku}`);
  const qty = Number(r.qty ?? r.quantity);
  if (!Number.isInteger(qty) || qty < 0) throw bad("qty must be a whole number ≥ 0");
  const batch = s.features.batches ? String(r.batch ?? r.batch_no ?? "").trim() : "";
  const expiry = s.features.batches ? parseDate(r.expiry ?? r.expiry_date) : null;
  if (s.features.batches && (!batch || !expiry)) throw bad("batch and expiry required");
  const ex = (await db.query(`SELECT id FROM stock WHERE company_id=$1 AND variant_id=$2 AND batch_no=$3 AND ${loc == null ? "distributor_id IS NULL" : "distributor_id=$4"}`,
    loc == null ? [cid, v.id, batch] : [cid, v.id, batch, loc])).rows[0];
  if (ex) { await db.query("UPDATE stock SET qty=$1, expiry=$2 WHERE id=$3", [qty * unit.factor, expiry, ex.id]); return "updated"; }
  await db.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5,$6)", [cid, loc, v.id, batch, expiry, qty * unit.factor]);
  return "inserted";
}

const IMPORTERS: Record<string, (c: Imp, r: any) => Promise<string>> = {
  shops: importShop, products: importProduct, stock: importStock,
  users: async (c, r) => { await c.addUser(c.cid, r); return "inserted"; },
  targets: async (c, r) => (await import("./insights.js")).setTarget(c.db, c.cid, { repEmail: String(r.rep_email ?? r.email ?? ""), month: String(r.month ?? ""), metric: String(r.metric ?? "").toLowerCase().trim(), target: Number(r.target) }),
};
const normRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), typeof v === "string" ? v.trim() : v]));

export async function runImport(c: Imp, kind: string, rows: Record<string, unknown>[]) {
  const fn = IMPORTERS[kind]; if (!fn) throw bad("unknown import type", 404);
  const result = { inserted: 0, updated: 0, errors: [] as { row: number; error: string }[] };
  for (const [i, r] of rows.entries()) {
    try { result[(await fn(c, normRow(r))) as "inserted" | "updated"]++; } catch (e: any) { result.errors.push({ row: i + 2, error: e.message }); }
  }
  return result;
}

export function registerCatalogRoutes({ app, db, auth, wrap, tenant, addUser, companyUsage }: Ctx) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const ANY = ["company_admin", "manager", "sales_rep", "distributor"];

  app.get("/api/templates", (_q, res) => res.json(INDUSTRIES.map(id => ({ id, label: TEMPLATES[id].label, description: TEMPLATES[id].description, settings: TEMPLATES[id].settings }))));

  app.get("/api/company/settings", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await getCompany(db, cid));
  }));
  app.put("/api/company/settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const cur = await getCompany(db, cid), b = req.body || {};
    let industry = cur.industry, base = cur.settings;
    if (b.industry != null) {
      if (!(INDUSTRIES as readonly string[]).includes(b.industry)) throw bad("unknown industry");
      industry = b.industry; if (b.applyTemplate) base = templateSettings(industry);
    }
    const settings = validateSettings(b, base);
    await db.query("UPDATE companies SET industry=$1, settings=$2 WHERE id=$3", [industry, JSON.stringify(settings), cid]);
    res.json({ industry, settings });
  }));
  app.post("/api/company/sample-data", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { industry, settings } = await getCompany(db, cid);
    const t = TEMPLATES[industry as keyof typeof TEMPLATES] ?? TEMPLATES.custom;
    const c: Imp = { db, cid, s: settings, role: "company_admin", uid: req.user.uid, addUser };
    res.json({ industry, shops: await runImport(c, "shops", t.sample.shops), products: await runImport(c, "products", t.sample.products),
      stock: settings.features.stock ? await runImport(c, "stock", t.sample.stock) : null });
  }));

  const variantRows = async (cid: number) => (await db.query(`SELECT v.id, v.sku, v.attrs, v.mrp, v.billing_price, i.id AS item_id, i.code AS item_code, i.name AS item_name,
      i.category, i.kind, i.hsn, i.uoms, i.custom FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 ORDER BY i.code, v.id`, [cid])).rows
    .map(r => ({ ...r, attrs: parseJson(r.attrs, {}), uoms: parseJson(r.uoms, []), custom: parseJson(r.custom, {}), mrp: Number(r.mrp), billing_price: Number(r.billing_price) }));
  app.get("/api/products", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await variantRows(cid));
  }));
  app.get("/api/items", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const m = new Map<number, any>();
    for (const v of await variantRows(cid)) {
      if (!m.has(v.item_id)) m.set(v.item_id, { id: v.item_id, code: v.item_code, name: v.item_name, category: v.category, kind: v.kind, hsn: v.hsn, uoms: v.uoms, custom: v.custom, variants: [] });
      m.get(v.item_id).variants.push({ id: v.id, sku: v.sku, attrs: v.attrs, mrp: v.mrp, billing_price: v.billing_price });
    }
    res.json([...m.values()]);
  }));

  app.patch("/api/shops/:id", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    const shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!shop) throw bad("shop not found", 404);
    const custom = req.body?.custom ? JSON.stringify(cleanCustom(settings.customFields.outlet, req.body.custom)) : shop.custom;
    const dl = req.body?.drugLicence !== undefined ? String(req.body.drugLicence || "") || null : shop.drug_licence;
    res.json((await db.query("UPDATE shops SET custom=$1, drug_licence=$2 WHERE id=$3 RETURNING *", [custom, dl, shop.id])).rows[0]);
  }));

  app.get("/api/stock", auth("company_admin", "manager", "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = req.user.role === "distributor";
    const t = today();
    const rows = (await db.query(`SELECT st.*, v.sku, i.name AS item_name, v.attrs, u.name AS location FROM stock st JOIN variants v ON v.id=st.variant_id JOIN items i ON i.id=v.item_id
      LEFT JOIN users u ON u.id=st.distributor_id WHERE st.company_id=$1 ${own ? "AND st.distributor_id=$2" : ""}`, own ? [cid, req.user.uid] : [cid])).rows;
    res.json(rows.map(r => ({ ...r, attrs: parseJson(r.attrs, {}), location: r.location || "Company stock", expired: !!r.expiry && r.expiry < t }))
      .sort((a, b) => a.sku.localeCompare(b.sku) || (a.expiry || "9999").localeCompare(b.expiry || "9999")));
  }));

  app.get("/api/schemes", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT s.*, i.name AS item_name FROM schemes s LEFT JOIN items i ON i.id=s.item_id WHERE s.company_id=$1 ORDER BY s.id", [cid])).rows);
  }));
  app.post("/api/schemes", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { name, itemId = null, minQty = 1, discountPct } = req.body || {};
    const d = Number(discountPct), mq = Number(minQty);
    if (!name || !(d > 0 && d <= 100) || !Number.isInteger(mq) || mq < 1) throw bad("name, minQty ≥ 1 and discountPct 0–100 required");
    if (itemId != null && !(await db.query("SELECT id FROM items WHERE id=$1 AND company_id=$2", [Number(itemId), cid])).rows[0]) throw bad("item not found", 404);
    res.status(201).json((await db.query("INSERT INTO schemes (company_id,name,item_id,min_qty,discount_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [cid, name, itemId == null ? null : Number(itemId), mq, d])).rows[0]);
  }));

  app.post("/api/import/:kind", auth("company_admin", "distributor"), upload.single("file"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    if (req.user.role === "distributor" && req.params.kind !== "stock") return res.status(403).json({ error: "forbidden" });
    if (!IMPORTERS[req.params.kind]) return res.status(404).json({ error: "unknown import type" });
    if (!req.file) return res.status(400).json({ error: "file required" });
    const csv = /\.csv$/i.test(req.file.originalname || "");
    const wb = XLSX.read(req.file.buffer, { type: "buffer", raw: csv });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    const { settings } = await getCompany(db, cid);
    const result = await runImport({ db, cid, s: settings, role: req.user.role, uid: req.user.uid, addUser }, req.params.kind, rows);
    res.json({ ...result, usage: await companyUsage(cid) });
  }));
}
