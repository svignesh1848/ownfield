// Sales hierarchy and territories: each user may "report to" another user, and may be given a territory
// (Zone > Region > Area …). A manager sees only their own team (direct and indirect reports) in dashboards,
// reports, approvals, tracking, custom reports and exports. Admins see everything.
// Backward compatible: a manager that nobody reports to keeps seeing the whole company, as before.
import type { Db } from "./db.js";
import { bad } from "./catalog.js";
import { type Ctx, MGR } from "./common.js";
import { audit } from "./security.js";

export const TERRITORY_LEVELS = ["Zone", "Region", "Area", "Territory"];

/** Team of the signed-in user: null = no restriction (admin, or a manager without reports); else the ids of the manager and everyone below. */
export async function teamIds(db: Db, cid: number, user: { uid: number; role: string }): Promise<number[] | null> {
  if (user.role !== "manager") return null;
  const rows = (await db.query("SELECT id, reports_to FROM users WHERE company_id=$1 AND reports_to IS NOT NULL", [cid])).rows;
  const kids = new Map<number, number[]>();
  for (const r of rows) { const k = Number(r.reports_to); if (!kids.has(k)) kids.set(k, []); kids.get(k)!.push(Number(r.id)); }
  if (!kids.has(user.uid)) return null;
  const out = new Set<number>([user.uid]), todo = [user.uid];
  while (todo.length) for (const k of kids.get(todo.pop()!) || []) if (!out.has(k)) { out.add(k); todo.push(k); }
  return [...out];
}
/** SQL fragment " AND col IN (…)" (ids come from the database, always integers) or "" when unrestricted. */
export const inTeam = (col: string, ids: number[] | null) => ids ? ` AND ${col} IN (${ids.map(n => Number(n) | 0).join(",") || "0"})` : "";
/** Throw 404 when a manager acts on someone outside their team. */
export async function assertTeam(db: Db, cid: number, user: { uid: number; role: string }, id: number | null | undefined) {
  const t = await teamIds(db, cid, user);
  if (t && (id == null || !t.includes(Number(id)))) throw bad("not in your team", 404);
}
/** Managers above a user (nearest first). */
export async function managersOf(db: Db, cid: number, uid: number) {
  const rows = (await db.query("SELECT id, reports_to, role FROM users WHERE company_id=$1", [cid])).rows;
  const by = new Map(rows.map((r: any) => [Number(r.id), r])); const out: number[] = []; let cur = by.get(uid)?.reports_to;
  while (cur != null && !out.includes(Number(cur))) { out.push(Number(cur)); cur = by.get(Number(cur))?.reports_to; }
  return out;
}

/** Resolve a "reports to" value (user id or email) for a user; checks the company and prevents loops. */
export async function resolveReportsTo(db: Db, cid: number, uid: number | null, v: unknown): Promise<number | null> {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim().toLowerCase();
  const m = (await db.query(`SELECT id, role FROM users WHERE company_id=$1 AND ${/^\d+$/.test(s) ? "id=$2" : "email=$2"}`, [cid, /^\d+$/.test(s) ? Number(s) : s])).rows[0];
  if (!m) throw bad(`reports to: no user ${v} in this company`);
  if (["retailer", "distributor"].includes(m.role)) throw bad("reports to must be an admin, manager or sales rep");
  if (uid != null) {
    if (m.id === uid) throw bad("a user cannot report to themselves");
    if ((await managersOf(db, cid, m.id)).includes(uid)) throw bad("this would make a loop in the hierarchy");
  }
  return m.id;
}
export async function resolveTerritory(db: Db, cid: number, v: unknown): Promise<number | null> {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  const t = (await db.query(`SELECT id FROM territories WHERE company_id=$1 AND ${/^\d+$/.test(s) ? "id=$2" : "LOWER(name)=LOWER($2)"}`, [cid, /^\d+$/.test(s) ? Number(s) : s])).rows[0];
  if (!t) throw bad(`territory ${v} not found — add it under Team & territories first`);
  return t.id;
}

