// WhatsApp / SMS messages to outlets through a pluggable provider.
// Default provider is "mock": messages are written to the log and NEVER leave the server.
// A real send only happens after a company admin picks the HTTP provider and enters its URL (https, public address only).
import type { Db } from "./db.js";
import { bad } from "./catalog.js";
import { checkUrl, setMessageHook } from "./integrations/webhooks.js";
import { outstanding } from "./collections.js";
import { type Ctx, MGR, requireFeature, kvGet, kvSet } from "./common.js";

const MASK = "******";
export const TEMPLATES = {
  order_confirmed: "Hi {shop}, your order #{number} for ₹{amount} is received. Thank you — {company}",
  invoice_created: "Hi {shop}, invoice {number} for ₹{amount} is ready. — {company}",
  payment_received: "Hi {shop}, we received ₹{amount} (receipt {number}). Thank you — {company}",
  payment_reminder: "Hi {shop}, a friendly reminder: ₹{amount} is due to {company}. Please ignore if already paid.",
};
type Tpl = keyof typeof TEMPLATES;
const EVENT_TPL: Record<string, Tpl> = { "order.created": "order_confirmed", "invoice.created": "invoice_created", "collection.created": "payment_received" };
export type MsgSettings = { provider: "mock" | "http"; channel: "whatsapp" | "sms"; auto: Partial<Record<Tpl, boolean>>; templates: Partial<Record<Tpl, string>>;
  http: { url: string; authHeader: string; authValue: string; body: string }; dailyLimit: number };
export const DEFAULTS: MsgSettings = { provider: "mock", channel: "whatsapp", auto: { order_confirmed: true, invoice_created: false, payment_received: true }, templates: {},
  http: { url: "", authHeader: "Authorization", authValue: "", body: '{"to":"{to}","channel":"{channel}","text":"{text}"}' }, dailyLimit: 300 };

/** A provider sends one message. Add a new one (e.g. a vendor SDK) by implementing this and registering it below. */
export type Provider = { name: string; send: (m: { to: string; text: string; channel: string }, cfg: MsgSettings, fetchImpl: typeof fetch) => Promise<void> };
export const PROVIDERS: Record<string, Provider> = {
  mock: { name: "Mock (log only, nothing is sent)", send: async () => {} },
  http: { name: "HTTP gateway (your WhatsApp/SMS provider)", send: async (m, cfg, f) => {
    const err = await checkUrl(cfg.http.url); if (err) throw new Error(err);
    const esc = (v: string) => JSON.stringify(v).slice(1, -1);
    const body = cfg.http.body.replace(/\{(to|text|channel)\}/g, (_, k) => esc((m as any)[k]));
    const headers: Record<string, string> = { "content-type": "application/json" }; if (cfg.http.authValue) headers[cfg.http.authHeader || "Authorization"] = cfg.http.authValue;
    const r = await f(cfg.http.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) throw new Error(`provider said HTTP ${r.status}`);
  } },
};

export const phone = (p: unknown) => { const d = String(p ?? "").replace(/\D/g, ""); return d.length === 10 ? "91" + d : d.length >= 11 && d.length <= 15 ? d : null; };
const fill = (t: string, v: Record<string, unknown>) => t.replace(/\{(\w+)\}/g, (m, k) => v[k] == null ? m : String(v[k])).slice(0, 1000);
const cfgOf = (db: Db, cid: number) => kvGet<MsgSettings>(db, cid, "messaging", DEFAULTS);

