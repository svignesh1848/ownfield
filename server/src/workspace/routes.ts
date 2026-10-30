// SPDX-License-Identifier: AGPL-3.0-only
// Data Workspace API. Access: company admins, plus users an admin marks as "data analyst".
import type { Db } from "../db.js";
import { bad } from "../catalog.js";
import { type Ctx, kvGet, kvSet } from "../common.js";
import { audit } from "../security.js";
import { runSql, schemaDocs, ensureWorkspaceTables, datasetOut, setBiAccess, biStatus, syncCompanySchema, WS_MAX_ROWS, WS_TIMEOUT_MS } from "./service.js";

export async function isAnalyst(db: Db, cid: number, user: { uid: number; role: string }) {
  if (user.role === "company_admin") return true;
  if (!["manager", "sales_rep", "distributor"].includes(user.role)) return false;
  return (await kvGet(db, cid, "workspace", { analysts: [] as number[] })).analysts.includes(user.uid);
}
const hits = new Map<number, number[]>();
function throttle(uid: number) { const now = Date.now(), h = (hits.get(uid) || []).filter(t => now - t < 60000); if (h.length >= Number(process.env.WORKSPACE_RUNS_PER_MIN || 30)) throw bad("Too many queries. Please wait a minute.", 429); h.push(now); hits.set(uid, h); }

export function registerWorkspaceRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const any = auth("company_admin", "manager", "sales_rep", "distributor");
  const gate = async (req: any, res: any) => {
    const cid = tenant(req, res); if (cid == null) return null; await ensureWorkspaceTables(db);
    if (!(await isAnalyst(db, cid, req.user))) throw bad("Only admins and data analysts can use the data workspace", 403); return cid;
  };
  app.get("/api/data-workspace/me", any, wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json({ allowed: await isAnalyst(db, cid, req.user) }); }));
  app.get("/api/data-workspace/schema", any, wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return; const iso = await syncCompanySchema(db, cid);
    res.json({ tables: schemaDocs(), limits: { maxRows: WS_MAX_ROWS, timeoutMs: WS_TIMEOUT_MS }, isolation: iso.roles ? "role+views" : "views" });
  }));
  app.post("/api/data-workspace/query", any, wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return; throttle(req.user.uid);
    res.json(await runSql(db, cid, String(req.body?.sql ?? ""), { uid: req.user.uid, ip: req.ip }, Number(req.body?.limit) || 500));
  }));
  app.get("/api/data-workspace/history", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query("SELECT l.at, l.action, l.detail, u.name FROM security_audit_log l LEFT JOIN users u ON u.id=l.user_id WHERE l.company_id=$1 AND l.action LIKE 'workspace.%' ORDER BY l.id DESC LIMIT 200", [cid])).rows);
  }));
  // Analysts (permission, admin only)
  app.get("/api/data-workspace/analysts", auth("company_admin"), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json((await kvGet(db, cid, "workspace", { analysts: [] as number[] })).analysts); }));
  app.put("/api/data-workspace/analysts", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : []).map(Number).filter(Number.isInteger);
    const ok = (await db.query("SELECT id FROM users WHERE company_id=$1 AND role IN ('manager','sales_rep','distributor')", [cid])).rows.map(r => r.id);
    const analysts = ids.filter((i: number) => ok.includes(i));
    await kvSet(db, cid, "workspace", { analysts }); await audit(db, { companyId: cid, userId: req.user.uid, action: "workspace.analysts", detail: { analysts }, ip: req.ip });
    res.json(analysts);
  }));
  // Datasets (saved SQL → report-builder source "ds:<id>")
  app.get("/api/data-workspace/datasets", auth("company_admin", "manager"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await ensureWorkspaceTables(db);
    res.json((await db.query("SELECT * FROM ws_datasets WHERE company_id=$1 ORDER BY name", [cid])).rows.map(datasetOut));
  }));
  const saveDs = async (req: any, cid: number, id?: number) => {
    const name = String(req.body?.name || "").trim().slice(0, 80); if (!name) throw bad("Give the dataset a name");
    const sql = String(req.body?.sql || ""); const r = await runSql(db, cid, sql, { uid: req.user.uid, ip: req.ip, via: "dataset.save" }, 50);
    const vals = [name, String(req.body?.description || "").slice(0, 300) || null, sql, JSON.stringify(r.columns)];
    if (id) return (await db.query("UPDATE ws_datasets SET name=$1,description=$2,sql=$3,columns=$4,updated_at=NOW() WHERE id=$5 AND company_id=$6 RETURNING *", [...vals, id, cid])).rows[0];
    if (Number((await db.query("SELECT COUNT(*) AS n FROM ws_datasets WHERE company_id=$1", [cid])).rows[0].n) >= 100) throw bad("At most 100 datasets per company", 409);
    return (await db.query("INSERT INTO ws_datasets (company_id,name,description,sql,columns,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [cid, ...vals, req.user.uid])).rows[0];
  };
  app.post("/api/data-workspace/datasets", any, wrap(async (req, res) => { const cid = await gate(req, res); if (cid == null) return; res.status(201).json(datasetOut(await saveDs(req, cid))); }));
  app.put("/api/data-workspace/datasets/:id", any, wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    if (!(await db.query("SELECT id FROM ws_datasets WHERE id=$1 AND company_id=$2", [Number(req.params.id) || 0, cid])).rows[0]) throw bad("Dataset not found", 404);
    res.json(datasetOut(await saveDs(req, cid, Number(req.params.id))));
  }));
  app.delete("/api/data-workspace/datasets/:id", any, wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    await db.query("DELETE FROM ws_datasets WHERE id=$1 AND company_id=$2", [Number(req.params.id) || 0, cid]); res.json({ ok: true });
  }));
  // BI access (admin only, off by default)
  app.get("/api/data-workspace/bi-access", auth("company_admin"), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json(await biStatus(db, cid)); }));
  app.put("/api/data-workspace/bi-access", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = await setBiAccess(db, cid, !!req.body?.enabled);
    await audit(db, { companyId: cid, userId: req.user.uid, action: r.enabled ? "workspace.bi_enabled" : "workspace.bi_disabled", ip: req.ip });
    res.json(r);
  }));
}
