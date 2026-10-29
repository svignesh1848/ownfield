// Start/End Day for reps (GPS, optional selfie) and the retailer home summary (active schemes, outstanding, announcements).
import { bad, getCompany, today } from "./catalog.js";
import { type Ctx, MGR, dateOk } from "./common.js";
import { smallUpload, savePhoto, readPhoto } from "./photos.js";
import { getFlow } from "./flow.js";
import { outstanding } from "./collections.js";
import { describeScheme } from "./schemes.js";
import type { Db } from "./db.js";

const gps = (lat: unknown, lng: unknown) => {
  const a = Number(lat), b = Number(lng);
  if (lat == null || lng == null || lat === "" || lng === "" || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) throw bad("Turn on location (GPS) to start or end your day");
  return [a, b];
};
/** When the Start Day rule is on, a rep must have started (and not ended) today before visiting outlets. */
export async function dayOpenCheck(db: Db, cid: number, uid: number) {
  if (!(await getFlow(db, cid)).dayStart) return;
  const d = (await db.query("SELECT * FROM rep_days WHERE rep_id=$1 AND day=$2", [uid, today()])).rows[0];
  if (!d) throw bad("Start your day first", 409);
  if (d.end_at) throw bad("Your day has ended", 409);
}

export function registerWorkdayRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/day", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const day = dateOk(req.query.date) ? String(req.query.date) : today();
    const rep = req.user.role === "sales_rep";
    const rows = (await db.query(`SELECT d.id, d.rep_id, u.name AS rep_name, d.day, d.start_at, d.start_lat, d.start_lng, d.end_at, d.end_lat, d.end_lng, (d.selfie_file IS NOT NULL) AS has_selfie
      FROM rep_days d JOIN users u ON u.id=d.rep_id WHERE d.company_id=$1 AND d.day=$2 ${rep ? "AND d.rep_id=$3" : ""} ORDER BY u.name`, rep ? [cid, day, req.user.uid] : [cid, day])).rows;
    const f = await getFlow(db, cid);
    res.json(rep ? { on: f.dayStart, selfie: f.selfie, today: rows[0] ?? null } : { on: f.dayStart, day, rows });
  }));
  app.post("/api/day/start", auth("sales_rep"), smallUpload.single("photo"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const f = await getFlow(db, cid); if (!f.dayStart) throw bad("Start/End Day is turned off", 409);
    const [lat, lng] = gps(req.body?.lat, req.body?.lng);
    if ((await db.query("SELECT id FROM rep_days WHERE rep_id=$1 AND day=$2", [req.user.uid, today()])).rows[0]) throw bad("You already started today", 409);
    const p = f.selfie && req.file ? savePhoto(cid, req.file) : null;
    res.status(201).json((await db.query(`INSERT INTO rep_days (company_id,rep_id,day,start_at,start_lat,start_lng,selfie_file,selfie_mime) VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7)
      RETURNING id, day, start_at, start_lat, start_lng`, [cid, req.user.uid, today(), lat, lng, p?.file ?? null, p?.mime ?? null])).rows[0]);
  }));
  app.post("/api/day/end", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const [lat, lng] = gps(req.body?.lat, req.body?.lng);
    const d = (await db.query("SELECT * FROM rep_days WHERE rep_id=$1 AND day=$2", [req.user.uid, today()])).rows[0];
    if (!d) throw bad("Start your day first", 409); if (d.end_at) throw bad("Your day has ended", 409);
    if ((await db.query("SELECT id FROM visits WHERE rep_id=$1 AND check_out_at IS NULL", [req.user.uid])).rows[0]) throw bad("check out of the current visit first", 409);
    res.json((await db.query("UPDATE rep_days SET end_at=NOW(), end_lat=$1, end_lng=$2 WHERE id=$3 RETURNING id, day, start_at, end_at", [lat, lng, d.id])).rows[0]);
  }));
  app.get("/api/day/:id/selfie", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rep = req.user.role === "sales_rep";
    const d = (await db.query(`SELECT * FROM rep_days WHERE id=$1 AND company_id=$2 ${rep ? "AND rep_id=$3" : ""}`, rep ? [Number(req.params.id), cid, req.user.uid] : [Number(req.params.id), cid])).rows[0];
    if (!d?.selfie_file) throw bad("photo not found", 404);
    res.type(d.selfie_mime).set("Cache-Control", "private, max-age=86400").send(readPhoto(d.selfie_file));
  }));

  // Retailer home: what's on offer, what they owe, and company announcements.
  app.get("/api/retailer/home", auth("retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid); if (!settings.features.retailerApp) throw bad("the retailer app is turned off for this company", 403);
    const shop = (await db.query("SELECT s.id, s.distributor_id FROM users u JOIN shops s ON s.id=u.shop_id WHERE u.id=$1 AND u.company_id=$2", [req.user.uid, cid])).rows[0];
    if (!shop) throw bad("retailer needs an outlet (shop code)", 400);
    const t = today();
    const schemes = (await db.query("SELECT s.*, i.name AS item_name FROM schemes s LEFT JOIN items i ON i.id=s.item_id WHERE s.company_id=$1 AND s.active=TRUE ORDER BY s.id", [cid])).rows
      .filter((s: any) => (!s.starts_on || s.starts_on <= t) && (!s.ends_on || s.ends_on >= t) && (s.distributor_id == null || s.distributor_id === shop.distributor_id))
      .map((s: any) => ({ id: s.id, name: s.name, rule: describeScheme(s), ends_on: s.ends_on }));
    const out = settings.features.invoicing ? await outstanding(db, cid, { shopId: shop.id }) : [];
    const f = await getFlow(db, cid);
    res.json({ schemes, outstanding: Math.round(out.reduce((a, r) => a + r.outstanding, 0) * 100) / 100,
      announcements: f.announcements.filter(a => !a.until || a.until >= t) });
  }));
}
