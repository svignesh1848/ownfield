// Admin endpoints behind the Integrations screen (company_admin only), plus the public inbound webhook.
import crypto from "node:crypto";
import multer from "multer";
import type { Express, Request, Response, NextFunction } from "express";
import type { Ctx } from "../common.js";
import type { Db } from "../db.js";
import { bad, parseJson } from "../catalog.js";
import { audit, HitCounter } from "../security.js";
import { ALL_SCOPES, cleanScopes, hashKey, newKey } from "./apikeys.js";
import { EVENTS, checkUrl, drain } from "./webhooks.js";
import { plugins, plugin } from "../connectors/registry.js";
import { PRESETS } from "../connectors/presets.js";
import { FIELDS } from "../connectors/records.js";
import { checkRules } from "../connectors/mapping.js";
import { preview, exportFile, importFile, importRows, pull, conf, type ConnRow } from "../connectors/service.js";

const MASK = "******";
async function publicConn(c: ConnRow) {
  const p = await plugin(c.type).catch(() => null);
  const cfg = conf(c);
  for (const f of p?.configFields || []) if (f.kind === "secret" && cfg[f.key]) cfg[f.key] = MASK;
  if (cfg.inboundSecret) cfg.inboundSecret = MASK;
  return { id: c.id, name: c.name, type: c.type, preset: (c as any).preset, enabled: c.enabled, mode: c.mode, config: cfg, mapping: parseJson(c.mapping, {}),
    inbound_path: (c as any).inbound_token ? `/api/v1/inbound/${(c as any).inbound_token}/{entity}` : null, last_run_at: c.last_run_at };
}