export function registerHierarchyRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  // Org chart: every active user with whom they report to and their territory.
  app.get("/api/hierarchy", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const team = await teamIds(db, cid, req.user);
    const users = (await db.query(`SELECT u.id, u.name, u.email, u.role, u.reports_to, u.territory_id, t.name AS territory, t.level AS territory_level, u.active
      FROM users u LEFT JOIN territories t ON t.id=u.territory_id WHERE u.company_id=$1 AND u.role IN ('company_admin','manager','sales_rep') ORDER BY u.name`, [cid])).rows;
    const terr = (await db.query("SELECT id, name, level, parent_id FROM territories WHERE company_id=$1 ORDER BY name", [cid])).rows;
    res.json({ users: team ? users.filter((u: any) => team.includes(u.id)) : users, territories: terr, levels: TERRITORY_LEVELS, scoped: !!team, myTeam: team });
  }));
  app.put("/api/users/:id/hierarchy", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const id = Number(req.params.id), u = (await db.query("SELECT id, email FROM users WHERE id=$1 AND company_id=$2", [id, cid])).rows[0];
    if (!u) throw bad("user not found", 404);
    const b = req.body || {};
    const rt = b.reportsTo !== undefined ? await resolveReportsTo(db, cid, id, b.reportsTo) : undefined;
    const tt = b.territoryId !== undefined ? await resolveTerritory(db, cid, b.territoryId) : undefined;
    if (rt !== undefined) await db.query("UPDATE users SET updated_at=NOW(), reports_to=$1 WHERE id=$2", [rt, id]);
    if (tt !== undefined) await db.query("UPDATE users SET updated_at=NOW(), territory_id=$1 WHERE id=$2", [tt, id]);
    const r = (await db.query("SELECT id, reports_to, territory_id FROM users WHERE id=$1", [id])).rows[0];
    await audit(db, { companyId: cid, userId: req.user.uid, action: "user.hierarchy", target: u.email, detail: { reportsTo: r.reports_to, territoryId: r.territory_id }, ip: req.ip });
    res.json(r);
  }));
  app.get("/api/territories", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT id, name, level, parent_id FROM territories WHERE company_id=$1 ORDER BY name", [cid])).rows);
  }));
  const terrBody = async (cid: number, b: any, self?: number) => {
    const name = String(b?.name || "").trim().slice(0, 80); if (!name) throw bad("territory name required");
    const level = String(b?.level || "Area").trim(); if (!TERRITORY_LEVELS.includes(level)) throw bad(`level must be one of ${TERRITORY_LEVELS.join(", ")}`);
    let parent: number | null = null;
    if (b?.parentId != null && b.parentId !== "") {
      parent = Number(b.parentId);
      const all = (await db.query("SELECT id, parent_id FROM territories WHERE company_id=$1", [cid])).rows;
      if (!all.some((t: any) => t.id === parent)) throw bad("parent territory not found", 404);
      for (let p: any = parent, n = 0; p != null && n < 50; n++) { if (p === self) throw bad("this would make a loop in territories"); p = all.find((t: any) => t.id === p)?.parent_id ?? null; }
    }
    const dup = (await db.query("SELECT id FROM territories WHERE company_id=$1 AND LOWER(name)=LOWER($2)", [cid, name])).rows[0];
    if (dup && dup.id !== self) throw bad(`territory ${name} already exists`, 409);
    return { name, level, parent };
  };
  app.post("/api/territories", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const t = await terrBody(cid, req.body);
    res.status(201).json((await db.query("INSERT INTO territories (company_id,name,level,parent_id) VALUES ($1,$2,$3,$4) RETURNING *", [cid, t.name, t.level, t.parent])).rows[0]);
  }));
  app.put("/api/territories/:id", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const id = Number(req.params.id);
    if (!(await db.query("SELECT id FROM territories WHERE id=$1 AND company_id=$2", [id, cid])).rows[0]) throw bad("territory not found", 404);
    const t = await terrBody(cid, req.body, id);
    res.json((await db.query("UPDATE territories SET name=$1, level=$2, parent_id=$3 WHERE id=$4 RETURNING *", [t.name, t.level, t.parent, id])).rows[0]);
  }));
}
