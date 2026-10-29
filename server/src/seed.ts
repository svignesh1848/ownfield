// Idempotent sample data for the DEMO company, run on server start. Everything created here is labelled "sample".
// It only touches the company with code DEMO and only adds what is missing.
import bcrypt from "bcryptjs";
import type { Db } from "./db.js";
import { parseJson } from "./catalog.js";
import { savePhoto, SAMPLE_PNG } from "./photos.js";
import type { FeatureKey } from "./templates.js";
import { cleanFlow, FLOW_DEFAULT } from "./flow.js";
import { kvSet } from "./common.js";

const one = async (db: Db, q: string, p: unknown[] = []) => (await db.query(q, p)).rows[0];
async function enable(db: Db, cid: number, keys: FeatureKey[]) {
  const c = await one(db, "SELECT settings FROM companies WHERE id=$1", [cid]);
  const s = parseJson<any>(c.settings, {}); s.features = s.features || {};
  if (keys.every(k => s.features[k] === true)) return;
  for (const k of keys) s.features[k] = true;
  await db.query("UPDATE companies SET settings=$1 WHERE id=$2", [JSON.stringify(s), cid]);
}
/** Sample photo; if the upload folder isn't writable the sample simply has no photo. */
const photo = (cid: number) => { try { return savePhoto(cid, { buffer: SAMPLE_PNG, size: SAMPLE_PNG.length } as any)!; } catch (e: any) { console.error("sample photo skipped:", e.message); return null; } };
/** Run one seeding step; a failure is logged and does not stop the other steps. */
const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e: any) { console.error(`demo seed (${name}) skipped:`, e.message); } };