/** Put one message in the queue (status queued, or skipped when the outlet has no usable phone). */
export async function enqueue(db: Db, cid: number, shopId: number | null, tpl: Tpl, vars: Record<string, unknown>, to?: string) {
  const cfg = await cfgOf(db, cid);
  const shop = shopId ? (await db.query("SELECT name, phone FROM shops WHERE id=$1 AND company_id=$2", [shopId, cid])).rows[0] : null;
  const company = (await db.query("SELECT name FROM companies WHERE id=$1", [cid])).rows[0];
  const num = phone(to ?? shop?.phone);
  const text = fill(cfg.templates[tpl] || TEMPLATES[tpl], { shop: shop?.name || "there", company: company?.name || "us", ...vars });
  return (await db.query("INSERT INTO message_log (company_id,channel,to_phone,shop_id,template,body,status,provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [cid, cfg.channel, num, shopId, tpl, text, num ? "queued" : "skipped", cfg.provider])).rows[0];
}

async function onEvent(db: Db, cid: number, event: string, d: any) {
  const tpl = EVENT_TPL[event]; if (!tpl || !d?.shop_id) return;
  try { await requireFeature(db, cid, "messaging"); } catch { return; }
  const cfg = await cfgOf(db, cid); if (!cfg.auto[tpl]) return;
  await enqueue(db, cid, d.shop_id, tpl, { number: d.number ?? d.id, amount: Number(d.total ?? d.amount ?? 0).toFixed(2) });
}
setMessageHook(onEvent);

/** Send queued messages. Mock provider marks them "mock" (logged, not sent). Failed sends retry up to 3 times. */
export async function drainMessages(db: Db, opts: { limit?: number; fetchImpl?: typeof fetch } = {}) {
  const rows = (await db.query("SELECT * FROM message_log WHERE status='queued' ORDER BY id LIMIT $1", [opts.limit ?? 20])).rows;
  for (const m of rows) {
    const cfg = await cfgOf(db, m.company_id), p = PROVIDERS[cfg.provider] || PROVIDERS.mock;
    const sentToday = Number((await db.query("SELECT COUNT(*) AS n FROM message_log WHERE company_id=$1 AND status IN ('sent','mock') AND sent_at > NOW() - INTERVAL '1 day'", [m.company_id])).rows[0].n);
    if (sentToday >= cfg.dailyLimit) { await db.query("UPDATE message_log SET status='failed', error=$1 WHERE id=$2", ["daily limit reached", m.id]); continue; }
    try {
      await p.send({ to: m.to_phone, text: m.body, channel: m.channel }, cfg, opts.fetchImpl ?? fetch);
      await db.query("UPDATE message_log SET status=$1, provider=$2, attempts=attempts+1, sent_at=NOW(), error=NULL WHERE id=$3", [cfg.provider === "mock" ? "mock" : "sent", cfg.provider, m.id]);
    } catch (e: any) {
      const a = m.attempts + 1;
      await db.query("UPDATE message_log SET status=$1, attempts=$2, error=$3, provider=$4 WHERE id=$5", [a >= 3 ? "failed" : "queued", a, String(e.message).slice(0, 300), cfg.provider, m.id]);
    }
  }
  return rows.length;
}
export function startMessageWorker(db: Db, everyMs = 20_000) {
  let busy = false;
  const t = setInterval(async () => { if (busy) return; busy = true; try { await drainMessages(db); await db.query("DELETE FROM message_log WHERE created_at < NOW() - INTERVAL '90 days'"); } catch (e: any) { console.error("message worker:", e.message); } finally { busy = false; } }, everyMs);
  t.unref(); return t;
}

const masked = (c: MsgSettings) => ({ ...c, http: { ...c.http, authValue: c.http.authValue ? MASK : "" } });

export function registerMessagingRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const gate = async (req: any, res: any) => { const cid = tenant(req, res); if (cid == null) return null; await requireFeature(db, cid, "messaging"); return cid; };
  app.get("/api/messages/settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    res.json({ ...masked(await cfgOf(db, cid)), defaults: TEMPLATES, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.name])) });
  }));
  app.put("/api/messages/settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const old = await cfgOf(db, cid), b = req.body || {};
    const provider = b.provider === "http" ? "http" : "mock";
    const http = { ...old.http, ...(b.http || {}) };
    http.url = String(http.url || "").trim().slice(0, 500); http.authHeader = String(http.authHeader || "Authorization").replace(/[^\w-]/g, "").slice(0, 60);
    if (b.http?.authValue === MASK || b.http?.authValue == null) http.authValue = old.http.authValue; else http.authValue = String(b.http.authValue).slice(0, 500);
    http.body = String(http.body || DEFAULTS.http.body).slice(0, 2000);
    if (provider === "http") { const e = await checkUrl(http.url); if (e) throw bad(e); }
    const tpl: Partial<Record<Tpl, string>> = {}, auto: Partial<Record<Tpl, boolean>> = {};
    for (const k of Object.keys(TEMPLATES) as Tpl[]) { const t = String(b.templates?.[k] ?? old.templates[k] ?? "").trim().slice(0, 1000); if (t && t !== TEMPLATES[k]) tpl[k] = t; auto[k] = !!(b.auto?.[k] ?? old.auto[k]); }
    const cfg: MsgSettings = { provider, channel: b.channel === "sms" ? "sms" : "whatsapp", auto, templates: tpl, http, dailyLimit: Math.max(1, Math.min(5000, Number(b.dailyLimit) || old.dailyLimit)) };
    await kvSet(db, cid, "messaging", cfg); res.json(masked(cfg));
  }));
  app.get("/api/messages/log", auth(...MGR), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    res.json((await db.query("SELECT m.*, s.name AS shop_name FROM message_log m LEFT JOIN shops s ON s.id=m.shop_id WHERE m.company_id=$1 ORDER BY m.id DESC LIMIT 200", [cid])).rows);
  }));
  app.post("/api/messages/test", auth("company_admin"), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    if (!phone(req.body?.to)) throw bad("enter a phone number");
    res.status(201).json(await enqueue(db, cid, null, "order_confirmed", { number: "TEST-1", amount: "1.00", shop: "Test" }, req.body.to));
  }));
  /** Payment reminders to every outlet that owes more than minAmount (or just the given outlets). */
  app.post("/api/messages/reminders", auth(...MGR), wrap(async (req, res) => {
    const cid = await gate(req, res); if (cid == null) return;
    const min = Math.max(0, Number(req.body?.minAmount) || 0), only = Array.isArray(req.body?.shopIds) ? new Set(req.body.shopIds.map(Number)) : null;
    const due = (await outstanding(db, cid)).filter((r: any) => r.shop_id && r.outstanding > min && (!only || only.has(r.shop_id)));
    const out = []; for (const r of due.slice(0, 500)) out.push(await enqueue(db, cid, r.shop_id, "payment_reminder", { amount: r.outstanding.toFixed(2) }));
    res.status(201).json({ queued: out.filter(m => m.status === "queued").length, skipped: out.filter(m => m.status === "skipped").length });
  }));
}
