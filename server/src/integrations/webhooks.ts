// Outgoing webhooks: a small DB-backed queue (webhook_deliveries) drained by an in-process timer. No extra infra.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { Db } from "../db.js";

export const EVENTS = ["order.created", "order.approved", "order.status_changed", "invoice.created", "credit_note.created", "collection.created", "stock.low", "van.closed", "claim.submitted", "claim.settled", "lead.converted", "survey.submitted", "message.sent", "test.ping"] as const;
export const MAX_ATTEMPTS = 8;
/** Backoff after the n-th failed attempt: 30s, 1m, 2m, 4m ... capped at 6h. */
export const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 6 * 3600_000);

/** Signature header value: hex HMAC-SHA256 of `${timestamp}.${body}` with the webhook's secret. */
export function sign(secret: string, timestamp: string, body: string) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

function privateIp(ip: string) {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); if (l.startsWith("::ffff:")) return privateIp(l.slice(7)); return l === "::1" || l === "::" || /^f[cd]|^fe80/.test(l); }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
/** Webhook URLs must be https (http only when WEBHOOK_ALLOW_HTTP=1) and must not point at private/loopback/metadata addresses. */
export async function checkUrl(raw: string, resolve = process.env.WEBHOOK_ALLOW_PRIVATE !== "1"): Promise<string | null> {
  let u: URL; try { u = new URL(raw); } catch { return "Enter a full URL, e.g. https://erp.example.com/hooks/fieldforce"; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && process.env.WEBHOOK_ALLOW_HTTP === "1")) return "URL must start with https://";
  if (u.username || u.password) return "Put credentials in your receiver, not in the URL";
  if (!resolve) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return "Private addresses are not allowed";
  try {
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(privateIp)) return "Private addresses are not allowed";
  } catch { return "Could not resolve that host"; }
  return null;
}

/** Queue an event for every active webhook of the company subscribed to it. Safe to call inside a transaction. */
export async function emit(db: Db, companyId: number, event: string, data: unknown) {
  try {
    const hooks = (await db.query("SELECT id, events FROM webhooks WHERE company_id=$1 AND active=TRUE", [companyId])).rows
      .filter(h => { try { const ev: string[] = JSON.parse(h.events); return ev.includes(event) || ev.includes("*"); } catch { return false; } });
    for (const h of hooks) {
      const payload = JSON.stringify({ id: crypto.randomUUID(), event, created_at: new Date().toISOString(), data });
      await db.query("INSERT INTO webhook_deliveries (company_id,webhook_id,event,payload) VALUES ($1,$2,$3,$4)", [companyId, h.id, event, payload]);
    }
    // Connectors subscribed to this event (config.events, comma separated) get a queued delivery too.
    const conns = (await db.query("SELECT id, config FROM connectors WHERE company_id=$1 AND enabled=TRUE", [companyId])).rows
      .filter(c => { try { return String(JSON.parse(c.config).events || "").split(",").map(x => x.trim()).includes(event); } catch { return false; } });
    for (const c of conns) await db.query("INSERT INTO webhook_deliveries (company_id,connector_id,event,payload) VALUES ($1,$2,$3,$4)", [companyId, c.id, event, JSON.stringify({ event, data })]);
    return hooks.length + conns.length;
  } catch (e: any) { console.error("webhook emit failed:", e.message); return 0; }
}

/** Queue stock.low for any of the given variants whose total stock at the location fell to or below the company threshold. */
export async function checkLowStock(db: Db, companyId: number, variantIds: number[], distributorId: number | null) {
  if (!variantIds.length) return;
  const k = (await db.query("SELECT v FROM company_kv WHERE company_id=$1 AND k='integrations'", [companyId])).rows[0];
  let threshold = 10; try { const s = JSON.parse(k?.v || "{}"); if (Number.isFinite(Number(s.lowStockQty))) threshold = Number(s.lowStockQty); } catch { /* default */ }
  for (const vid of [...new Set(variantIds)]) {
    const r = (await db.query(`SELECT v.sku, v.external_id, COALESCE(SUM(s.qty),0) AS qty FROM variants v LEFT JOIN stock s ON s.variant_id=v.id AND ${distributorId == null ? "s.distributor_id IS NULL" : "s.distributor_id=$3"}
      WHERE v.id=$1 AND v.company_id=$2 GROUP BY v.sku, v.external_id`, distributorId == null ? [vid, companyId] : [vid, companyId, distributorId])).rows[0];
    if (r && Number(r.qty) <= threshold) await emit(db, companyId, "stock.low", { sku: r.sku, external_id: r.external_id, distributor_id: distributorId, qty: Number(r.qty), threshold });
  }
}

