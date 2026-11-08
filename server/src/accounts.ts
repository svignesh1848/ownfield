// Account security & privacy: user admin (disable, reset code, device reset, delete/anonymise), own password + TOTP,
// company security settings, audit log view, data export, company deletion.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import type { Db } from "./db.js";
import { audit, HitCounter } from "./security.js";
import { passwordProblem, PLATFORM_CODE } from "./app.js";

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) without extra dependencies ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const b32encode = (b: Buffer) => { let bits = "", out = ""; for (const x of b) bits += x.toString(2).padStart(8, "0"); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)]; return out; };
const b32decode = (s: string) => { let bits = ""; for (const ch of s.replace(/=+$/, "").toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); } const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
export function totpCode(secret: string, t = Date.now()) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(ctr).digest(); const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
export function totpVerify(secret: string | null, code: string) {
  if (!secret || !/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some(w => crypto.timingSafeEqual(Buffer.from(totpCode(secret, Date.now() + w * 30000)), Buffer.from(code)));
}

// ---- pluggable mailer: default none (admin hands over the code); set one with setMailer() ----
export type Mailer = (to: string, subject: string, text: string) => Promise<void>;
let mailer: Mailer | null = null;
export const setMailer = (m: Mailer | null) => { mailer = m; };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Log a login alert when a user signs in from an IP + device never seen before (and they have signed in before). */
export async function newDeviceCheck(db: Db, u: any, ip: string, ua: string) {
  const prev = (await db.query("SELECT ip, detail FROM security_audit_log WHERE user_id=$1 AND action='login.success' ORDER BY id DESC LIMIT 50", [u.id])).rows;
  if (!prev.length) return;
  if (prev.some(p => p.ip === ip && String(p.detail || "").includes(JSON.stringify(ua).slice(1, -1)))) return;
  await audit(db, { companyId: u.company_id, userId: u.id, action: "login.new_device", target: u.email, detail: { ua }, ip });
}

const EXPORT_TABLES = ["companies", "users", "shops", "items", "variants", "stock", "schemes", "beats", "visits", "orders", "invoices", "payments", "targets", "expenses", "leaves", "security_audit_log"];
const USER_COLS = "id,company_id,email,name,phone,role,drug_licence,active,shop_id,consent_at,totp_enabled";
const toCsv = (rows: any[]) => { if (!rows.length) return ""; const cols = Object.keys(rows[0]); const q = (v: unknown) => { const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return [cols.join(","), ...rows.map(r => cols.map(c => q(r[c])).join(","))].join("\n"); };

export function registerAccountRoutes({ app, db, auth, wrap, tenant }: any) {
  const admin = auth("company_admin");
  const own = async (cid: number, id: number) => (await db.query("SELECT * FROM users WHERE id=$1 AND company_id=$2", [id, cid])).rows[0];
  const log = (req: any, action: string, target?: string, detail?: unknown) => audit(db, { companyId: req.user.companyId, userId: req.user.uid, action, target, detail, ip: req.ip });

  app.get("/api/me", auth(), wrap(async (req: any, res: any) => {
    res.json((await db.query("SELECT id,email,name,role,totp_enabled FROM users WHERE id=$1", [req.user.uid])).rows[0]);
  }));
  app.post("/api/me/password", auth(), wrap(async (req: any, res: any) => {
    const { current, password } = req.body || {};
    const u = (await db.query("SELECT * FROM users WHERE id=$1", [req.user.uid])).rows[0];
    if (!(await bcrypt.compare(String(current || ""), u.password_hash))) return res.status(400).json({ error: "Current password is wrong" });
    const p = passwordProblem(String(password || "")); if (p) return res.status(400).json({ error: p });
    await db.query("UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2", [await bcrypt.hash(String(password), 10), u.id]);
    await log(req, "user.password_change", u.email); res.json({ ok: true, signInAgain: true });
  }));
  // TOTP enrolment: setup -> confirm with a code -> enabled. Disabling needs a current code.
  app.post("/api/me/totp/setup", auth(), wrap(async (req: any, res: any) => {
    const u = (await db.query("SELECT email, totp_enabled FROM users WHERE id=$1", [req.user.uid])).rows[0];
    if (u.totp_enabled) return res.status(409).json({ error: "Two-step sign-in is already on" });
    const secret = b32encode(crypto.randomBytes(20));
    await db.query("UPDATE users SET totp_secret=$1 WHERE id=$2", [secret, req.user.uid]);
    const uri = `otpauth://totp/OwnField:${encodeURIComponent(u.email)}?secret=${secret}&issuer=OwnField`;
    res.json({ secret, uri, qr: await QRCode.toDataURL(uri) });
  }));
  app.post("/api/me/totp/enable", auth(), wrap(async (req: any, res: any) => {
    const u = (await db.query("SELECT * FROM users WHERE id=$1", [req.user.uid])).rows[0];
    if (!totpVerify(u.totp_secret, String(req.body?.code || ""))) return res.status(400).json({ error: "That code did not match. Try the newest code." });
    await db.query("UPDATE users SET totp_enabled=TRUE, token_version=token_version+1 WHERE id=$1", [u.id]);
    await log(req, "user.totp_enabled", u.email); res.json({ ok: true, signInAgain: true });
  }));
  app.post("/api/me/totp/disable", auth(), wrap(async (req: any, res: any) => {
    const u = (await db.query("SELECT u.*, c.require_totp FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.id=$1", [req.user.uid])).rows[0];
    if (u.require_totp) return res.status(403).json({ error: "Your company requires two-step sign-in" });
    if (!totpVerify(u.totp_secret, String(req.body?.code || ""))) return res.status(400).json({ error: "That code did not match" });
    await db.query("UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=$1", [u.id]);
    await log(req, "user.totp_disabled", u.email); res.json({ ok: true });
  }));

  // ---- admin: user management ----
  app.patch("/api/users/:id", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const u = await own(cid, Number(req.params.id)); if (!u) return res.status(404).json({ error: "not found" });
    const b = req.body || {}, changes: Record<string, unknown> = {};
    if (typeof b.active === "boolean") {
      if (u.id === req.user.uid && !b.active) return res.status(400).json({ error: "You cannot disable yourself" });
      await db.query("UPDATE users SET active=$1, token_version=token_version+1 WHERE id=$2", [b.active, u.id]); changes.active = b.active;
    }
    if (b.password) {
      const p = passwordProblem(String(b.password)); if (p) return res.status(400).json({ error: p });
      await db.query("UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2", [await bcrypt.hash(String(b.password), 10), u.id]); changes.password = "changed";
    }
    if (b.resetTotp) { await db.query("UPDATE users SET totp_enabled=FALSE, totp_secret=NULL, token_version=token_version+1 WHERE id=$1", [u.id]); changes.totp = "reset"; }
    if (b.resetDevice) { await db.query("UPDATE users SET device_id=NULL WHERE id=$1", [u.id]); changes.device = "reset"; }
    await log(req, "user.update", u.email, changes);
    res.json((await db.query(`SELECT ${USER_COLS} FROM users WHERE id=$1`, [u.id])).rows[0]);
  }));
  // One-time reset code (30 min). Shown to the admin; also mailed if a mailer is plugged in.
  app.post("/api/users/:id/reset-code", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const u = await own(cid, Number(req.params.id)); if (!u) return res.status(404).json({ error: "not found" });
    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    await db.query("UPDATE users SET reset_hash=$1, reset_expires=$2 WHERE id=$3", [sha(code), new Date(Date.now() + 30 * 60_000), u.id]);
    const company = (await db.query("SELECT code FROM companies WHERE id=$1", [cid])).rows[0].code;
    const link = `/?reset=${code}&company=${company}&email=${encodeURIComponent(u.email)}`;
    let mailed = false;
    if (mailer) { try { await mailer(u.email, "Reset your OwnField password", `Use code ${code} within 30 minutes, or open ${link}`); mailed = true; } catch (e: any) { console.error("mailer failed:", e.message); } }
    await log(req, "user.reset_code", u.email, { mailed });
    res.json({ code, link, expiresInMin: 30, mailed });
  }));
  const resetHits = new HitCounter(Number(process.env.RESET_MAX || 10), 15 * 60_000);
  app.post("/api/auth/reset", wrap(async (req: any, res: any) => {
    const { companyCode, email, code, password } = req.body || {};
    const rk = `${String(companyCode || "").toUpperCase().trim()}|${String(email || "").toLowerCase().trim()}`;
    if (resetHits.hit("ip:" + (req.ip || "?")) > resetHits.max || resetHits.hit("acct:" + rk) > resetHits.max) return res.status(429).json({ error: "Too many attempts. Please wait 15 minutes and try again." });
    const cc = String(companyCode || "").toUpperCase().trim();
    const bad = () => res.status(400).json({ error: "This reset code is not valid or has expired. Ask your administrator for a new one." });
    if (!code || cc === PLATFORM_CODE) return bad();
    const u = (await db.query("SELECT u.* FROM users u JOIN companies c ON c.id=u.company_id WHERE c.code=$1 AND u.email=$2", [cc, String(email || "").toLowerCase().trim()])).rows[0];
    if (!u || !u.reset_hash || !u.reset_expires || new Date(u.reset_expires).getTime() < Date.now() || u.reset_hash !== sha(String(code).toUpperCase().trim())) return bad();
    const p = passwordProblem(String(password || "")); if (p) return res.status(400).json({ error: p });
    await db.query("UPDATE users SET password_hash=$1, reset_hash=NULL, reset_expires=NULL, token_version=token_version+1 WHERE id=$2", [await bcrypt.hash(String(password), 10), u.id]);
    await audit(db, { companyId: u.company_id, userId: u.id, action: "user.password_reset", target: u.email, ip: req.ip });
    res.json({ ok: true });
  }));
  // Delete = anonymise personal data and disable (order/invoice history stays valid).
  app.delete("/api/users/:id", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const u = await own(cid, Number(req.params.id)); if (!u) return res.status(404).json({ error: "not found" });
    if (u.id === req.user.uid) return res.status(400).json({ error: "You cannot delete yourself" });
    await anonymiseUser(db, u.id);
    await log(req, "user.delete", `user#${u.id}`); res.json({ ok: true });
  }));

  // ---- admin: company security settings ----
  app.get("/api/company/security", auth("company_admin", "manager"), wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = (await db.query("SELECT require_totp, device_binding, idle_minutes FROM companies WHERE id=$1", [cid])).rows[0];
    res.json({ requireTotp: !!c.require_totp, deviceBinding: !!c.device_binding, idleMinutes: c.idle_minutes ?? Number(process.env.IDLE_LOGOUT_MIN || 60) });
  }));
  app.put("/api/company/security", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const b = req.body || {}, idle = Number(b.idleMinutes);
    if (!Number.isInteger(idle) || idle < 5 || idle > 720) return res.status(400).json({ error: "Idle time must be 5–720 minutes" });
    await db.query("UPDATE companies SET require_totp=$1, device_binding=$2, idle_minutes=$3 WHERE id=$4", [!!b.requireTotp, !!b.deviceBinding, idle, cid]);
    await log(req, "company.security", undefined, { requireTotp: !!b.requireTotp, deviceBinding: !!b.deviceBinding, idleMinutes: idle });
    res.json({ requireTotp: !!b.requireTotp, deviceBinding: !!b.deviceBinding, idleMinutes: idle });
  }));

  // ---- admin: audit log ----
  app.get("/api/audit-log", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const alerts = req.query.alerts === "1";
    res.json((await db.query(`SELECT l.id,l.at,l.action,l.target,l.detail,l.ip,u.name AS by_user FROM security_audit_log l LEFT JOIN users u ON u.id=l.user_id
      WHERE l.company_id=$1 ${alerts ? "AND l.action IN ('login.new_device','login.locked','login.device_blocked','login.failed')" : ""} ORDER BY l.id DESC LIMIT 300`, [cid])).rows);
  }));

  // ---- DPDP: export and delete ----
  app.get("/api/company/export", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const one = async (t: string) => t === "users" ? (await db.query(`SELECT ${USER_COLS} FROM users WHERE company_id=$1 ORDER BY id`, [cid])).rows
      : t === "companies" ? (await db.query("SELECT id,code,name,industry,user_limit,created_at FROM companies WHERE id=$1", [cid])).rows
      : (await db.query(`SELECT * FROM ${t} WHERE company_id=$1 ORDER BY id`, [cid])).rows;
    await log(req, "company.export", String(req.query.table || "all"));
    if (req.query.format === "csv") {
      const t = String(req.query.table || "users"); if (!EXPORT_TABLES.includes(t)) return res.status(400).json({ error: "unknown table" });
      return res.type("text/csv").attachment(`${t}.csv`).send(toCsv(await one(t)));
    }
    const out: Record<string, unknown[]> = {}; for (const t of EXPORT_TABLES) out[t] = await one(t);
    res.attachment("company-export.json").json(out);
  }));
  app.delete("/api/company", admin, wrap(async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = (await db.query("SELECT code FROM companies WHERE id=$1", [cid])).rows[0];
    if (String(req.body?.confirm || "").toUpperCase() !== c.code) return res.status(400).json({ error: "Type your company code to confirm" });
    for (const u of (await db.query("SELECT id FROM users WHERE company_id=$1", [cid])).rows) await anonymiseUser(db, u.id);
    await db.query("UPDATE shops SET updated_at=NOW(), owner_name=NULL, phone=NULL, address=NULL, gstin=NULL, drug_licence=NULL, custom=NULL WHERE company_id=$1", [cid]);
    await db.query("UPDATE companies SET name='Deleted company', code=$1, user_limit=0 WHERE id=$2", [`DEL${cid}X`, cid]);
    await db.query("UPDATE security_audit_log SET ip=NULL, detail=NULL, target=NULL WHERE company_id=$1", [cid]);
    await log(req, "company.delete", `company#${cid}`); res.json({ ok: true });
  }));
}

export async function anonymiseUser(db: Db, id: number) {
  await db.query(`UPDATE users SET name='Deleted user', email=$1, phone=NULL, drug_licence=NULL, active=FALSE, totp_secret=NULL, totp_enabled=FALSE,
    device_id=NULL, reset_hash=NULL, password_hash=$2, token_version=token_version+1 WHERE id=$3`, [`deleted-${id}@invalid`, await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 4), id]);
  await db.query("UPDATE security_audit_log SET ip=NULL, detail=NULL, target=NULL WHERE user_id=$1", [id]);
}
