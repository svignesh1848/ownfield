import { openField } from "../fieldcrypt.js";
// Outgoing webhooks: a small DB-backed queue (webhook_deliveries) drained by an in-process timer. No extra infra.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
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
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    // IPv4-mapped / -compatible / NAT64 forms (::ffff:a9fe:a9fe, ::a9fe:a9fe, 64:ff9b::…) hide an IPv4 address: check that address.
    const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(l);
    if (m) { if (m[1]) return privateIp(m[1]); const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16); return privateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return l === "::1" || l === "::" || /^f[cd]|^fe[89ab]|^ff|^2002:|^64:ff9b:/.test(l);
  }
  const [a, b] = ip.split(".").map(Number);
  if (ip.split(".").length !== 4 || [a, b].some(n => !Number.isInteger(n))) return true; // not a plain IPv4: refuse
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export type PinnedHost = { url: string; host: string; addresses: string[] };
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup-compatible function that only returns already-validated addresses (no second resolve). */
export function pinnedLookup(addresses: string[]) {
  const all: LookupAddress[] = addresses.map(address => ({ address, family: (net.isIPv6(address) ? 6 : 4) as 4 | 6 }));
  return (hostname: string, options: LookupOptions, cb?: LookupCb) => {
    const fn = (typeof options === "function" ? options : cb) as LookupCb;
    const opts = (typeof options === "function" ? {} : options) || {};
    if (!all.length) { fn(Object.assign(new Error("No pinned address"), { code: "ENOTFOUND" }) as NodeJS.ErrnoException, "", 0); return; }
    if (opts.all) fn(null, all);
    else fn(null, all[0].address, all[0].family);
  };
}

/**
 * Resolve once, refuse if any address is private, and return the validated IPs so the later
 * HTTP connect can pin them (closes the DNS-rebinding window between checkUrl and fetch).
 */
export async function pinUrl(raw: string, resolve = process.env.WEBHOOK_ALLOW_PRIVATE !== "1", lookup: typeof dns.lookup = dns.lookup): Promise<{ ok: true; pin: PinnedHost } | { ok: false; error: string }> {
  let u: URL; try { u = new URL(raw); } catch { return { ok: false, error: "Enter a full URL, e.g. https://erp.example.com/hooks/ownfield" }; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && process.env.WEBHOOK_ALLOW_HTTP === "1")) return { ok: false, error: "URL must start with https://" };
  if (u.username || u.password) return { ok: false, error: "Put credentials in your receiver, not in the URL" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!resolve) return { ok: true, pin: { url: raw, host, addresses: [] } };
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return { ok: false, error: "Private addresses are not allowed" };
  try {
    const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(privateIp)) return { ok: false, error: "Private addresses are not allowed" };
    return { ok: true, pin: { url: raw, host, addresses: addrs } };
  } catch { return { ok: false, error: "Could not resolve that host" }; }
}

/** Webhook URLs must be https (http only when WEBHOOK_ALLOW_HTTP=1) and must not point at private/loopback/metadata addresses. */
export async function checkUrl(raw: string, resolve = process.env.WEBHOOK_ALLOW_PRIVATE !== "1"): Promise<string | null> {
  const r = await pinUrl(raw, resolve);
  return r.ok ? null : r.error;
}

function bodyToBuffer(body: unknown): Buffer | undefined {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(String(body));
}

/** Connect to the already-validated IP(s) while keeping the original Host header and TLS SNI. */
export function pinnedRequest(pin: PinnedHost, init: RequestInit = {}): Promise<Response> {
  const u = new URL(pin.url);
  const isHttps = u.protocol === "https:";
  const lib = isHttps ? https : http;
  const lookup = pin.addresses.length ? pinnedLookup(pin.addresses) : undefined;
  const headers = new Headers(init.headers);
  const body = bodyToBuffer(init.body as any);
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));
  const hdrs: http.OutgoingHttpHeaders = {};
  headers.forEach((v, k) => { hdrs[k] = v; });
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: pin.host,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: (init.method || "GET").toUpperCase(),
      headers: hdrs,
      lookup: lookup as any,
      servername: isHttps ? pin.host : undefined,
      signal: init.signal as any,
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c as Buffer));
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          if (Array.isArray(v)) for (const x of v) h.append(k, x);
          else h.set(k, v);
        }
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 0, statusText: res.statusMessage || "", headers: h }));
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Validate (and pin) the URL, then fetch. A custom fetchImpl is only used in tests; production always pins the IP. */
export async function safeFetch(raw: string, init: RequestInit = {}, fetchImpl?: typeof fetch): Promise<Response> {
  const r = await pinUrl(raw, process.env.WEBHOOK_ALLOW_PRIVATE !== "1");
  if (!r.ok) throw new Error(r.error);
  const opts: RequestInit = { ...init, redirect: init.redirect ?? "manual" };
  if (fetchImpl && fetchImpl !== fetch) return fetchImpl(raw, opts);
  return pinnedRequest(r.pin, opts);
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
    if (messageHook) await messageHook(db, companyId, event, data);
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
let messageHook: ((db: Db, cid: number, event: string, data: any) => Promise<unknown>) | null = null;
export function setMessageHook(fn: typeof messageHook) { messageHook = fn; }
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
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await safeFetch(d.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs || 8000),
        headers: { "Content-Type": "application/json", "User-Agent": "OwnField-Webhooks/1", "X-FieldForce-Event": d.event, "X-FieldForce-Delivery": String(d.id),
          "X-FieldForce-Timestamp": ts, "X-FieldForce-Signature": sign(openField(d.secret)!, ts, d.payload) }, body: d.payload }, opts.fetchImpl);
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
