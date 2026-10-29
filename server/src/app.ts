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
import { INDUSTRIES, templateSettings } from "./templates.js";

export const ROLES = ["platform_owner", "company_admin", "manager", "sales_rep", "distributor"] as const;
export type Role = (typeof ROLES)[number];
export const PLATFORM_CODE = "PLATFORM";
type Claims = { uid: number; companyId: number | null; role: Role };
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
  app.use(express.json());

  const wrap = (fn: (req: AuthReq, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => fn(req as AuthReq, res).catch(next);

  const auth = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization || "";
    try {
      const c = jwt.verify(h.replace(/^Bearer /, ""), secret) as Claims;
      if (roles.length && !roles.includes(c.role)) return res.status(403).json({ error: "forbidden" });
      (req as AuthReq).user = c; next();
    } catch { res.status(401).json({ error: "unauthorized" }); }
  };
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
    const hash = await bcrypt.hash(String(u.password), 10);
    const r = await db.query(
      "INSERT INTO users (company_id,email,name,phone,role,password_hash,drug_licence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,email,name,role",
      [companyId, String(u.email).toLowerCase().trim(), u.name, String(u.phone ?? "") || null, role, hash, String(u.drug_licence ?? "").trim() || null]);
    return r.rows[0];
  }

  app.get("/api/health", (_q, res) => res.json({ ok: true }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    const { companyCode, email, password } = req.body || {};
    const code = String(companyCode || "").toUpperCase().trim();
    if (!code || !email || !password) return res.status(400).json({ error: "Enter your company code, email and password" });
    if (code !== PLATFORM_CODE && !(await db.query("SELECT id FROM companies WHERE code=$1", [code])).rows[0])
      return res.status(404).json({ error: "Company code not found. Check the code your administrator gave you." });
    const rows = code === PLATFORM_CODE
      ? (await db.query("SELECT u.*, NULL AS code FROM users u WHERE u.company_id IS NULL AND u.email=$1 AND u.role='platform_owner'", [String(email).toLowerCase()])).rows
      : (await db.query("SELECT u.*, c.code FROM users u JOIN companies c ON c.id=u.company_id WHERE c.code=$1 AND u.email=$2 AND u.active=TRUE", [code, String(email).toLowerCase()])).rows;
    const u = rows[0];
    if (!u || !(await bcrypt.compare(String(password), u.password_hash))) return res.status(401).json({ error: "Wrong email or password" });
    const token = jwt.sign({ uid: u.id, companyId: u.company_id, role: u.role }, secret, { expiresIn: "12h" });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, companyCode: u.code } });
  }));

  // ---- Public self sign-up (free plan) ----
  const signupHits = new Map<string, number[]>();
  const SIGNUP_MAX = Number(process.env.SIGNUP_RATE_MAX || 5), SIGNUP_WINDOW_MS = 60 * 60 * 1000;
  const signupLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",").pop()!.trim() || req.ip || "?";
    const now = Date.now(), hits = (signupHits.get(ip) || []).filter(t => now - t < SIGNUP_WINDOW_MS);
    if (hits.length >= SIGNUP_MAX) return res.status(429).json({ error: "Too many sign-ups from this network. Please try again in an hour." });
    hits.push(now); signupHits.set(ip, hits); next();
  };
  const checkHits = new Map<string, number[]>();
  const signupCheckLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = String(req.headers["x-forwarded-for"] || "").split(",").pop()!.trim() || req.ip || "?";
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
    const token = jwt.sign({ uid: u.id, companyId: c.id, role: "company_admin" }, secret, { expiresIn: "12h" });
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
    res.status(201).json({ company: c, admin: a });
  }));
  app.patch("/api/platform/companies/:id", auth("platform_owner"), wrap(async (req, res) => {
    const lim = Number(req.body?.userLimit);
    if (!Number.isInteger(lim) || lim < 1) return res.status(400).json({ error: "userLimit must be positive integer" });
    const r = await db.query("UPDATE companies SET user_limit=$1 WHERE id=$2 RETURNING *", [lim, Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: "not found" });
    res.json(r.rows[0]);
  }));

  // ---- Company scoped ----
  const anyCompanyRole = auth("company_admin", "manager", "sales_rep", "distributor");
  app.get("/api/company/usage", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await companyUsage(cid));
  }));
  app.get("/api/users", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id,email,name,phone,role,drug_licence,active FROM users WHERE company_id=$1 ORDER BY id", [cid])).rows);
  }));
  app.post("/api/users", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const u = await addUser(cid, req.body || {});
    res.status(201).json({ user: u, usage: await companyUsage(cid) });
  }));
  app.get("/api/shops", anyCompanyRole, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT * FROM shops WHERE company_id=$1 ORDER BY name", [cid])).rows.map(r => ({ ...r, custom: parseJson(r.custom, {}) })));
  }));
  registerCatalogRoutes({ app, db, auth, wrap, tenant, addUser, companyUsage });
  registerFieldRoutes({ app, db, auth, wrap, tenant });
  registerBillingRoutes({ app, db, auth, wrap, tenant });
  registerInsightRoutes({ app, db, auth, wrap, tenant });
  registerPurchaseRoutes({ app, db, auth, wrap, tenant });
  registerSchemeRoutes({ app, db, auth, wrap, tenant });
  registerCollectionRoutes({ app, db, auth, wrap, tenant });
  registerEinvoiceRoutes({ app, db, auth, wrap, tenant });

  const webDir = process.env.WEB_DIR || path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/^(?!\/api).*/, (_q, res) => res.sendFile(path.join(webDir, "index.html")));
  }

  app.use((err: any, _q: Request, res: Response, _n: NextFunction) => {
    const dup = err.code === "23505" || /duplicate|unique/i.test(err.message || "");
    res.status(err.status || (dup ? 409 : 500)).json({ error: dup ? "already exists" : err.message });
  });
  return app;
}

export async function ensurePlatformOwner(db: Db, email: string, password: string) {
  const ex = (await db.query("SELECT id FROM users WHERE company_id IS NULL AND role='platform_owner'")).rows[0];
  if (ex) return;
  await db.query("INSERT INTO users (company_id,email,name,role,password_hash) VALUES (NULL,$1,'Platform Owner','platform_owner',$2)",
    [email.toLowerCase(), await bcrypt.hash(password, 10)]);
}
