// Idempotent sample data for the DEMO company, run on server start. Everything created here is labelled "sample".
// It only touches the company with code DEMO and only adds what is missing.
import type { Db } from "./db.js";
import { parseJson } from "./catalog.js";
import { savePhoto, SAMPLE_PNG } from "./photos.js";
import type { FeatureKey } from "./templates.js";

const one = async (db: Db, q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
async function enable(db: Db, cid: number, keys: FeatureKey[]) {
  const c = await one(db, "SELECT settings FROM companies WHERE id=$1", [cid]);
  const s = parseJson<any>(c.settings, {}); s.features = s.features || {};
  if (keys.every(k => s.features[k] === true)) return;
  for (const k of keys) s.features[k] = true;
  await db.query("UPDATE companies SET settings=$1 WHERE id=$2", [JSON.stringify(s), cid]);
}
const photo = (cid: number) => savePhoto(cid, { buffer: SAMPLE_PNG, size: SAMPLE_PNG.length } as any)!;

export async function seedDemo(db: Db, code = "DEMO") {
  const c = await one(db, "SELECT id FROM companies WHERE code=$1", [code]); if (!c) return;
  const cid = c.id;
  const rep = await one(db, "SELECT id FROM users WHERE company_id=$1 AND role='sales_rep' ORDER BY id", [cid]);
  // 1) Store audits
  await enable(db, cid, ["audits"]);
  if (!(await one(db, "SELECT id FROM audit_templates WHERE company_id=$1", [cid]))) {
    const qs = [{ key: "shelf_clean", label: "Is our shelf clean and tidy?", type: "yes_no", required: true }, { key: "facings", label: "How many of our products are on the shelf?", type: "number" },
      { key: "poster", label: "Is our poster put up?", type: "yes_no" }, { key: "notes", label: "Anything else to note?", type: "text" }, { key: "shelf_photo", label: "Shelf photo", type: "photo" }];
    const t = await one(db, "INSERT INTO audit_templates (company_id,name,questions) VALUES ($1,$2,$3) RETURNING id", [cid, "Shelf check (sample)", JSON.stringify(qs)]);
    const v = rep && await one(db, "SELECT * FROM visits WHERE company_id=$1 AND rep_id=$2 ORDER BY id", [cid, rep.id]);
    if (v) {
      const a = await one(db, "INSERT INTO audits (company_id,visit_id,template_id,rep_id,shop_id,answers) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [cid, v.id, t.id, rep.id, v.shop_id, JSON.stringify({ shelf_clean: true, facings: 8, poster: false, notes: "Sample audit — poster missing" })]);
      const p = photo(cid);
      await db.query("INSERT INTO audit_photos (company_id,audit_id,question,file,mime,size) VALUES ($1,$2,$3,$4,$5,$6)", [cid, a.id, "shelf_photo", p.file, p.mime, p.size]);
    }
  }
  // 2) Expenses
  await enable(db, cid, ["expenses"]);
  if (rep && !(await one(db, "SELECT id FROM expenses WHERE company_id=$1", [cid]))) {
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    for (const [amt, cat, note, st] of [[240, "Travel", "Sample — bus fare to outlets", "approved"], [150, "Food", "Sample — lunch on beat", "pending"]] as const) {
      const p = photo(cid);
      await db.query("INSERT INTO expenses (company_id,rep_id,spent_on,amount,category,note,receipt_file,receipt_mime,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [cid, rep.id, d, amt, cat, note, p.file, p.mime, st]);
    }
  }
  // 3) Leave
  await enable(db, cid, ["leave"]);
  if (rep && !(await one(db, "SELECT id FROM leaves WHERE company_id=$1", [cid]))) {
    const d = new Date(Date.now() + 7 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await db.query("INSERT INTO leaves (company_id,rep_id,from_date,to_date,kind,reason) VALUES ($1,$2,$3,$3,'Casual',$4)", [cid, rep.id, d, "Sample leave request"]);
  }
}