type Fetch = typeof fetch;
/** Connector deliveries are handed to this function (set by connectors/service.ts) so this file has no plugin imports. */
let connectorDeliver: ((db: Db, d: any, f: Fetch) => Promise<{ code: number | null; detail?: string; sample?: boolean }>) | null = null;
export function setConnectorDeliver(fn: typeof connectorDeliver) { connectorDeliver = fn; }
/** Send up to `limit` due deliveries. Returns how many were attempted. */
export async function drain(db: Db, opts: { limit?: number; fetchImpl?: Fetch; timeoutMs?: number } = {}) {
  const f = opts.fetchImpl || fetch;
  const due = (await db.query(`SELECT d.*, w.url, w.secret, COALESCE(w.active, c.enabled) AS active FROM webhook_deliveries d LEFT JOIN webhooks w ON w.id=d.webhook_id LEFT JOIN connectors c ON c.id=d.connector_id
    WHERE d.status='pending' AND d.next_at<=NOW() ORDER BY d.id LIMIT ${Math.max(1, Math.min(50, opts.limit || 10))}`)).rows;
  for (const d of due) {
    const attempts = Number(d.attempts) + 1;
    if (!d.active) { await db.query("UPDATE webhook_deliveries SET status='cancelled', attempts=$1 WHERE id=$2", [attempts - 1, d.id]); continue; }
    let code: number | null = null, err: string | null = null;
    if (d.connector_id) {
      try {
        if (!connectorDeliver) throw new Error("connectors not loaded");
        const r = await connectorDeliver(db, d, f);
        await db.query(`UPDATE webhook_deliveries SET status=$1, attempts=$2, response_code=$3, detail=$4, last_error=NULL, delivered_at=NOW() WHERE id=$5`, [r.sample ? "sample" : "delivered", attempts, r.code, r.detail ?? null, d.id]);
        continue;
      } catch (e: any) { err = String(e.message || e).slice(0, 300); code = Number(e.status) || null; }
    } else try {
      const bad = await checkUrl(d.url); if (bad) throw new Error(bad);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await f(d.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs || 8000),
        headers: { "Content-Type": "application/json", "User-Agent": "FieldForce-Webhooks/1", "X-FieldForce-Event": d.event, "X-FieldForce-Delivery": String(d.id),
          "X-FieldForce-Timestamp": ts, "X-FieldForce-Signature": sign(d.secret, ts, d.payload) }, body: d.payload });
      code = r.status; if (r.status < 200 || r.status >= 300) err = `HTTP ${r.status}`;
    } catch (e: any) { err = String(e.message || e).slice(0, 300); }
    if (!err) await db.query("UPDATE webhook_deliveries SET status='delivered', attempts=$1, response_code=$2, last_error=NULL, delivered_at=NOW() WHERE id=$3", [attempts, code, d.id]);
    else if (attempts >= MAX_ATTEMPTS) await db.query("UPDATE webhook_deliveries SET status='failed', attempts=$1, response_code=$2, last_error=$3 WHERE id=$4", [attempts, code, err, d.id]);
    else await db.query("UPDATE webhook_deliveries SET attempts=$1, response_code=$2, last_error=$3, next_at=$4 WHERE id=$5", [attempts, code, err, new Date(Date.now() + backoffMs(attempts)).toISOString(), d.id]);
  }
  return due.length;
}

/** Start the background sender (every WEBHOOK_POLL_MS, default 15s). Also trims delivery logs older than 30 days once an hour. */
export function startWebhookWorker(db: Db, everyMs = Number(process.env.WEBHOOK_POLL_MS || 15_000)) {
  let busy = false, lastTrim = 0;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      await drain(db);
      if (Date.now() - lastTrim > 3600_000) { lastTrim = Date.now(); await db.query("DELETE FROM webhook_deliveries WHERE created_at < NOW() - INTERVAL '30 days' AND status<>'pending'"); }
    } catch (e: any) { console.error("webhook worker:", e.message); } finally { busy = false; }
  }, everyMs);
  t.unref(); return t;
}