export function registerIntegrationRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const admin = auth("company_admin");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  const log = (req: any, cid: number, action: string, target?: string, detail?: unknown) => audit(db, { companyId: cid, userId: req.user.uid, action, target, detail, ip: req.ip });

  // ---- API keys ----
  app.get("/api/integrations/keys", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rows = (await db.query("SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE company_id=$1 ORDER BY id DESC", [cid])).rows;
    res.json({ keys: rows.map(r => ({ ...r, scopes: parseJson(r.scopes, []) })), scopes: ALL_SCOPES });
  }));
  app.post("/api/integrations/keys", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const name = String(req.body?.name || "").trim().slice(0, 60); if (!name) throw bad("Give the key a name, e.g. 'Odoo sync'");
    const scopes = cleanScopes(req.body?.scopes); if (!scopes) throw bad("Pick at least one valid scope");
    if (Number((await db.query("SELECT COUNT(*) AS n FROM api_keys WHERE company_id=$1 AND revoked_at IS NULL", [cid])).rows[0].n) >= 20) throw bad("At most 20 active keys");
    const { prefix, key } = newKey();
    const r = (await db.query("INSERT INTO api_keys (company_id,name,prefix,key_hash,scopes,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, prefix, created_at",
      [cid, name, prefix, hashKey(key), JSON.stringify(scopes), req.user.uid])).rows[0];
    await log(req, cid, "apikey.create", `key:${name}`, { prefix, scopes });
    res.status(201).json({ ...r, scopes, key, note: "Copy this key now. It is not shown again." });
  }));
  app.delete("/api/integrations/keys/:id", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = (await db.query("UPDATE api_keys SET revoked_at=NOW() WHERE id=$1 AND company_id=$2 AND revoked_at IS NULL RETURNING name, prefix", [Number(req.params.id), cid])).rows[0];
    if (!r) throw bad("key not found", 404);
    await log(req, cid, "apikey.revoke", `key:${r.name}`, { prefix: r.prefix }); res.json({ ok: true });
  }));

  // ---- Webhooks ----
  const cleanEvents = (e: unknown) => { const l = Array.isArray(e) ? e.map(String) : []; if (!l.length || l.some(x => x !== "*" && !(EVENTS as readonly string[]).includes(x))) throw bad("Pick at least one valid event"); return [...new Set(l)]; };
  app.get("/api/integrations/webhooks", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rows = (await db.query("SELECT id, url, events, active, created_at FROM webhooks WHERE company_id=$1 ORDER BY id", [cid])).rows;
    res.json({ webhooks: rows.map(r => ({ ...r, events: parseJson(r.events, []) })), events: EVENTS });
  }));
  app.post("/api/integrations/webhooks", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const url = String(req.body?.url || "").trim(); const why = await checkUrl(url); if (why) throw bad(why);
    const events = cleanEvents(req.body?.events);
    if (Number((await db.query("SELECT COUNT(*) AS n FROM webhooks WHERE company_id=$1", [cid])).rows[0].n) >= 20) throw bad("At most 20 webhooks");
    const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
    const r = (await db.query("INSERT INTO webhooks (company_id,url,events,secret) VALUES ($1,$2,$3,$4) RETURNING id, url, active, created_at", [cid, url, JSON.stringify(events), secret])).rows[0];
    await log(req, cid, "webhook.create", url, { events });
    res.status(201).json({ ...r, events, secret, note: "Use this secret to check the X-FieldForce-Signature header. It is not shown again." });
  }));
  app.patch("/api/integrations/webhooks/:id", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const ex = (await db.query("SELECT * FROM webhooks WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!ex) throw bad("webhook not found", 404);
    const events = req.body?.events ? cleanEvents(req.body.events) : parseJson(ex.events, []);
    const active = typeof req.body?.active === "boolean" ? req.body.active : ex.active;
    await db.query("UPDATE webhooks SET events=$1, active=$2 WHERE id=$3", [JSON.stringify(events), active, ex.id]);
    await log(req, cid, "webhook.update", ex.url, { events, active }); res.json({ ok: true });
  }));
  app.delete("/api/integrations/webhooks/:id", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const ex = (await db.query("SELECT url FROM webhooks WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!ex) throw bad("webhook not found", 404);
    await db.query("UPDATE webhook_deliveries SET status='cancelled' WHERE webhook_id=$1 AND status='pending'", [Number(req.params.id)]);
    await db.query("UPDATE webhooks SET active=FALSE WHERE id=$1", [Number(req.params.id)]);
    await db.query("DELETE FROM webhooks WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries WHERE webhook_id=$1)", [Number(req.params.id)]);
    await log(req, cid, "webhook.delete", ex.url); res.json({ ok: true });
  }));
  app.post("/api/integrations/webhooks/:id/test", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const h = (await db.query("SELECT id FROM webhooks WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!h) throw bad("webhook not found", 404);
    const payload = JSON.stringify({ id: crypto.randomUUID(), event: "test.ping", created_at: new Date().toISOString(), data: { message: "Test from OwnField (sample)" } });
    const d = (await db.query("INSERT INTO webhook_deliveries (company_id,webhook_id,event,payload) VALUES ($1,$2,'test.ping',$3) RETURNING id", [cid, h.id, payload])).rows[0];
    await drain(db, { limit: 5 });
    res.json((await db.query("SELECT id, status, attempts, response_code, last_error FROM webhook_deliveries WHERE id=$1", [d.id])).rows[0]);
  }));

  // ---- Delivery log ----
  app.get("/api/integrations/deliveries", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json((await db.query(`SELECT d.id, d.event, d.status, d.attempts, d.response_code, d.last_error, d.detail, d.created_at, d.delivered_at, d.next_at, d.webhook_id, d.connector_id,
      COALESCE(w.url, c.name) AS target FROM webhook_deliveries d LEFT JOIN webhooks w ON w.id=d.webhook_id LEFT JOIN connectors c ON c.id=d.connector_id
      WHERE d.company_id=$1 ORDER BY d.id DESC LIMIT 100`, [cid])).rows);
  }));
  app.post("/api/integrations/deliveries/:id/retry", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = (await db.query("UPDATE webhook_deliveries SET status='pending', attempts=0, next_at=NOW() WHERE id=$1 AND company_id=$2 AND status IN ('failed','cancelled') RETURNING id", [Number(req.params.id), cid])).rows[0];
    if (!r) throw bad("only failed deliveries can be retried", 409); res.json({ ok: true });
  }));

  // ---- Connectors ----
  const own = async (req: any, cid: number): Promise<ConnRow> => {
    const c = (await db.query("SELECT * FROM connectors WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0]; if (!c) throw bad("connector not found", 404); return c;
  };
  app.get("/api/integrations/connectors", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const list = (await db.query("SELECT * FROM connectors WHERE company_id=$1 ORDER BY id", [cid])).rows;
    const types = [...(await plugins()).values()].map(p => ({ type: p.type, label: p.label, description: p.description, configFields: p.configFields, out: p.out, in: p.in, formats: p.formats || [], canSend: !!p.send, canPull: !!p.pull, canExport: !!p.exportFile }));
    res.json({ connectors: await Promise.all(list.map(publicConn)), types, presets: PRESETS.map(p => ({ id: p.id, label: p.label, type: p.type, note: p.note, parked: !!p.parked })), fields: FIELDS, events: EVENTS });
  }));
  app.post("/api/integrations/connectors", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const pre = req.body?.preset ? PRESETS.find(p => p.id === req.body.preset) : null;
    if (req.body?.preset && !pre) throw bad("unknown preset");
    const type = pre?.type || String(req.body?.type || ""); await plugin(type);
    if (Number((await db.query("SELECT COUNT(*) AS n FROM connectors WHERE company_id=$1", [cid])).rows[0].n) >= 20) throw bad("At most 20 connectors");
    const name = String(req.body?.name || pre?.label || type).slice(0, 60);
    const c = (await db.query("INSERT INTO connectors (company_id,name,type,preset,config,mapping,inbound_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [cid, name, type, pre?.id ?? null, JSON.stringify(pre?.config ?? {}), JSON.stringify(pre?.mapping ?? {}), crypto.randomBytes(18).toString("base64url")])).rows[0];
    await log(req, cid, "connector.create", name, { type, preset: pre?.id });
    res.status(201).json(await publicConn(c));
  }));
  app.patch("/api/integrations/connectors/:id", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid), b = req.body || {}, p = await plugin(c.type);
    const cfg = conf(c);
    if (b.config && typeof b.config === "object") for (const [k, v] of Object.entries(b.config)) {
      if (v === MASK) continue; // unchanged secret
      if (JSON.stringify(v).length > 20_000) throw bad(`${k} is too long`);
      cfg[k] = v;
    }
    for (const f of p.configFields) if (f.kind === "json" && typeof cfg[f.key] === "string" && cfg[f.key].trim()) { try { cfg[f.key] = JSON.parse(cfg[f.key]); } catch { throw bad(`${f.label} must be valid JSON`); } }
    if (cfg.baseUrl) { const why = await checkUrl(String(cfg.baseUrl), false); if (why) throw bad(why); }
    let mapping = parseJson<Record<string, any>>(c.mapping, {});
    if (b.mapping && typeof b.mapping === "object") {
      for (const [ent, rules] of Object.entries(b.mapping)) { if (!(ent in FIELDS)) throw bad(`unknown entity ${ent}`); const e = checkRules(rules); if (e) throw bad(`${ent}: ${e}`); }
      mapping = b.mapping;
    }
    const mode = b.mode === "live" || b.mode === "sample" ? b.mode : c.mode;
    if (mode === "live" && c.preset === "logic-erp") throw bad("Logic ERP is parked: export files only, no live calls");
    const enabled = typeof b.enabled === "boolean" ? b.enabled : c.enabled;
    const name = b.name ? String(b.name).slice(0, 60) : c.name;
    const u = (await db.query("UPDATE connectors SET name=$1, enabled=$2, mode=$3, config=$4, mapping=$5, updated_at=NOW() WHERE id=$6 RETURNING *", [name, enabled, mode, JSON.stringify(cfg), JSON.stringify(mapping), c.id])).rows[0];
    await log(req, cid, "connector.update", name, { enabled, mode, mappingChanged: !!b.mapping, configKeys: Object.keys(b.config || {}) });
    res.json(await publicConn(u));
  }));
  app.delete("/api/integrations/connectors/:id", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid);
    await db.query("DELETE FROM webhook_deliveries WHERE connector_id=$1", [c.id]);
    await db.query("DELETE FROM connectors WHERE id=$1", [c.id]);
    await log(req, cid, "connector.delete", c.name); res.json({ ok: true });
  }));
  app.post("/api/integrations/connectors/:id/preview", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid), ent = String(req.body?.entity || "orders");
    if (!["orders", "invoices", "collections", "stock"].includes(ent)) throw bad("preview works for orders, invoices, collections or stock");
    res.json(await preview(db, c, ent as any));
  }));
  app.post("/api/integrations/connectors/:id/test", admin, wrap(async (req, res) => {
    // Queue the latest order through this connector (sample mode just records the request it would send).
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid);
    const o = (await db.query("SELECT id FROM orders WHERE company_id=$1 ORDER BY id DESC LIMIT 1", [cid])).rows[0]; if (!o) throw bad("No orders yet to test with");
    const d = (await db.query("INSERT INTO webhook_deliveries (company_id,connector_id,event,payload) VALUES ($1,$2,'order.test',$3) RETURNING id", [cid, c.id, JSON.stringify({ event: "order.test", data: { id: o.id } })])).rows[0];
    await db.query("UPDATE webhook_deliveries SET next_at=NOW() WHERE id=$1", [d.id]);
    if (!c.enabled) await db.query("UPDATE connectors SET enabled=TRUE WHERE id=$1", [c.id]);
    await drain(db, { limit: 5 });
    if (!c.enabled) await db.query("UPDATE connectors SET enabled=FALSE WHERE id=$1", [c.id]);
    res.json((await db.query("SELECT id, status, response_code, last_error, detail FROM webhook_deliveries WHERE id=$1", [d.id])).rows[0]);
  }));
  app.get("/api/integrations/connectors/:id/export", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid), ent = String(req.query.entity || "orders");
    if (!["orders", "invoices", "collections", "stock"].includes(ent)) throw bad("unknown entity");
    const since = req.query.since ? new Date(String(req.query.since)).toISOString() : null;
    const f = await exportFile(db, c, ent as any, String(req.query.format || ""), since);
    await log(req, cid, "connector.export", c.name, { entity: ent });
    res.setHeader("Content-Disposition", `attachment; filename="${f.filename}"`); res.type(f.contentType).send(f.body);
  }));
  app.post("/api/integrations/connectors/:id/import", admin, upload.single("file"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid), ent = String(req.query.entity || req.body?.entity || "");
    if (!["products", "stock", "customers", "distributors"].includes(ent)) throw bad("entity must be products, stock, customers or distributors");
    if (!req.file) throw bad("attach a CSV, Excel or JSON file");
    const out = await importFile(db, c, ent as any, req.file.buffer, req.file.originalname);
    await log(req, cid, "connector.import", c.name, { entity: ent, inserted: out.inserted, updated: out.updated, errors: out.errors.length });
    res.json(out);
  }));
  app.post("/api/integrations/connectors/:id/pull", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid), ent = String(req.body?.entity || "products");
    if (!["products", "stock", "customers", "distributors"].includes(ent)) throw bad("unknown entity");
    const out = await pull(db, c, ent as any);
    await log(req, cid, "connector.pull", c.name, { entity: ent, sample: out.sample, inserted: out.inserted, updated: out.updated });
    res.json(out);
  }));
  app.post("/api/integrations/connectors/:id/inbound-token", admin, wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await own(req, cid); const t = crypto.randomBytes(18).toString("base64url");
    await db.query("UPDATE connectors SET inbound_token=$1 WHERE id=$2", [t, c.id]);
    await log(req, cid, "connector.inbound_token", c.name); res.json({ inbound_path: `/api/v1/inbound/${t}/{entity}` });
  }));
}

