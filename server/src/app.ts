import express, { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import fs from "node:fs";
import type { Db } from "./db.js";
import { registerFieldRoutes } from "./field.js";
import { registerCatalogRoutes, parseJson } from "./catalog.js";
import { registerBillingRoutes } from "./billing.js";
import { registerInsightRoutes } from "./insights.js";
import { registerPurchaseRoutes } from "./purchase.js";
import { registerSchemeRoutes } from "./schemes.js";
import { registerCollectionRoutes } from "./collections.js";
import { registerEinvoiceRoutes } from "./einvoice.js";
import { registerAuditRoutes } from "./audits.js";
import { registerExpenseRoutes } from "./expenses.js";
import { registerLeaveRoutes } from "./leave.js";
import { registerIncentiveRoutes } from "./incentives.js";
import { getCompany } from "./catalog.js";
import { INDUSTRIES, templateSettings } from "./templates.js";
import { securityHeaders, tightCors, loginGuard, audit, errorHandler } from "./security.js";
import { registerAccountRoutes, newDeviceCheck, totpVerify } from "./accounts.js";
import { registerVanRoutes } from "./van.js";
import { registerFlowRoutes } from "./flow.js";
import { registerWorkdayRoutes } from "./workday.js";
import { registerInventoryRoutes } from "./inventory.js";
import { registerClaimRoutes } from "./claims.js";
import { registerLeadRoutes } from "./leads.js";
import { registerSurveyRoutes } from "./surveys.js";
import { registerMessagingRoutes } from "./messaging.js";
import { registerTrackingRoutes } from "./tracking.js";
import { registerCoverageRoutes } from "./coverage.js";
import { registerAiRoutes } from "./ai.js";
import { registerApiV1 } from "./integrations/api.js";
import { registerIntegrationRoutes, registerInbound } from "./integrations/admin.js";
import "./connectors/service.js";
import { diskStatus } from "./disk.js";
import { registerCustomReportRoutes } from "./reports/routes.js";
import { registerWorkspaceRoutes } from "./workspace/routes.js";
import { registerHierarchyRoutes, teamIds, inTeam, resolveReportsTo, resolveTerritory } from "./hierarchy.js";
import { registerReturnRoutes } from "./returns.js";
import { registerOutletApprovalRoutes, visibleShopSql } from "./outlets.js";
import { registerAccountRoutes2 } from "./account.js";

export const ROLES = ["platform_owner", "company_admin", "manager", "sales_rep", "distributor", "retailer"] as const;
export type Role = (typeof ROLES)[number];
export const PLATFORM_CODE = "PLATFORM";
type Claims = { uid: number; companyId: number | null; role: Role; tv?: number; enroll?: boolean };
type AuthReq = Request & { user: Claims };

export const FREE_PLAN_USER_LIMIT = Number(process.env.FREE_PLAN_USER_LIMIT || 5);
const CODE_RE = /^[A-Z0-9]{3,12}$/;
/** Password rule for self sign-up: 8+ chars with at least one letter and one number. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return "Password needs at least 8 characters";
  if (pw.length > 128) return "Password is too long";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password needs at least one letter and one number";
  return null;
}

export function usageInfo(count: number, limit: number) {
  const pct = limit > 0 ? Math.round((count / limit) * 100) : 100;
  return { count, limit, pct, warning: pct >= 80, atLimit: count >= limit };
}

export function createApp(db: Db, secret = process.env.JWT_SECRET || "dev-secret-change-me") {
  const app = express();
  app.set("trust proxy", 1); // one hop: nginx on the same box
  app.disable("x-powered-by");
  securityHeaders(app); tightCors(app);
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { if (req.url?.startsWith("/api/v1/inbound/")) (req as any).rawBody = buf; } }));
  const guard = loginGuard();
  const idleMs = () => Number(process.env.IDLE_LOGOUT_MIN || 60) * 60_000;
  const lastSeen = new Map<string, number>();

  const wrap = (fn: (req: AuthReq, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => fn(req as AuthReq, res).catch(next);

  // Every request re-checks the user row: disabled users and bumped token versions (password change) are rejected at once.
  const auth = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization || "";
    let c: Claims;
    try { c = jwt.verify(h.replace(/^Bearer /, ""), secret) as Claims; } catch { return res.status(401).json({ error: "unauthorized" }); }
    db.query("SELECT u.active, u.token_version, c.idle_minutes FROM users u LEFT JOIN companies c ON c.id=u.company_id WHERE u.id=$1", [c.uid]).then(r => {
      const u = r.rows[0];
      if (!u || !u.active || Number(u.token_version || 0) !== Number(c.tv || 0)) return res.status(401).json({ error: "Your session has ended. Please sign in again." });
      const key = `${c.uid}:${c.tv || 0}:${(c as any).iat}`, now = Date.now(), last = lastSeen.get(key);
      const idle = u.idle_minutes ? Number(u.idle_minutes) * 60_000 : idleMs();
      if (last && now - last > idle) { lastSeen.delete(key); return res.status(401).json({ error: "Signed out after inactivity. Please sign in again." }); }
      lastSeen.set(key, now); if (lastSeen.size > 5000) for (const [k, t] of lastSeen) if (now - t > idle) lastSeen.delete(k);
      if (c.enroll && !/^\/api\/me\/(totp|password)|^\/api\/me$/.test(req.path)) return res.status(403).json({ error: "Set up two-step sign-in first", enrollTotp: true });
      if (roles.length && !roles.includes(c.role)) return res.status(403).json({ error: "forbidden" });
      (req as AuthReq).user = c; next();
    }).catch(next);
  };
  const sign = (u: any, extra: object = {}) => jwt.sign({ uid: u.id, companyId: u.company_id, role: u.role, tv: Number(u.token_version || 0), ...extra }, secret, { expiresIn: "12h" });
  // Tenant guard: every company-scoped route requires a company id from the token.
  const tenant = (req: AuthReq, res: Response) => {
    if (req.user.companyId == null) { res.status(400).json({ error: "company-scoped route" }); return null; }
    return req.user.companyId;
  };

  async function companyUsage(companyId: number) {
    const c = (await db.query("SELECT user_limit FROM companies WHERE id=$1", [companyId])).rows[0];
    const n = (await db.query("SELECT COUNT(*) AS n FROM users WHERE company_id=$1 AND active=TRUE", [companyId])).rows[0];
    return usageInfo(Number(n.n), Number(c?.user_limit ?? 0));
  }

  async function addUser(companyId: number, u: any) {
    const role = String(u.role || "sales_rep").trim().toLowerCase().replace(/\s+/g, "_") as Role;
    if (!ROLES.includes(role) || role === "platform_owner") throw Object.assign(new Error(`invalid role ${role}`), { status: 400 });
    if (!u.email || !u.name || !u.password) throw Object.assign(new Error("email, name, password required"), { status: 400 });
    const usage = await companyUsage(companyId);
    if (usage.atLimit) throw Object.assign(new Error(`user limit reached (${usage.limit})`), { status: 409 });
    let shopId: number | null = null;
    if (role === "retailer") { // a retailer login is linked to exactly one outlet
      const code = String(u.shop_code ?? u.shopCode ?? u.outlet_code ?? "").trim();
      const sh = (await db.query(`SELECT id FROM shops WHERE company_id=$1 AND ${code ? "code=$2" : "id=$2"}`, [companyId, code || Number(u.shopId) || 0])).rows[0];
      if (!sh) throw Object.assign(new Error("retailer needs an outlet (shop code)"), { status: 400 });
      shopId = sh.id;
    }
    // Sales hierarchy (optional columns in the user upload): Reports To (email of the manager) and Territory (name).
    const rtRaw = u.reports_to ?? u.reportsTo ?? u.reports_to_email ?? u.manager_email;
    const reportsTo = await resolveReportsTo(db, companyId, null, rtRaw);
    const territoryId = await resolveTerritory(db, companyId, u.territory ?? u.territoryId ?? u.territory_id);
    const hash = await bcrypt.hash(String(u.password), 10);
    const r = await db.query(
      "INSERT INTO users (company_id,email,name,phone,role,password_hash,drug_licence,shop_id,reports_to,territory_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,email,name,role,shop_id,reports_to,territory_id",
      [companyId, String(u.email).toLowerCase().trim(), u.name, String(u.phone ?? "") || null, role, hash, String(u.drug_licence ?? "").trim() || null, shopId, reportsTo, territoryId]);
    return r.rows[0];
  }

  app.get("/api/health", (_q, res) => res.json({ ok: true }));
  // Low-disk warning for the admin dashboard (server-wide; company admins on self-hosted installs need it too).
  app.get("/api/system/disk", auth("platform_owner", "company_admin"), (_q, res) => {
    const d = diskStatus(); res.json(d ? { freePct: d.freePct, freeMB: Math.round(d.freeBytes / 1e6), alertPct: d.alertPct, low: d.low } : { low: false });
  });

  app.post("/api/auth/login", guard.ipLimiter, wrap(async (req, res) => {
    const { companyCode, email, password, totp, deviceId } = req.body || {};
    const code = String(companyCode || "").toUpperCase().trim(), mail = String(email || "").toLowerCase().trim();
    if (!code || !mail || !password) return res.status(400).json({ error: "Enter your company code, email and password" });
    const acct = `${code}|${mail}`, ip = req.ip || "?";
    const co = code === PLATFORM_CODE ? { id: null } : (await db.query("SELECT id FROM companies WHERE code=$1", [code])).rows[0];
    if (!co) return res.status(404).json({ error: "Company code not found. Check the code your administrator gave you." });
    if (guard.locked(acct)) { await audit(db, { companyId: co.id, action: "login.locked", target: acct, ip }); return res.status(429).json({ error: "Too many failed sign-ins. This account is locked for 15 minutes." }); }
    const rows = code === PLATFORM_CODE
      ? (await db.query("SELECT u.*, NULL AS code, FALSE AS require_totp, FALSE AS device_binding FROM users u WHERE u.company_id IS NULL AND u.email=$1 AND u.role='platform_owner'", [mail])).rows
      : (await db.query("SELECT u.*, c.code, c.require_totp, c.device_binding, c.idle_minutes FROM users u JOIN companies c ON c.id=u.company_id WHERE c.code=$1 AND u.email=$2 AND u.active=TRUE", [code, mail])).rows;
    const u = rows[0];
    const fail = async (why: string) => {
      const n = guard.failed(acct);
      await audit(db, { companyId: u?.company_id, userId: u?.id, action: "login.failed", target: acct, detail: { why, n }, ip });
      return res.status(401).json({ error: "Wrong email or password" });
    };
    if (!u || !(await bcrypt.compare(String(password), u.password_hash))) return fail("password");
    if (u.totp_enabled) {
      if (!totp) return res.status(401).json({ error: "Enter the 6-digit code from your authenticator app", totpRequired: true });
      if (!totpVerify(u.totp_secret, String(totp))) return fail("totp");
    }
    if (u.role === "retailer" && !(await getCompany(db, u.company_id)).settings.features.retailerApp) return res.status(403).json({ error: "The retailer app is turned off for this company. Please contact your supplier." });
    if (u.device_binding && u.role === "sales_rep") {
      const dev = String(deviceId || "").slice(0, 100);
      if (!dev) return res.status(400).json({ error: "This company requires a registered device. Please update the app." });
      if (!u.device_id) await db.query("UPDATE users SET device_id=$1 WHERE id=$2", [dev, u.id]);
      else if (u.device_id !== dev) { await audit(db, { companyId: u.company_id, userId: u.id, action: "login.device_blocked", target: mail, ip }); return res.status(403).json({ error: "This account is linked to another phone. Ask your administrator to reset the device." }); }
    }
    guard.succeeded(acct);
    const ua = String(req.headers["user-agent"] || "").slice(0, 200);
    await newDeviceCheck(db, u, ip, ua);
    await audit(db, { companyId: u.company_id, userId: u.id, action: "login.success", target: mail, detail: { ua }, ip });
    const enroll = !!u.require_totp && !u.totp_enabled;
    const token = sign(u, enroll ? { enroll: true } : {});
    res.json({ token, idleMinutes: Number(u.idle_minutes || process.env.IDLE_LOGOUT_MIN || 60), user: { id: u.id, name: u.name, email: u.email, role: u.role, companyCode: u.code }, ...(enroll ? { enrollTotp: true } : {}) });
  }));

  // ---- Public self sign-up (free plan) ----
  const signupHits = new Map<string, number[]>();
  const SIGNUP_MAX = Number(process.env.SIGNUP_RATE_MAX || 5), SIGNUP_WINDOW_MS = 60 * 60 * 1000;
  const signupLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || "?";
    const now = Date.now(), hits = (signupHits.get(ip) || []).filter(t => now - t < SIGNUP_WINDOW_MS);
    if (hits.length >= SIGNUP_MAX) return res.status(429).json({ error: "Too many sign-ups from this network. Please try again in an hour." });
    hits.push(now); signupHits.set(ip, hits); next();
  };
  const checkHits = new Map<string, number[]>();
  const signupCheckLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || "?";
    const now = Date.now(), hits = (checkHits.get(ip) || []).filter(t => now - t < 60000);
    if (hits.length >= 60) return res.status(429).json({ error: "Too many requests. Please wait a minute." });
    hits.push(now); checkHits.set(ip, hits); next();
  };
  const suggestCode = (name: string) => String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  app.get("/api/signup/check-code", signupCheckLimiter, wrap(async (req, res) => {
    let code = String(req.query.code || "").toUpperCase().trim() || suggestCode(String(req.query.name || ""));
    if (!code) return res.json({ code: "", available: false });
    const taken = async (c: string) => c === PLATFORM_CODE || !!(await db.query("SELECT id FROM companies WHERE code=$1", [c])).rows[0];
    const available = CODE_RE.test(code) && !(await taken(code));
    let suggestion = code;
    if (!available && CODE_RE.test(code.slice(0, 10))) for (let i = 2; i < 100; i++) { const c = code.slice(0, 10) + i; if (!(await taken(c))) { suggestion = c; break; } }
    res.json({ code, available, suggestion });
  }));
  app.post("/api/signup", signupLimiter, wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.companyName || "").trim(), code = String(b.companyCode || "").toUpperCase().trim();
    const industry = String(b.industry || "custom"), adminName = String(b.adminName || "").trim();
    const email = String(b.email || "").toLowerCase().trim(), password = String(b.password || "");
    if (b.website) return res.status(400).json({ error: "Sign-up failed" }); // honeypot
    if (b.consent !== true) return res.status(400).json({ field: "consent", error: "Please accept the privacy notice to continue" });
    if (name.length < 2 || name.length > 80) return res.status(400).json({ field: "companyName", error: "Enter your company name (2–80 letters)" });
    if (!CODE_RE.test(code) || code === PLATFORM_CODE) return res.status(400).json({ field: "companyCode", error: "Company code must be 3–12 letters or numbers, no spaces" });
    if (!(INDUSTRIES as readonly string[]).includes(industry)) return res.status(400).json({ field: "industry", error: "Pick a business type" });
    if (adminName.length < 2 || adminName.length > 80) return res.status(400).json({ field: "adminName", error: "Enter your name" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return res.status(400).json({ field: "email", error: "Enter a valid email, e.g. name@company.com" });
    const pwErr = passwordProblem(password); if (pwErr) return res.status(400).json({ field: "password", error: pwErr });
    if ((await db.query("SELECT id FROM companies WHERE code=$1", [code])).rows[0]) return res.status(409).json({ field: "companyCode", error: "This company code is taken. Try another." });
    if ((await db.query("SELECT u.id FROM users u WHERE u.email=$1 AND u.role='company_admin'", [email])).rows[0]) return res.status(409).json({ field: "email", error: "This email already runs a company. Sign in instead." });
    const c = (await db.query("INSERT INTO companies (code,name,user_limit,industry,settings) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [code, name, FREE_PLAN_USER_LIMIT, industry, JSON.stringify(templateSettings(industry))])).rows[0];
    const u = await addUser(c.id, { email, name: adminName, password, role: "company_admin" });
    await db.query("UPDATE users SET consent_at=NOW() WHERE id=$1", [u.id]);
    await audit(db, { companyId: c.id, userId: u.id, action: "signup", target: email, detail: { consent: true }, ip: req.ip });
    const token = sign({ ...u, company_id: c.id, token_version: 0 });
    res.status(201).json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, companyCode: c.code }, plan: { name: "free", userLimit: FREE_PLAN_USER_LIMIT } });
  }));

  // ---- Platform owner ----
  app.get("/api/platform/companies", auth("platform_owner"), wrap(async (_q, res) => {
    const rows = (await db.query(`SELECT c.id,c.code,c.name,c.industry,c.user_limit,COUNT(u.id) AS users FROM companies c
      LEFT JOIN users u ON u.company_id=c.id AND u.active=TRUE GROUP BY c.id,c.code,c.name,c.industry,c.user_limit ORDER BY c.id`)).rows;
    res.json(rows.map(r => ({ ...r, usage: usageInfo(Number(r.users), Number(r.user_limit)) })));
  }));
  app.post("/api/platform/companies", auth("platform_owner"), wrap(async (req, res) => {
    const { code, name, userLimit = 10, admin, industry = "custom" } = req.body || {};
    if (!code || !name || !admin) return res.status(400).json({ error: "code, name, admin required" });
    if (!(INDUSTRIES as readonly string[]).includes(industry)) return res.status(400).json({ error: "unknown industry" });
    const c = (await db.query("INSERT INTO companies (code,name,user_limit,industry,settings) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [String(code).toUpperCase(), name, Number(userLimit), industry, JSON.stringify(templateSettings(industry))])).rows[0];
    const a = await addUser(c.id, { ...admin, role: "company_admin" });
    await audit(db, { userId: req.user.uid, companyId: c.id, action: "platform.company_create", target: c.code, ip: req.ip });
    res.status(201).json({ company: c, admin: a });
  }));
  app.patch("/api/platform/companies/:id", auth("platform_owner"), wrap(async (req, res) => {
    const lim = Number(req.body?.userLimit);
    if (!Number.isInteger(lim) || lim < 1) return res.status(400).json({ error: "userLimit must be positive integer" });
    const r = await db.query("UPDATE companies SET user_limit=$1 WHERE id=$2 RETURNING *", [lim, Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: "not found" });
    await audit(db, { userId: req.user.uid, companyId: r.rows[0].id, action: "platform.user_limit", detail: { userLimit: lim }, ip: req.ip });
    res.json(r.rows[0]);
  }));

  // ---- Company scoped ----
  const anyCompanyRole = auth("company_admin", "manager", "sales_rep", "distributor", "retailer");
  app.get("/api/company/usage", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await companyUsage(cid));
  }));
  app.get("/api/users", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const team = await teamIds(db, cid, req.user); // managers with a team see their own people (plus distributors / retailers)
    res.json((await db.query(`SELECT id,email,name,phone,role,drug_licence,active,shop_id,reports_to,territory_id FROM users WHERE company_id=$1 ${team ? `AND (role IN ('distributor','retailer')${inTeam("id", team).replace(" AND", " OR")})` : ""} ORDER BY id`, [cid])).rows);
  }));
  app.post("/api/users", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const u = await addUser(cid, req.body || {});
    await audit(db, { companyId: cid, userId: req.user.uid, action: "user.create", target: u.email, detail: { role: u.role }, ip: req.ip });
    res.status(201).json({ user: u, usage: await companyUsage(cid) });
  }));
  app.get("/api/shops", anyCompanyRole, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    // Retailers see their own outlet; distributors see only the outlets mapped to them; reps see active outlets.
    // Reps see approved active outlets on their own beats plus the outlets they added (company setting, default on).
    const own = req.user.role === "retailer", dist = req.user.role === "distributor", rep = req.user.role === "sales_rep";
    const repSql = rep ? await visibleShopSql(db, cid, req.user.uid) : "";
    res.json((await db.query(`SELECT * FROM shops WHERE company_id=$1 ${own ? "AND id=(SELECT shop_id FROM users WHERE id=$2)" : dist ? "AND distributor_id=$2" : ""} ${rep ? `AND active=TRUE ${repSql}` : ""} ORDER BY name`, own || dist ? [cid, req.user.uid] : [cid])).rows.map(r => ({ ...r, custom: parseJson(r.custom, {}) })));
  }));
  registerCatalogRoutes({ app, db, auth, wrap, tenant, addUser, companyUsage });
  registerFieldRoutes({ app, db, auth, wrap, tenant });
  registerBillingRoutes({ app, db, auth, wrap, tenant });
  registerInsightRoutes({ app, db, auth, wrap, tenant });
  registerPurchaseRoutes({ app, db, auth, wrap, tenant });
  registerSchemeRoutes({ app, db, auth, wrap, tenant });
  registerCollectionRoutes({ app, db, auth, wrap, tenant });
  registerEinvoiceRoutes({ app, db, auth, wrap, tenant });
  registerAuditRoutes({ app, db, auth, wrap, tenant });
  registerExpenseRoutes({ app, db, auth, wrap, tenant });
  registerLeaveRoutes({ app, db, auth, wrap, tenant });
  registerIncentiveRoutes({ app, db, auth, wrap, tenant });
  registerAccountRoutes({ app, db, auth, wrap, tenant, guard });
  registerFlowRoutes({ app, db, auth, wrap, tenant });
  registerWorkdayRoutes({ app, db, auth, wrap, tenant });
  registerVanRoutes({ app, db, auth, wrap, tenant });
  registerInventoryRoutes({ app, db, auth, wrap, tenant });
  registerClaimRoutes({ app, db, auth, wrap, tenant });
  registerLeadRoutes({ app, db, auth, wrap, tenant });
  registerSurveyRoutes({ app, db, auth, wrap, tenant });
  registerMessagingRoutes({ app, db, auth, wrap, tenant });
  registerTrackingRoutes({ app, db, auth, wrap, tenant });
  registerCoverageRoutes({ app, db, auth, wrap, tenant });
  registerAiRoutes({ app, db, auth, wrap, tenant });
  registerIntegrationRoutes({ app, db, auth, wrap, tenant });
  registerCustomReportRoutes({ app, db, auth, wrap, tenant });
  registerWorkspaceRoutes({ app, db, auth, wrap, tenant });
  registerHierarchyRoutes({ app, db, auth, wrap, tenant });
  registerReturnRoutes({ app, db, auth, wrap, tenant });
  registerOutletApprovalRoutes({ app, db, auth, wrap, tenant });
  registerAccountRoutes2({ app, db, auth, wrap, tenant });
  registerInbound(app, db);
  registerApiV1(app, db);

  const webDir = process.env.WEB_DIR || path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/^(?!\/api).*/, (_q, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use("/api", (_q, res) => res.status(404).json({ error: "not found" }));
  app.use(errorHandler);
  return app;
}

export async function ensurePlatformOwner(db: Db, email: string, password: string) {
  const ex = (await db.query("SELECT id FROM users WHERE company_id IS NULL AND role='platform_owner'")).rows[0];
  if (ex) return;
  await db.query("INSERT INTO users (company_id,email,name,role,password_hash) VALUES (NULL,$1,'Platform Owner','platform_owner',$2)",
    [email.toLowerCase(), await bcrypt.hash(password, 10)]);
}
