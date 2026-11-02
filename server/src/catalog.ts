import { gstinError, gstinInfo, GST_STATES, ID_RULES } from "./gstin.js";
// Step 3: industry templates, company settings & feature toggles, configurable catalogue (items + variants + units),
// custom fields, stock with batch/expiry (FEFO), schemes, and attribute-aware Excel/CSV import.
import type { Express, Response, Request, NextFunction } from "express";
import { getFlow } from "./flow.js";
import multer from "multer";
import * as XLSX from "xlsx";
import { withTx, type Db } from "./db.js";
import { smallUpload, savePhoto } from "./photos.js";
import { photoStore } from "./storage.js";
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
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
/** Validate the optional business-identity fields of company GST settings in place. */
function cleanProfile(g: any) {
  for (const k of ["tradeName", "signatoryName", "signatoryDesignation", "bankName", "bankBranch", "website", "irpUsername", "irpGspId", "lutNo", "lutValidTill", "msmeType", "stateName"]) if (k in g) g[k] = clip(g[k], 120);
  for (const k of ["terms", "declaration"]) if (k in g) g[k] = clip(g[k], 1500);
  const up = (k: string, rule: string) => { if (!(k in g)) return; g[k] = clip(g[k], 40); if (rule !== "upi" && rule !== "email") g[k] = g[k].toUpperCase().replace(/\s+/g, k === "phone" ? " " : ""); if (g[k] && !ID_RULES[rule][0].test(g[k])) throw bad(ID_RULES[rule][1]); };
  up("pan", "pan"); up("tan", "tan"); up("cin", "cin"); up("udyam", "udyam"); up("bankIfsc", "ifsc"); up("upiId", "upi"); up("bankAccount", "account");
  if ("email" in g) { g.email = clip(g.email, 120); if (g.email && !ID_RULES.email[0].test(g.email)) throw bad(ID_RULES.email[1]); }
  if ("phone" in g) { g.phone = clip(g.phone, 20); if (g.phone && !ID_RULES.phone[0].test(g.phone)) throw bad(ID_RULES.phone[1]); }
  if ("regType" in g && !["regular", "composition", "sez", "unregistered"].includes(g.regType)) throw bad("registration type must be regular, composition, sez or unregistered");
  if ("fyStartMonth" in g) { g.fyStartMonth = Number(g.fyStartMonth || 4); if (!(Number.isInteger(g.fyStartMonth) && g.fyStartMonth >= 1 && g.fyStartMonth <= 12)) throw bad("financial year start month must be 1–12"); }
  for (const k of ["einvoiceApplicable", "ewayBill", "tcsApplicable", "tdsApplicable"]) if (k in g) g[k] = !!g[k];
  if ("ewayThreshold" in g) { g.ewayThreshold = Number(g.ewayThreshold || 50000); if (!(g.ewayThreshold >= 0)) throw bad("e-way bill threshold must be ≥ 0"); }
  if ("defaultHsn" in g) { g.defaultHsn = clip(g.defaultHsn, 8); if (g.defaultHsn && !/^\d{4,8}$/.test(g.defaultHsn)) throw bad("default HSN/SAC must be 4–8 digits"); }
  for (const k of ["logo", "signature"]) if (k in g) { g[k] = String(g[k] || ""); if (g[k] && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(g[k])) throw bad(`${k} must be a PNG/JPEG/WebP image`); if (g[k].length > 200_000) throw bad(`${k} image is too large (max ~150 KB)`); }
  if ("branches" in g) {
    if (!Array.isArray(g.branches) || g.branches.length > 50) throw bad("branches must be a list (max 50)");
    g.branches = g.branches.map((b: any) => {
      const o: any = { name: clip(b?.name, 120), gstin: clip(b?.gstin, 15).toUpperCase(), stateCode: clip(b?.stateCode, 2), address: clip(b?.address, 300), city: clip(b?.city, 80), pincode: clip(b?.pincode, 6) };
      if (!o.name) throw bad("each branch needs a name");
      if (o.gstin) { const e = gstinError(o.gstin); if (e) throw bad(`${o.name}: ${e}`); o.stateCode ||= o.gstin.slice(0, 2); if (o.stateCode !== o.gstin.slice(0, 2)) throw bad(`${o.name}: GSTIN does not match state code`); }
      if (o.pincode && !ID_RULES.pincode[0].test(o.pincode)) throw bad(`${o.name}: PIN code must be 6 digits`);
      return o;
    });
  }
}

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
  if (input.po) {
    const po = { ...s.po, ...input.po };
    if (!["billing", "mrp"].includes(po.priceBase)) throw bad("PO price base must be billing or mrp");
    const pct = (v: unknown, what: string) => { const n = Number(v); if (!(n >= 0 && n < 100)) throw bad(`${what} must be 0–99.99 %`); return n; };
    po.marginPct = pct(po.marginPct, "margin");
    po.productDiscounts = (Array.isArray(po.productDiscounts) ? po.productDiscounts : []).map((d: any) => {
      if (!["item", "category"].includes(d.scope) || !String(d.key || "").trim()) throw bad("product discount needs scope item/category and a key");
      return { scope: d.scope, key: String(d.key).trim(), pct: pct(d.pct, "product discount") };
    });
    if (!String(po.numberFormat).includes("{seq")) throw bad("PO number format must contain {seq}");
    s.po = po;
  }
  if (input.einvoice) {
    const e = { ...s.einvoice, ...input.einvoice };
    if (!["test", "gsp"].includes(e.provider)) throw bad("e-invoice provider must be test or gsp");
    s.einvoice = e;
  }
  if (input.approval) {
    const a = { levels: Number(input.approval.levels ?? s.approval.levels), above: Number(input.approval.above ?? s.approval.above) };
    if (!(Number.isInteger(a.levels) && a.levels >= 0 && a.levels <= 3)) throw bad("approval levels must be 0 (off), 1, 2 or 3");
    if (!(a.above >= 0)) throw bad("approval amount must be ≥ 0");
    s.approval = a;
  }
  if (input.credit) {
    const c = { ...s.credit, ...input.credit };
    c.days = Number(c.days); c.limit = Number(c.limit);
    if (!(Number.isInteger(c.days) && c.days >= 0)) throw bad("credit days must be a whole number ≥ 0 (0 = no limit)");
    if (!(c.limit >= 0)) throw bad("credit limit must be ≥ 0 (0 = no limit)");
    if (!["warn", "block"].includes(c.onBreach)) throw bad("onBreach must be warn or block");
    s.credit = c;
  }
  if (input.gst) {
    const g = { ...s.gst, ...input.gst };
    g.gstin = String(g.gstin || "").toUpperCase().trim(); g.stateCode = String(g.stateCode || "").trim();
    if (g.gstin && !/^\d{2}[A-Z0-9]{13}$/.test(g.gstin)) throw bad("GSTIN must be 15 characters starting with the 2-digit state code");
    if (g.gstin && g.gstin !== s.gst?.gstin) { const e = gstinError(g.gstin); if (e) throw bad(e); }
    if (g.gstin) { const info = gstinInfo(g.gstin); g.stateCode ||= info.stateCode; g.pan = String(g.pan || "").toUpperCase().trim() || info.pan; if (g.pan !== info.pan) throw bad("PAN does not match the PAN inside the GSTIN"); }
    if (g.stateCode) g.stateName = GST_STATES[g.stateCode] || g.stateName || "";
    cleanProfile(g);
    if (g.stateCode && !/^\d{2}$/.test(g.stateCode)) throw bad("state code must be 2 digits");
    if (g.gstin && g.stateCode && g.gstin.slice(0, 2) !== g.stateCode) throw bad("GSTIN does not match state code");
    if (g.pincode && !/^\d{6}$/.test(String(g.pincode))) throw bad("PIN code must be 6 digits");
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

/** Sellable stock rows at a location in FEFO order (earliest expiry first; expired and soon-to-expire batches excluded). */
export async function fefoRows(db: Db, cid: number, loc: number | null, variantId: number) {
  const rows = (await db.query(`SELECT * FROM stock WHERE company_id=$1 AND variant_id=$2 AND qty>0 AND ${loc == null ? "distributor_id IS NULL" : "distributor_id=$3"}`,
    loc == null ? [cid, variantId] : [cid, variantId, loc])).rows;
  // Batches expiring within the company's "don't sell within N days" window are not offered either.
  const n = (await getFlow(db, cid)).expiryBlockDays || 0;
  const t = n ? new Date(Date.parse(today() + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10) : today();
  return rows.filter(r => !r.expiry || r.expiry >= t).map(r => ({ ...r, qty: Number(r.qty) }))
    .sort((a, b) => (a.expiry || "9999").localeCompare(b.expiry || "9999") || a.id - b.id);
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void;
  addUser: (cid: number, u: any) => Promise<any>; companyUsage: (cid: number) => Promise<any> };
export type Imp = { db: Db; cid: number; s: Settings; role: string; uid: number; addUser: Ctx["addUser"] };

/** Retailer master columns (template order). Sample rows use codes starting SAMPLE-ROW and are skipped on upload. */
export const SHOP_COLUMNS = ["Code", "Name", "Owner Name", "Contact Person", "Phone", "Email", "GSTIN", "PAN", "Address", "City", "State", "State Code", "PIN Code",
  "Latitude", "Longitude", "Channel", "Outlet Type", "Outlet Class", "Beat", "Distributor Email", "Rep Email", "Credit Limit", "Credit Days", "Payment Terms", "Active"];
export const SHOP_EDIT_KEYS = ["code", "name", "owner_name", "contact_person", "phone", "email", "gstin", "pan", "address", "city", "state", "state_code", "pincode",
  "latitude", "longitude", "channel", "outlet_type", "outlet_class", "beat", "distributor_email", "rep_email", "payment_terms", "active"];
export const SHOP_SAMPLE_ROWS = [
  ["SAMPLE-ROW-1", "Sample Kirana Store (sample row — replace or delete)", "Sample Owner", "Sample Contact", "9000000001", "sample.store1@example.com", "33AAAAA0000A1Z9", "AAAAA0000A", "1 Sample Street", "Chennai", "Tamil Nadu", "33", "600001",
    "13.0827", "80.2707", "General trade", "Kirana", "A", "Sample Beat Monday", "", "", "50000", "15", "15 days credit", "Yes"],
  ["SAMPLE-ROW-2", "Sample Chemist (sample row — replace or delete)", "Sample Owner 2", "", "9000000002", "", "", "", "2 Sample Road", "Bengaluru", "Karnataka", "29", "560001",
    "", "", "Pharmacy", "Chemist", "B", "", "", "", "0", "0", "Cash", "No"],
];
const yes = (v: unknown) => { const t = String(v).trim().toLowerCase(); if (["yes", "y", "true", "1", "active"].includes(t)) return true; if (["no", "n", "false", "0", "inactive"].includes(t)) return false; throw bad(`Active must be Yes or No (got "${v}")`); };
async function importShop({ db, cid, s }: Imp, r: any) {
  if (empty(r.code) || empty(r.name)) throw bad("Code and Name are required");
  if (/^SAMPLE-ROW/i.test(String(r.code).trim())) return "skipped";
  const custom = JSON.stringify(cleanCustom(s.customFields.outlet, r));
  const dl = s.features.drugLicence ? String(r.drug_licence ?? r.drug_licence_no ?? r.dl_no ?? "").trim() || null : null;
  let dist: number | null = null;
  if (!empty(r.distributor_email)) {
    dist = (await db.query("SELECT id FROM users WHERE company_id=$1 AND email=$2 AND role='distributor'", [cid, String(r.distributor_email).toLowerCase().trim()])).rows[0]?.id;
    if (!dist) throw bad(`distributor ${r.distributor_email} not found`);
  }
  const gstin = String(r.gstin ?? "").toUpperCase().trim() || null;
  if (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin)) throw bad("invalid GSTIN");
  if (gstin) { const e = gstinError(gstin); if (e) throw bad(e); }
  // State: a 2-digit code, or a state name (e.g. Tamil Nadu); else taken from the GSTIN.
  let stateIn = String(r.state_code ?? "").trim();
  if (!stateIn && !empty(r.state)) {
    const n = String(r.state).trim().toLowerCase(), hit = Object.entries(GST_STATES).find(([, v]) => v.toLowerCase() === n);
    if (/^\d{1,2}$/.test(n)) stateIn = n; else if (hit) stateIn = hit[0]; else throw bad(`unknown state "${r.state}"`);
  }
  const state = stateIn.padStart(stateIn ? 2 : 0, "0") || gstin?.slice(0, 2) || null;
  if (state && !/^\d{2}$/.test(state)) throw bad("state code must be 2 digits");
  if (state && gstin && gstin.slice(0, 2) !== state) throw bad(`GSTIN ${gstin} does not match state code ${state}`);
  const pan = String(r.pan ?? "").toUpperCase().trim() || (gstin ? gstin.slice(2, 12) : null);
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw bad("PAN must look like AAAAA9999A");
  if (pan && gstin && gstin.slice(2, 12) !== pan) throw bad("PAN does not match the GSTIN");
  const email = String(r.email ?? "").trim().toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(`invalid email "${email}"`);
  const phone = String(r.phone ?? r.mobile ?? "").replace(/[\s-]/g, "");
  if (phone && !/^\+?\d{10,13}$/.test(phone)) throw bad("Phone must be 10–13 digits");
  const coord = (v: unknown, lim: number, label: string) => { if (empty(v)) return null; const n = Number(v); if (!(Number.isFinite(n) && Math.abs(n) <= lim)) throw bad(`${label} must be a number between -${lim} and ${lim}`); return n; };
  const lat = coord(r.latitude ?? r.lat, 90, "Latitude"), lng = coord(r.longitude ?? r.long ?? r.lng, 180, "Longitude");
  if ((lat == null) !== (lng == null)) throw bad("give both Latitude and Longitude, or neither");
  let rep: number | null = null;
  if (!empty(r.rep_email)) {
    rep = (await db.query("SELECT id FROM users WHERE company_id=$1 AND email=$2 AND role='sales_rep'", [cid, String(r.rep_email).toLowerCase().trim()])).rows[0]?.id;
    if (!rep) throw bad(`sales rep ${r.rep_email} not found`);
  }
  const active = empty(r.active) ? undefined : yes(r.active);
  const txt = (v: unknown, n = 60) => empty(v) ? null : String(v).trim().slice(0, n);
  const extra = { contact: txt(r.contact_person, 80), email, pan, channel: txt(r.channel ?? r.type, 40), cls: txt(r.outlet_class ?? r.class, 20), terms: txt(r.payment_terms, 80), lat, lng, rep };
  const beatName = txt(r.beat ?? r.route, 80);
  const pin = String(r.pincode ?? r.pin ?? r.pin_code ?? "").trim() || null;
  if (pin && !/^\d{6}$/.test(pin)) throw bad("PIN code must be 6 digits");
  // Optional credit terms per outlet (blank keeps what is there; 0 = no limit / cash).
  const term = (v: any, int: boolean, label: string) => { if (empty(v)) return undefined; const n = Number(String(v).replace(/,/g, "")); if (!(n >= 0) || (int && !Number.isInteger(n))) throw bad(`${label} must be a number ≥ 0`); return n; };
  const climit = term(r.credit_limit, false, "credit limit"), cdays = term(r.credit_days, true, "credit days");
  const vals = [String(r.name), r.owner_name || extra.contact || null, phone || null, r.address || null, r.city || null, gstin, dl, custom, state, pin];
  const setTerms = async (id: number) => {
    if (climit !== undefined) await db.query("UPDATE shops SET credit_limit=$1 WHERE id=$2", [climit, id]);
    if (cdays !== undefined) await db.query("UPDATE shops SET credit_days=$1 WHERE id=$2", [cdays, id]);
    // Optional extras: a blank cell keeps what is there.
    const set: [string, unknown][] = [["email", extra.email], ["pan", extra.pan], ["channel", extra.channel], ["outlet_class", extra.cls], ["payment_terms", extra.terms], ["lat", extra.lat], ["lng", extra.lng], ["rep_id", extra.rep], ["active", active]];
    for (const [k, v] of set) if (v !== null && v !== undefined) await db.query(`UPDATE shops SET ${k}=$1 WHERE id=$2`, [v, id]);
    if (beatName) {
      let b = (await db.query("SELECT id FROM beats WHERE company_id=$1 AND LOWER(name)=LOWER($2)", [cid, beatName])).rows[0];
      if (!b) b = (await db.query("INSERT INTO beats (company_id,name,rep_id) VALUES ($1,$2,$3) RETURNING id", [cid, beatName, extra.rep])).rows[0];
      if (!(await db.query("SELECT 1 FROM beat_shops WHERE beat_id=$1 AND shop_id=$2", [b.id, id])).rows[0]) {
        const seq = Number((await db.query("SELECT COALESCE(MAX(seq),0) AS n FROM beat_shops WHERE beat_id=$1", [b.id])).rows[0].n) + 1;
        await db.query("INSERT INTO beat_shops (beat_id,shop_id,seq) VALUES ($1,$2,$3)", [b.id, id, seq]);
      }
    }
  };
  const ex = (await db.query("SELECT id, distributor_id FROM shops WHERE company_id=$1 AND code=$2", [cid, String(r.code)])).rows[0];
  if (ex) {
    await db.query("UPDATE shops SET updated_at=NOW(), name=$1,owner_name=COALESCE($2,owner_name),phone=COALESCE($3,phone),address=COALESCE($4,address),city=COALESCE($5,city),gstin=COALESCE($6,gstin),drug_licence=COALESCE($7,drug_licence),custom=$8,state_code=COALESCE($9,state_code),pincode=COALESCE($10,pincode),distributor_id=$11 WHERE id=$12", [...vals, dist ?? ex.distributor_id, ex.id]);
    if (!empty(r.outlet_type)) await db.query("UPDATE shops SET outlet_type=$1 WHERE id=$2", [String(r.outlet_type).trim().slice(0, 40), ex.id]);
    await setTerms(ex.id);
    return "updated";
  }
  if (!empty(r.outlet_type)) { await db.query("INSERT INTO shops (name,owner_name,phone,address,city,gstin,drug_licence,custom,state_code,pincode,distributor_id,company_id,code,outlet_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [...vals, dist, cid, String(r.code), String(r.outlet_type).trim().slice(0, 40)]); }
  else await db.query("INSERT INTO shops (name,owner_name,phone,address,city,gstin,drug_licence,custom,state_code,pincode,distributor_id,company_id,code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [...vals, dist, cid, String(r.code)]);
  await setTerms((await db.query("SELECT id FROM shops WHERE company_id=$1 AND code=$2", [cid, String(r.code)])).rows[0].id);
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
  const images = empty(r.images ?? r.image_url ?? r.image) ? null : JSON.stringify(parseImages(r.images ?? r.image_url ?? r.image));
  const active = empty(r.active) ? null : yes(r.active);
  let item = (await db.query("SELECT id FROM items WHERE company_id=$1 AND code=$2", [cid, code])).rows[0];
  const hsn = String(r.hsn ?? "").trim() || null;
  if (hsn && !/^\d{4,8}$/.test(hsn)) throw bad(`HSN/SAC must be 4 to 8 digits (got "${hsn}")`);
  if (item) await db.query("UPDATE items SET updated_at=NOW(), name=$1,category=$2,kind=$3,hsn=$4,uoms=$5,custom=$6,images=COALESCE($8,images) WHERE id=$7", [name, r.category || null, kind, hsn, uoms, custom, item.id, images]);
  else item = (await db.query("INSERT INTO items (company_id,code,name,category,kind,hsn,uoms,custom,images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [cid, code, name, r.category || null, kind, hsn, uoms, custom, images])).rows[0];
  const v = (await db.query("SELECT id FROM variants WHERE company_id=$1 AND sku=$2", [cid, sku])).rows[0];
  const barcode = empty(r.barcode ?? r.ean ?? r.gtin) ? null : String(r.barcode ?? r.ean ?? r.gtin).trim().slice(0, 64);
  if (barcode && (await db.query("SELECT id FROM variants WHERE company_id=$1 AND barcode=$2 AND sku<>$3", [cid, barcode, sku])).rows[0]) throw bad(`barcode ${barcode} is already used by another product`);
  if (v) { await db.query("UPDATE variants SET updated_at=NOW(), item_id=$1,attrs=$2,mrp=$3,billing_price=$4,barcode=COALESCE($6,barcode),active=COALESCE($7,active) WHERE id=$5", [item.id, JSON.stringify(attrs), mrp, bp, v.id, barcode, active]); return "updated"; }
  await db.query("INSERT INTO variants (company_id,item_id,sku,attrs,mrp,billing_price,barcode,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [cid, item.id, sku, JSON.stringify(attrs), mrp, bp, barcode, active ?? true]);
  return "inserted";
}

/** Images: up to 6 https:// links (or links to uploaded product photos), separated by commas, spaces or "|". */
export function parseImages(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,|]+/)).map(x => String(x).trim()).filter(Boolean);
  if (list.length > 6) throw bad("at most 6 images per product");
  for (const u of list) if (!/^https:\/\/[^\s"'<>]{4,500}$/.test(u) && !/^\/api\/product-images\/\d+\/[a-f0-9-]{36}\.(jpeg|png|webp)$/.test(u)) throw bad(`image must be an https:// link (got "${u.slice(0, 60)}")`);
  return list;
}

/** Stock upload SETS the quantity for (location, SKU, batch). */
/** Channel price list row: SKU, Outlet Type, Price (empty or 0 price removes it, so the standard billing price applies again). */
async function importPrice({ db, cid }: Imp, r: any) {
  const sku = String(r.sku ?? "").trim(), type = String(r.outlet_type ?? r.channel ?? "").trim(), price = empty(r.price) ? 0 : Number(r.price);
  if (!sku || !type) throw bad("SKU and Outlet Type are required");
  if (!(price >= 0)) throw bad("price must be a number ≥ 0");
  const v = (await db.query("SELECT v.id FROM variants v JOIN items i ON i.id=v.item_id WHERE i.company_id=$1 AND v.sku=$2", [cid, sku])).rows[0];
  if (!v) throw bad(`unknown SKU ${sku}`);
  const had = (await db.query("SELECT id FROM channel_prices WHERE variant_id=$1 AND lower(outlet_type)=lower($2)", [v.id, type])).rows[0];
  if (!price) { if (had) await db.query("DELETE FROM channel_prices WHERE id=$1", [had.id]); return "updated"; }
  if (had) { await db.query("UPDATE channel_prices SET price=$1 WHERE id=$2", [price, had.id]); return "updated"; }
  await db.query("INSERT INTO channel_prices (company_id,variant_id,outlet_type,price) VALUES ($1,$2,$3,$4)", [cid, v.id, type, price]);
  return "inserted";
}
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
  if (ex) { await db.query("UPDATE stock SET updated_at=NOW(), qty=$1, expiry=$2 WHERE id=$3", [qty * unit.factor, expiry, ex.id]); return "updated"; }
  await db.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5,$6)", [cid, loc, v.id, batch, expiry, qty * unit.factor]);
  return "inserted";
}

const IMPORTERS: Record<string, (c: Imp, r: any) => Promise<string>> = {
  shops: importShop, products: importProduct, stock: importStock, prices: importPrice,
  users: async (c, r) => { await c.addUser(c.cid, r); return "inserted"; },
  targets: async (c, r) => (await import("./insights.js")).setTarget(c.db, c.cid, { repEmail: String(r.rep_email ?? r.email ?? ""), month: String(r.month ?? ""), metric: String(r.metric ?? "").toLowerCase().trim(), target: Number(r.target) }),
};
const normRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), typeof v === "string" ? v.trim() : v]));

