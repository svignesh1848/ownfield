// Location trail during working hours, distance travelled, and a geofenced check-in radius per outlet.
// Lean by design: the app sends a ping every few minutes only while it is open; points closer than 25 m to the
// previous one, poor-accuracy fixes and pings outside working hours are dropped; trails are kept 30 days.
import type { Db } from "./db.js";
import { bad } from "./catalog.js";
import { type Ctx, MGR, requireFeature, kvGet, kvSet, dateOk } from "./common.js";
import { dayKey } from "./field.js";

export type TrackCfg = { start: string; end: string; intervalSec: number; radiusM: number; enforceRadius: boolean };
export const TRACK_DEFAULT: TrackCfg = { start: "09:00", end: "19:00", intervalSec: 180, radiusM: 200, enforceRadius: true };
export const trackCfg = (db: Db, cid: number) => kvGet<TrackCfg>(db, cid, "tracking", TRACK_DEFAULT);
/** Great-circle distance in metres. */
export function metres(a: [number, number], b: [number, number]) {
  const R = 6371000, r = (x: number) => x * Math.PI / 180, dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hhmm = (d: Date, tz = process.env.REPORT_TZ || "Asia/Kolkata") => d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
export const inHours = (c: TrackCfg, d: Date) => { const t = hhmm(d); return t >= c.start && t <= c.end; };

/** Check-in geofence. Throws when the rep is too far; pins the outlet location on the first check-in that has GPS. */
export async function geofenceCheck(db: Db, cid: number, shopId: number, lat: number | null, lng: number | null) {
  const { settings } = await (await import("./catalog.js")).getCompany(db, cid);
  if (!settings.features.tracking || lat == null || lng == null) return;
  const shop = (await db.query("SELECT lat, lng, geofence_m FROM shops WHERE id=$1", [shopId])).rows[0];
  if (shop?.lat == null || shop?.lng == null) { await db.query("UPDATE shops SET lat=$1, lng=$2 WHERE id=$3", [lat, lng, shopId]); return; }
  const c = await trackCfg(db, cid); if (!c.enforceRadius) return;
  const limit = Number(shop.geofence_m) || c.radiusM, d = Math.round(metres([Number(shop.lat), Number(shop.lng)], [lat, lng]));
  if (d > limit) throw Object.assign(bad(`You are ${d} m from this outlet. Check in within ${limit} m.`, 409), { distance: d });
}

export function registerTrackingRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/track/settings", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "tracking"); res.json(await trackCfg(db, cid));
  }));
  app.put("/api/track/settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "tracking");
    const b = req.body || {}, cur = await trackCfg(db, cid), tm = /^([01]\d|2[0-3]):[0-5]\d$/;
    const next: TrackCfg = { start: tm.test(b.start) ? b.start : cur.start, end: tm.test(b.end) ? b.end : cur.end,
      intervalSec: Math.min(900, Math.max(60, Number(b.intervalSec) || cur.intervalSec)), radiusM: Math.min(5000, Math.max(25, Number(b.radiusM) || cur.radiusM)),
      enforceRadius: typeof b.enforceRadius === "boolean" ? b.enforceRadius : cur.enforceRadius };
    if (next.end <= next.start) throw bad("working hours must end after they start");
    await kvSet(db, cid, "tracking", next); res.json(next);
  }));
  app.post("/api/track/pings", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "tracking");
    const c = await trackCfg(db, cid), pts = (Array.isArray(req.body?.points) ? req.body.points : []).slice(0, 100);
    let last = (await db.query("SELECT lat, lng, at FROM location_pings WHERE company_id=$1 AND user_id=$2 ORDER BY at DESC LIMIT 1", [cid, req.user.uid])).rows[0];
    let kept = 0; const now = Date.now();
    for (const p of pts.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at))) {
      const at = new Date(p.at), lat = Number(p.lat), lng = Number(p.lng), acc = p.acc == null ? null : Number(p.acc);
      if (isNaN(+at) || +at > now + 60_000 || +at < now - 2 * 864e5 || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) continue;
      if (acc != null && acc > 150) continue;
      if (!inHours(c, at)) continue;
      if (last && metres([Number(last.lat), Number(last.lng)], [lat, lng]) < 25) continue;
      await db.query("INSERT INTO location_pings (company_id,user_id,at,lat,lng,acc) VALUES ($1,$2,$3,$4,$5,$6)", [cid, req.user.uid, at.toISOString(), lat, lng, acc]);
      last = { lat, lng, at }; kept++;
    }
    if (Math.random() < 0.02) await db.query("DELETE FROM location_pings WHERE company_id=$1 AND at < $2", [cid, new Date(now - 30 * 864e5).toISOString()]);
    res.json({ received: pts.length, kept });
  }));
  app.get("/api/track", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "tracking");
    const rep = req.user.role === "sales_rep" ? req.user.uid : Number(req.query.repId), day = String(req.query.day || dayKey(new Date()));
    if (!dateOk(day)) throw bad("pick a day");
    const from = new Date(Date.parse(day + "T00:00:00+05:30")), to = new Date(+from + 864e5);
    const pts = (await db.query("SELECT at, lat, lng, acc FROM location_pings WHERE company_id=$1 AND user_id=$2 AND at>=$3 AND at<$4 ORDER BY at", [cid, rep, from.toISOString(), to.toISOString()])).rows
      .map(p => ({ at: p.at, lat: Number(p.lat), lng: Number(p.lng), acc: p.acc == null ? null : Number(p.acc) }));
    let m = 0; for (let i = 1; i < pts.length; i++) m += metres([pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng]);
    const visits = (await db.query("SELECT v.check_in_at, v.in_lat, v.in_lng, s.name FROM visits v JOIN shops s ON s.id=v.shop_id WHERE v.company_id=$1 AND v.rep_id=$2 AND v.check_in_at>=$3 AND v.check_in_at<$4 ORDER BY v.check_in_at", [cid, rep, from.toISOString(), to.toISOString()])).rows;
    res.json({ rep_id: rep, day, points: pts, distance_km: Math.round(m / 10) / 100, first: pts[0]?.at ?? null, last: pts[pts.length - 1]?.at ?? null, visits });
  }));
  app.put("/api/shops/:id/geofence", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "tracking");
    const b = req.body || {}, r = b.radiusM == null || b.radiusM === "" ? null : Math.min(5000, Math.max(25, Number(b.radiusM)));
    const lat = b.lat == null || b.lat === "" ? null : Number(b.lat), lng = b.lng == null || b.lng === "" ? null : Number(b.lng);
    if ((lat != null && !(Math.abs(lat) <= 90)) || (lng != null && !(Math.abs(lng) <= 180))) throw bad("invalid coordinates");
    const s = (await db.query("UPDATE shops SET lat=$1, lng=$2, geofence_m=$3 WHERE id=$4 AND company_id=$5 RETURNING id, lat, lng, geofence_m", [lat, lng, r, Number(req.params.id), cid])).rows[0];
    if (!s) throw bad("shop not found", 404); res.json(s);
  }));
}
