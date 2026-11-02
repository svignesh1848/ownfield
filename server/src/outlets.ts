// New-outlet approval: a rep adds an outlet in the field (GPS required, photo optional) and it waits as "pending"
// until a manager above the rep (or an admin) approves or rejects it with a reason. Pending outlets cannot take
// orders unless the company allows it. Outlets created by admins/managers or uploaded are approved straight away.
// Company setting (default on): reps see only the outlets on their own beats plus the ones they added.
import crypto from "node:crypto";
import path from "node:path";
import type { Db } from "./db.js";
import { bad, getCompany, importOne } from "./catalog.js";
import { type Ctx, MGR, kvGet, kvSet } from "./common.js";
import { photoStore } from "./storage.js";
import { notify } from "./field.js";
import { teamIds, inTeam, assertTeam, managersOf } from "./hierarchy.js";

export const OUTLET_RULES_DEFAULT = { pendingCanOrder: false, repOwnBeatsOnly: true };
export const outletRules = (db: Db, cid: number) => kvGet(db, cid, "outletRules", OUTLET_RULES_DEFAULT);

/** SQL (" AND …") narrowing the shops a sales rep may see. uid is an integer from the signed token. */
export async function visibleShopSql(db: Db, cid: number, uid: number) {
  const r = await outletRules(db, cid), u = Number(uid) | 0;
  const notRejected = " AND COALESCE(approval_status,'approved')<>'rejected'";
  if (!r.repOwnBeatsOnly) return notRejected;
  return `${notRejected} AND (id IN (SELECT bs.shop_id FROM beat_shops bs JOIN beats b ON b.id=bs.beat_id WHERE b.company_id=${Number(cid) | 0} AND b.rep_id=${u}) OR added_by=${u} OR rep_id=${u} OR (COALESCE(approval_status,'approved')='approved' AND NOT EXISTS (SELECT 1 FROM beats b2 WHERE b2.company_id=${Number(cid) | 0} AND b2.rep_id=${u})))`; // a rep with no beats yet still sees approved outlets
}
/** Throws when an outlet may not take an order (pending without permission, or rejected). */
export async function assertCanOrder(db: Db, cid: number, shop: any) {
  const st = shop?.approval_status || "approved";
  if (st === "approved") return;
  if (st === "rejected") throw bad("This outlet was rejected and cannot take orders", 409);
  if (!(await outletRules(db, cid)).pendingCanOrder) throw bad("This outlet is waiting for approval and cannot take orders yet", 409);
}