/** Run one importer on one already-normalised row (used by the public API upserts). */
export async function importOne(c: Imp, kind: string, row: Record<string, unknown>) {
  const fn = IMPORTERS[kind]; if (!fn) throw bad("unknown import type", 404);
  return fn(c, normRow(row)) as Promise<"inserted" | "updated">;
}
export async function runImport(c: Imp, kind: string, rows: Record<string, unknown>[]) {
  const fn = IMPORTERS[kind]; if (!fn) throw bad("unknown import type", 404);
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] as { row: number; code?: string; error: string }[] };
  for (const [i, r] of rows.entries()) {
    const n = normRow(r);
    if (Object.values(n).every(v => v == null || String(v).trim() === "")) continue; // blank line
    try { result[(await fn(c, n)) as "inserted" | "updated" | "skipped"]++; } catch (e: any) { result.errors.push({ row: i + 2, ...(n.code ? { code: String(n.code) } : {}), error: e.message }); }
  }
  return result;
}

export function registerCatalogRoutes({ app, db, auth, wrap, tenant, addUser, companyUsage }: Ctx) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  const ANY = ["company_admin", "manager", "sales_rep", "distributor", "retailer"];

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

  const variantRows = async (cid: number, all = true) => (await db.query(`SELECT v.id, v.sku, v.barcode, v.attrs, v.mrp, v.billing_price, v.active, i.id AS item_id, i.code AS item_code, i.name AS item_name,
      i.category, i.kind, i.hsn, i.uoms, i.custom, i.images, i.active AS item_active FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 ${all ? "" : "AND v.active=TRUE AND i.active=TRUE"} ORDER BY i.code, v.id`, [cid])).rows
    .map(r => ({ ...r, attrs: parseJson(r.attrs, {}), uoms: parseJson(r.uoms, []), custom: parseJson(r.custom, {}), images: parseJson(r.images, []), mrp: Number(r.mrp), billing_price: Number(r.billing_price) }));
  const seesAll = (req: any) => ["company_admin", "manager"].includes(req.user.role);
  app.get("/api/products", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await variantRows(cid, seesAll(req)));
  }));
  // Barcode / QR lookup for scanning (matches the barcode field or the SKU itself).
  app.get("/api/products/scan/:code", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const code = String(req.params.code).trim(); const v = (await variantRows(cid, seesAll(req))).find(x => x.barcode === code || x.sku === code);
    if (!v) throw bad("no product with this code", 404); res.json(v);
  }));
  app.get("/api/items", auth(...ANY), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const m = new Map<number, any>();
    for (const v of await variantRows(cid, seesAll(req))) {
      if (!m.has(v.item_id)) m.set(v.item_id, { id: v.item_id, code: v.item_code, name: v.item_name, category: v.category, kind: v.kind, hsn: v.hsn, uoms: v.uoms, custom: v.custom, images: v.images, active: v.item_active, variants: [] });
      m.get(v.item_id).variants.push({ id: v.id, sku: v.sku, barcode: v.barcode, attrs: v.attrs, mrp: v.mrp, billing_price: v.billing_price, active: v.active });
    }
    res.json([...m.values()]);
  }));

  // Single product add / edit (admin): every column of the product upload, same checks (one row per size/variant).
  // Removing a size from the screen deactivates it (kept for old orders and invoices).
  const saveItem = async (req: any, cid: number, itemId: number | null) => {
    const { settings } = await getCompany(db, cid), b = req.body || {};
    const code = String(b.code ?? "").trim(); if (!code) throw bad("style / item code is required");
    if (!/^[A-Za-z0-9._\/-]{1,40}$/.test(code)) throw bad("style / item code: letters, digits and . _ / - only (max 40)");
    if (!String(b.name ?? "").trim()) throw bad("product name is required");
    const vars = Array.isArray(b.variants) ? b.variants : []; if (!vars.length) throw bad("add at least one size / variant (SKU)");
    const skus = vars.map((v: any) => String(v.sku ?? "").trim());
    if (skus.some((s: string) => !s)) throw bad("every size / variant needs a SKU");
    if (new Set(skus).size !== skus.length) throw bad("the same SKU is listed twice");
    const ex = itemId ? (await db.query("SELECT * FROM items WHERE id=$1 AND company_id=$2", [itemId, cid])).rows[0] : null;
    if (itemId && !ex) throw bad("product not found", 404);
    if (ex && ex.code !== code) throw bad("the style / item code cannot be changed");
    if (!ex && (await db.query("SELECT id FROM items WHERE company_id=$1 AND code=$2", [cid, code])).rows[0]) throw bad(`a product with code ${code} already exists`, 409);
    for (const s of skus) { const o = (await db.query("SELECT v.id FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 AND v.sku=$2 AND i.code<>$3", [cid, s, code])).rows[0]; if (o) throw bad(`SKU ${s} belongs to another product`, 409); }
    const units = Array.isArray(b.units) ? b.units : b.units;
    const imp: Imp = { db, cid, s: settings, role: req.user.role, uid: req.user.uid, addUser };
    await withTx(db, async tx => {
      const c = { ...imp, db: tx };
      for (const [i, v] of vars.entries()) {
        const row: Record<string, unknown> = { ...(b.custom || {}), item_code: code, item_name: String(b.name).trim(), category: b.category ?? "", type: b.kind === "service" ? "service" : "goods", hsn: b.hsn ?? "",
          units: units == null || units === "" || (Array.isArray(units) && !units.length) ? "" : units, sku: skus[i], mrp: v.mrp, billing_price: v.billing_price, barcode: v.barcode ?? "",
          images: Array.isArray(b.images) ? b.images.join(",") : b.images ?? "", active: v.active === false || b.active === false ? "No" : "Yes" };
        for (const a of settings.attributes) row[a] = v.attrs?.[a] ?? v[a] ?? "";
        try { await importOne(c, "products", row); } catch (e: any) { throw bad(`${skus[i]}: ${e.message}`, e.status || 400); }
      }
      const it = (await tx.query("SELECT id FROM items WHERE company_id=$1 AND code=$2", [cid, code])).rows[0];
      await tx.query("UPDATE items SET updated_at=NOW(), active=$1, images=$2 WHERE id=$3", [b.active !== false, JSON.stringify(Array.isArray(b.images) ? parseImages(b.images) : parseImages(b.images ?? "")), it.id]);
      const gone = (await tx.query("SELECT id, sku FROM variants WHERE item_id=$1", [it.id])).rows.filter((x: any) => !skus.includes(x.sku));
      for (const g of gone) await tx.query("UPDATE variants SET updated_at=NOW(), active=FALSE WHERE id=$1", [g.id]);
      itemId = it.id;
    });
    return (await variantRows(cid)).filter(v => v.item_id === itemId);
  };
  app.post("/api/products/item", auth("company_admin"), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.status(201).json(await saveItem(req, cid, null)); }));
  app.put("/api/products/item/:id", auth("company_admin"), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json(await saveItem(req, cid, Number(req.params.id))); }));
  // Product photo upload for the product screen; served by an unguessable name so <img> tags can show it.
  app.post("/api/products/images", auth("company_admin"), smallUpload.single("photo"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const p = await savePhoto(cid, req.file); res.status(201).json({ url: `/api/product-images/${p!.file.replace(/\\/g, "/")}` });
  }));
  app.get(/^\/api\/product-images\/(\d+)\/([a-f0-9-]{36}\.(?:jpeg|png|webp))$/, wrap(async (req, res) => {
    const [cidS, name] = [req.params[0], req.params[1]];
    const buf = await photoStore().get(`${cidS}/${name}`).catch(() => null); if (!buf) return res.status(404).json({ error: "not found" });
    res.type(name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg").set("Cache-Control", "public, max-age=86400").send(buf);
  }));

  // Single outlet add / edit uses the same checks as the retailer master upload (GSTIN, PAN, state, phone, PIN, lat/long, beat, rep, distributor).
  const pickShop = (b: any) => Object.fromEntries(SHOP_EDIT_KEYS.filter(k => b?.[k] !== undefined).map(k => [k, b[k] === null ? "" : b[k]]));
  app.post("/api/shops", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    const row = { ...pickShop(req.body), ...(req.body?.custom || {}) };
    if (empty(row.code) || empty(row.name)) throw bad("Code and Name are required");
    if ((await db.query("SELECT id FROM shops WHERE company_id=$1 AND code=$2", [cid, String(row.code).trim()])).rows[0]) throw bad(`an outlet with code ${row.code} already exists`, 409);
    if (/^SAMPLE-ROW/i.test(String(row.code))) throw bad("pick a real outlet code");
    await importOne({ db, cid, s: settings, role: req.user.role, uid: req.user.uid, addUser }, "shops", row);
    res.status(201).json((await db.query("SELECT * FROM shops WHERE company_id=$1 AND code=$2", [cid, String(row.code).trim()])).rows[0]);
  }));
  app.patch("/api/shops/:id", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    let shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!shop) throw bad("shop not found", 404);
    const fields = pickShop(req.body); delete fields.code;
    if (Object.keys(fields).length) {
      if (fields.name !== undefined && empty(fields.name)) throw bad("Name cannot be blank");
      await importOne({ db, cid, s: settings, role: req.user.role, uid: req.user.uid, addUser }, "shops", { ...parseJson(shop.custom, {}), ...(req.body?.custom || {}), ...fields, code: shop.code, name: fields.name ?? shop.name });
      shop = (await db.query("SELECT * FROM shops WHERE id=$1", [shop.id])).rows[0];
    }
    const custom = req.body?.custom ? JSON.stringify(cleanCustom(settings.customFields.outlet, req.body.custom)) : shop.custom;
    const dl = req.body?.drugLicence !== undefined ? String(req.body.drugLicence || "") || null : shop.drug_licence;
    const lim = (k: string, col: string, int: boolean) => { const v = req.body?.[k]; if (v === undefined) return shop[col]; if (v === null || v === "") return null;
      const n = Number(v); if (!(n >= 0) || (int && !Number.isInteger(n))) throw bad(`${k} must be ≥ 0`); return n; };
    res.json((await db.query("UPDATE shops SET updated_at=NOW(), custom=$1, drug_licence=$2, credit_days=$3, credit_limit=$4 WHERE id=$5 RETURNING *",
      [custom, dl, lim("creditDays", "credit_days", true), lim("creditLimit", "credit_limit", false), shop.id])).rows[0]);
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



  // Retailer master template: headers + clearly labelled sample rows (skipped on upload) + a read-me sheet.
  app.get("/api/import/shops/template", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    const known = new Set(SHOP_COLUMNS.map(norm));
    const cf = settings.customFields.outlet.map(x => x.label).filter(l => !known.has(norm(l)));
    const head = [...SHOP_COLUMNS.slice(0, 13), ...(settings.features.drugLicence ? ["Drug Licence"] : []), ...SHOP_COLUMNS.slice(13), ...cf];
    const rows = SHOP_SAMPLE_ROWS.map(r => head.map(h => { const i = SHOP_COLUMNS.indexOf(h); return i >= 0 ? r[i] : ""; }));
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    if (req.query.format === "csv") return res.type("text/csv").attachment("retailer-master-template.csv").send(XLSX.utils.sheet_to_csv(ws));
    const help = XLSX.utils.aoa_to_sheet([["Retailer master — how to fill"], ["Rows whose Code starts with SAMPLE-ROW are examples and are skipped on upload. Replace them with your retailers."],
      ["Code is the key: uploading a Code that exists updates that retailer; a new Code adds one. Blank optional cells keep the current value."],
      ["Required: Code, Name. GSTIN is checked (format, state, checksum); PAN must match the GSTIN. State: name or 2-digit code."],
      ["Distributor Email / Rep Email must be existing users. Beat is created if it does not exist. Active: Yes or No."],
      ["Credit Limit 0 = no limit; Credit Days 0 = cash. Latitude/Longitude in decimal degrees."]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Retailers"); XLSX.utils.book_append_sheet(wb, help, "Read me");
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment("retailer-master-template.xlsx").send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
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
