import express, { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import fs from "node:fs";
import type { Db } from "./db.js";
import { registerFieldRoutes } from "./field.js";
import { registerCatalogRoutes, parseJson } from "./catalog.js";
import { INDUSTRIES, templateSettings } from "./templates.js";

export const ROLES = ["platform_owner", "company_admin", "manager", "sales_rep", "distributor"] as const;
export type Role = (typeof ROLES)[number];
export const PLATFORM_CODE = "PLATFORM";
type Claims = { uid: number; companyId: number | null; role: Role };
type AuthReq = Request & { user: Claims };

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
    const rows = code === PLATFORM_CODE
      ? (await db.query("SELECT u.*, NULL AS code FROM users u WHERE u.company_id IS NULL AND u.email=$1 AND u.role='platform_owner'", [String(email).toLowerCase()])).rows
      : (await db.query("SELECT u.*, c.code FROM users u JOIN companies c ON c.id=u.company_id WHERE c.code=$1 AND u.email=$2 AND u.active=TRUE", [code, String(email).toLowerCase()])).rows;
    const u = rows[0];
    if (!u || !(await bcrypt.compare(String(password), u.password_hash))) return res.status(401).json({ error: "invalid credentials" });
    const token = jwt.sign({ uid: u.id, companyId: u.company_id, role: u.role }, secret, { expiresIn: "12h" });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, companyCode: u.code } });
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