export async function seedDemo(db: Db, code = "DEMO") {
  const c = await one(db, "SELECT id FROM companies WHERE code=$1", [code]); if (!c) return;
  const cid = c.id;
  const rep = await one(db, "SELECT id FROM users WHERE company_id=$1 AND role='sales_rep' ORDER BY id", [cid]);
  // 1) Store audits
  await step("audits", async () => {
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
      if (p) await db.query("INSERT INTO audit_photos (company_id,audit_id,question,file,mime,size) VALUES ($1,$2,$3,$4,$5,$6)", [cid, a.id, "shelf_photo", p.file, p.mime, p.size]);
    }
  }
  });
  // 2) Expenses
  await step("expenses", async () => {
  await enable(db, cid, ["expenses"]);
  if (rep && !(await one(db, "SELECT id FROM expenses WHERE company_id=$1", [cid]))) {
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    for (const [amt, cat, note, st] of [[240, "Travel", "Sample — bus fare to outlets", "approved"], [150, "Food", "Sample — lunch on beat", "pending"]] as const) {
      const p = photo(cid);
      await db.query("INSERT INTO expenses (company_id,rep_id,spent_on,amount,category,note,receipt_file,receipt_mime,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [cid, rep.id, d, amt, cat, note, p?.file ?? null, p?.mime ?? null, st]);
    }
  }
  });
  // 3) Leave
  await step("leave", async () => {
  await enable(db, cid, ["leave"]);
  if (rep && !(await one(db, "SELECT id FROM leaves WHERE company_id=$1", [cid]))) {
    const d = new Date(Date.now() + 7 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await db.query("INSERT INTO leaves (company_id,rep_id,from_date,to_date,kind,reason) VALUES ($1,$2,$3,$3,'Casual',$4)", [cid, rep.id, d, "Sample leave request"]);
  }
  });
  // 4) Incentives
  await step("incentives", async () => {
  await enable(db, cid, ["incentives"]);
  if (!(await one(db, "SELECT id FROM incentive_rules WHERE company_id=$1", [cid]))) {
    await db.query("INSERT INTO incentive_rules (company_id,name,metric,slabs) VALUES ($1,$2,'value',$3)", [cid, "Monthly sales bonus (sample)", JSON.stringify([{ minPct: 80, amount: 1000 }, { minPct: 100, amount: 2500 }, { minPct: 120, amount: 4000 }])]);
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
    if (rep && !(await one(db, "SELECT id FROM targets WHERE company_id=$1 AND rep_id=$2 AND month=$3 AND metric='value'", [cid, rep.id, month])))
      await db.query("INSERT INTO targets (company_id,rep_id,month,metric,target) VALUES ($1,$2,$3,'value',$4)", [cid, rep.id, month, 5000]);
  }
  });
  // 5) Retailer app: retailer@example.com / Demo@2026 linked to a sample outlet that has a distributor
  await step("retailer", async () => {
  await enable(db, cid, ["retailerApp"]);
  if (!(await one(db, "SELECT id FROM users WHERE company_id=$1 AND email='retailer@example.com'", [cid]))) {
    const shop = await one(db, "SELECT id FROM shops WHERE company_id=$1 AND distributor_id IS NOT NULL ORDER BY id", [cid]) || await one(db, "SELECT id FROM shops WHERE company_id=$1 ORDER BY id", [cid]);
    if (shop) await db.query("INSERT INTO users (company_id,email,name,role,password_hash,shop_id) VALUES ($1,'retailer@example.com','Sample Retailer','retailer',$2,$3)", [cid, await bcrypt.hash("Demo@2026", 10), shop.id]);
  }
  });
  // 6) Field-ops modules (van sales, distributor inventory, claims, barcode, leads, tracking, coverage, surveys, messaging), all labelled sample.
  await step("fieldops", async () => {
  await enable(db, cid, ["vanSales", "distInventory", "claims", "barcode", "leads", "tracking", "coverage", "surveys", "messaging"]);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const vars = (await db.query("SELECT v.id FROM variants v JOIN items i ON i.id=v.item_id WHERE i.company_id=$1 ORDER BY v.id LIMIT 3", [cid])).rows;
  await db.query("UPDATE variants SET barcode=CAST(8900000000000 + id AS TEXT) WHERE barcode IS NULL AND company_id=$1", [cid]);
  if (rep && vars.length && !(await one(db, "SELECT id FROM van_loads WHERE company_id=$1", [cid]))) {
    const l = await one(db, "INSERT INTO van_loads (company_id,rep_id,day) VALUES ($1,$2,$3) RETURNING id", [cid, rep.id, day]);
    for (const v of vars) await db.query("INSERT INTO van_lines (load_id,variant_id,loaded) VALUES ($1,$2,$3)", [l.id, v.id, 24]);
  }
  const dist = await one(db, "SELECT id FROM users WHERE company_id=$1 AND role='distributor' ORDER BY id", [cid]);
  if (dist && !(await one(db, "SELECT id FROM claims WHERE company_id=$1", [cid])))
    await db.query("INSERT INTO claims (company_id,distributor_id,kind,description,amount) VALUES ($1,$2,'damage',$3,$4)", [cid, dist.id, "Sample claim — 6 damaged cartons in transit", 540]);
  if (!(await one(db, "SELECT id FROM leads WHERE company_id=$1", [cid]))) {
    await db.query("INSERT INTO leads (company_id,name,kind,owner_name,phone,city,next_follow_up,notes,assigned_to,created_by) VALUES ($1,$2,'outlet',$3,$4,$5,$6,$7,$8,$8)", [cid, "Sample New Mart", "Sample Owner", "9000000001", "Chennai", day, "Sample lead — wants a price list", rep?.id ?? null]);
    await db.query("INSERT INTO leads (company_id,name,kind,city,status,notes,created_by) VALUES ($1,$2,'dealer',$3,'contacted',$4,$5)", [cid, "Sample Traders (dealer)", "Madurai", "Sample dealer lead", rep?.id ?? null]);
  }
  if (rep && !(await one(db, "SELECT id FROM location_pings WHERE company_id=$1", [cid]))) {
    const base = new Date(`${day}T10:00:00+05:30`).getTime();
    for (let i = 0; i < 8; i++) await db.query("INSERT INTO location_pings (company_id,user_id,at,lat,lng,acc) VALUES ($1,$2,$3,$4,$5,20)", [cid, rep.id, new Date(base + i * 15 * 60_000).toISOString(), 13.0827 + i * 0.002, 80.2707 + i * 0.0015]);
  }
  if (!(await one(db, "SELECT id FROM survey_forms WHERE company_id=$1", [cid]))) {
    const qs = [{ key: "rival_price", label: "Rival brand 1 kg price", type: "price", brand: "Sample Rival Brand", required: true }, { key: "rival_offer", label: "Rival running an offer?", type: "yesno" },
      { key: "shelf", label: "Where is our product?", type: "select", options: ["Eye level", "Lower shelf", "Not on shelf"] }, { key: "notes", label: "Competitor activity", type: "text" }];
    const f = await one(db, "INSERT INTO survey_forms (company_id,name,questions) VALUES ($1,$2,$3) RETURNING id", [cid, "Competitor price check (sample)", JSON.stringify(qs)]);
    const shops = (await db.query("SELECT id FROM shops WHERE company_id=$1 ORDER BY id LIMIT 3", [cid])).rows;
    for (const [i, sh] of shops.entries()) await db.query("INSERT INTO survey_responses (company_id,form_id,shop_id,user_id,answers) VALUES ($1,$2,$3,$4,$5)",
      [cid, f.id, sh.id, rep?.id ?? null, JSON.stringify({ rival_price: [92, 95, 89][i], rival_offer: i === 0, shelf: ["Eye level", "Lower shelf", "Eye level"][i], notes: "Sample response" })]);
  }
  if (!(await one(db, "SELECT id FROM message_log WHERE company_id=$1", [cid])))
    await db.query("INSERT INTO message_log (company_id,channel,to_phone,template,body,status,provider,sent_at) VALUES ($1,'whatsapp','919000000001','order_confirmed',$2,'mock','mock',NOW())", [cid, "Hi Sample Outlet, your order #SAMPLE-1 for ₹1250.00 is received. Thank you (sample, not sent)"]);
  });
  // 7) Flow rules (outlet types, must-sell, retailer announcement, perfect-store target, scheme budget), all labelled sample.
  await step("flow", async () => {
  const shops = (await db.query("SELECT id FROM shops WHERE company_id=$1 AND outlet_type IS NULL ORDER BY id", [cid])).rows;
  for (const [i, sh] of shops.entries()) await db.query("UPDATE shops SET outlet_type=$1 WHERE id=$2", [i % 2 ? "Medical" : "Grocery", sh.id]);
  if (!(await one(db, "SELECT k FROM company_kv WHERE company_id=$1 AND k='flow'", [cid]))) {
    const skus = (await db.query("SELECT v.sku FROM variants v JOIN items i ON i.id=v.item_id WHERE i.company_id=$1 ORDER BY v.id LIMIT 2", [cid])).rows.map((r: any) => r.sku);
    await kvSet(db, cid, "flow", cleanFlow({ mustSell: skus.length ? { Grocery: skus } : {}, announcements: [{ text: "Sample announcement: new season stock arrives next week" }] }, FLOW_DEFAULT));
  }
  const tpl = await one(db, "SELECT id, questions FROM audit_templates WHERE company_id=$1 AND name='Shelf check (sample)'", [cid]);
  if (tpl) { const qs = parseJson<any[]>(tpl.questions, []); const f = qs.find(q => q.key === "facings" && q.type === "number"); if (f && !f.target) { f.target = 12; await db.query("UPDATE audit_templates SET questions=$1 WHERE id=$2", [JSON.stringify(qs), tpl.id]); } }
  await db.query("UPDATE schemes SET budget=5000 WHERE id=(SELECT MIN(id) FROM schemes WHERE company_id=$1) AND budget IS NULL", [cid]);
  });
}