const MAGIC: [string, (b: Buffer) => boolean][] = [["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8], ["image/png", b => b.subarray(0, 4).toString("hex") === "89504e47"],
  ["image/webp", b => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP"]];
/** Save an optional photo sent as a data URL (JSON, so it can wait in the offline queue). Max ~1 MB. */
export async function saveDataUrlPhoto(cid: number, v: unknown) {
  if (v == null || v === "") return null;
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(v)); if (!m) throw bad("photo must be a JPEG, PNG or WebP image");
  const buf = Buffer.from(m[1], "base64"); if (buf.length > Number(process.env.PHOTO_MAX_BYTES || 1024 * 1024)) throw bad("photo is too large (max 1 MB)");
  const mime = MAGIC.find(([, ok]) => ok(buf))?.[0]; if (!mime) throw bad("photo must be a JPEG, PNG or WebP image");
  const rel = path.join(String(cid), `${crypto.randomUUID()}.${mime.split("/")[1]}`);
  await photoStore().put(rel, buf, mime);
  return { file: rel, mime };
}

export function registerOutletApprovalRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/outlet-rules", auth(...MGR, "sales_rep"), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json(await outletRules(db, cid)); }));
  app.put("/api/outlet-rules", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const cur = await outletRules(db, cid), b = req.body || {};
    const v = { pendingCanOrder: b.pendingCanOrder !== undefined ? !!b.pendingCanOrder : cur.pendingCanOrder, repOwnBeatsOnly: b.repOwnBeatsOnly !== undefined ? !!b.repOwnBeatsOnly : cur.repOwnBeatsOnly };
    await kvSet(db, cid, "outletRules", v); res.json(v);
  }));

  // Rep adds an outlet (idempotent on clientRef so the offline queue can retry).
  app.post("/api/outlets/request", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const b = req.body || {}, ref = String(b.clientRef || "").trim().slice(0, 64);
    if (!ref) throw bad("clientRef required");
    const dup = (await db.query("SELECT * FROM shops WHERE company_id=$1 AND client_ref=$2 AND added_by=$3", [cid, ref, req.user.uid])).rows[0];
    if (dup) return res.status(200).json({ ...dup, duplicate: true });
    const lat = Number(b.lat), lng = Number(b.lng);
    if (b.lat == null || b.lng == null || b.lat === "" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw bad("GPS location is required to add an outlet");
    if (!String(b.name || "").trim()) throw bad("Name is required");
    const code = String(b.code || "").trim() || `NEW-${req.user.uid}-${crypto.createHash("sha1").update(ref).digest("hex").slice(0, 6).toUpperCase()}`;
    if ((await db.query("SELECT id FROM shops WHERE company_id=$1 AND code=$2", [cid, code])).rows[0]) throw bad(`an outlet with code ${code} already exists`, 409);
    const photo = await saveDataUrlPhoto(cid, b.photo);
    const { settings } = await getCompany(db, cid);
    const row: Record<string, unknown> = { code, name: String(b.name).trim() };
    for (const k of ["owner_name", "phone", "email", "gstin", "address", "city", "state", "pincode", "outlet_type", "channel"]) if (b[k] != null && b[k] !== "") row[k] = b[k];
    row.latitude = lat; row.longitude = lng;
    await importOne({ db, cid, s: settings, role: "company_admin", uid: req.user.uid, addUser: async () => { throw bad("not allowed"); } }, "shops", row);
    const shop = (await db.query("UPDATE shops SET updated_at=NOW(), approval_status='pending', added_by=$1, rep_id=$1, client_ref=$2, photo_file=$3, photo_mime=$4 WHERE company_id=$5 AND code=$6 RETURNING *",
      [req.user.uid, ref, photo?.file ?? null, photo?.mime ?? null, cid, code])).rows[0];
    const beat = b.beatId ? (await db.query("SELECT id FROM beats WHERE id=$1 AND company_id=$2 AND rep_id=$3", [Number(b.beatId), cid, req.user.uid])).rows[0] : null;
    if (beat) { const n = (await db.query("SELECT COALESCE(MAX(seq),0) AS n FROM beat_shops WHERE beat_id=$1", [beat.id])).rows[0].n; await db.query("INSERT INTO beat_shops (beat_id,shop_id,seq) VALUES ($1,$2,$3)", [beat.id, shop.id, Number(n) + 1]); }
    const ups = await managersOf(db, cid, req.user.uid);
    const approvers = ups.length ? ups.slice(0, 1) : (await db.query("SELECT id FROM users WHERE company_id=$1 AND role IN ('company_admin','manager') AND active", [cid])).rows.map((r: any) => r.id);
    for (const m of approvers) await notify(db, cid, m, "New outlet {0} needs your approval", [shop.name], null, "outletapprovals");
    res.status(201).json(shop);
  }));
  app.get("/api/outlets/mine", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id, code, name, city, approval_status, approval_reason, approved_at FROM shops WHERE company_id=$1 AND added_by=$2 ORDER BY id DESC", [cid, req.user.uid])).rows);
  }));
  app.get("/api/outlets/pending", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const st = ["pending", "approved", "rejected"].includes(String(req.query.status)) ? String(req.query.status) : "pending";
    const team = await teamIds(db, cid, req.user);
    res.json((await db.query(`SELECT s.id, s.code, s.name, s.owner_name, s.phone, s.address, s.city, s.pincode, s.gstin, s.outlet_type, s.lat, s.lng, s.approval_status, s.approval_reason, s.approved_at,
      (s.photo_file IS NOT NULL) AS has_photo, s.added_by, u.name AS added_by_name FROM shops s JOIN users u ON u.id=s.added_by
      WHERE s.company_id=$1 AND s.approval_status=$2${inTeam("s.added_by", team)} ORDER BY s.id DESC`, [cid, st])).rows);
  }));
  app.post("/api/outlets/:id/decision", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!s || !s.added_by) throw bad("outlet not found", 404);
    await assertTeam(db, cid, req.user, s.added_by);
    if (s.approval_status !== "pending") throw bad("this outlet is not waiting for approval", 409);
    const d = String(req.body?.decision || ""); if (!["approve", "reject"].includes(d)) throw bad("decision must be approve or reject");
    const reason = String(req.body?.reason || "").trim().slice(0, 300);
    if (d === "reject" && !reason) throw bad("tell the rep why the outlet was rejected");
    const to = d === "approve" ? "approved" : "rejected";
    const r = (await db.query("UPDATE shops SET updated_at=NOW(), approval_status=$1, approval_reason=$2, approved_by=$3, approved_at=NOW() WHERE id=$4 AND approval_status='pending' RETURNING *",
      [to, reason || null, req.user.uid, s.id])).rows[0];
    if (!r) throw bad("outlet changed meanwhile — reload", 409);
    await notify(db, cid, s.added_by, "Outlet {0}: {1}", [s.name, to], reason || null, "beat");
    res.json(r);
  }));
  app.get("/api/outlets/:id/photo", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = (await db.query("SELECT photo_file, photo_mime, added_by FROM shops WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!s?.photo_file || (req.user.role === "sales_rep" && s.added_by !== req.user.uid)) throw bad("photo not found", 404);
    if (req.user.role === "manager") await assertTeam(db, cid, req.user, s.added_by);
    res.type(s.photo_mime).send(await photoStore().get(s.photo_file));
  }));
}