/** Public inbound webhook: POST /api/v1/inbound/<token>/<entity> with a JSON object, array or {items:[...]}.
 *  The connector's mapping for that entity turns the external fields into OwnField fields. Optional HMAC check when
 *  the connector has config.inboundSecret: header X-Signature: sha256=<hex HMAC of the raw body>. */
export function registerInbound(app: Express, db: Db) {
  const hits = new HitCounter(Number(process.env.INBOUND_RATE_MAX || 60), 60_000);
  app.post("/api/v1/inbound/:token/:entity", (req: Request, res: Response, next: NextFunction) => (async () => {
    const ent = req.params.entity;
    if (!["products", "stock", "customers", "distributors"].includes(ent)) return res.status(404).json({ error: "unknown entity" });
    const c = (await db.query("SELECT * FROM connectors WHERE inbound_token=$1", [String(req.params.token)])).rows[0];
    if (!c || !c.enabled) return res.status(404).json({ error: "not found" });
    if (hits.hit(`c${c.id}`) > hits.max) return res.status(429).json({ error: "rate limit exceeded" });
    const secret = conf(c).inboundSecret;
    if (secret) {
      const want = "sha256=" + crypto.createHmac("sha256", String(secret)).update((req as any).rawBody || "").digest("hex");
      const got = String(req.headers["x-signature"] || "");
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.status(401).json({ error: "bad signature" });
    }
    const b = req.body; const rows = Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : b && typeof b === "object" ? [b] : [];
    if (!rows.length || rows.length > 500) return res.status(400).json({ error: "send 1 to 500 records" });
    const out = await importRows(db, c, ent as any, rows);
    await audit(db, { companyId: c.company_id, action: "inbound.upsert", target: c.name, detail: { entity: ent, inserted: out.inserted, updated: out.updated, errors: out.errors.length }, ip: req.ip });
    res.json(out);
  })().catch(next));
}
