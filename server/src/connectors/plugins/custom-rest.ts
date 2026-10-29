// Custom REST: any HTTP/JSON endpoint, configured entirely from the admin screen.
import type { ConnectorPlugin } from "../types.js";
import { get, fillTemplate } from "../mapping.js";
import { checkUrl } from "../../integrations/webhooks.js";

/** Render a JSON template: "{{$mapped}}" -> the whole mapped record, "{{path}}" alone -> raw value, otherwise text substitution. */
export function renderTemplate(t: unknown, ctx: Record<string, any>): unknown {
  if (typeof t === "string") {
    const m = /^\{\{\s*([\w.$]+)\s*\}\}$/.exec(t);
    if (m) return get(ctx, m[1]);
    return fillTemplate(t, ctx);
  }
  if (Array.isArray(t)) return t.map(x => renderTemplate(x, ctx));
  if (t && typeof t === "object") return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, renderTemplate(v, ctx)]));
  return t;
}
const vars = (c: Record<string, any>) => { try { return typeof c.vars === "string" ? JSON.parse(c.vars || "{}") : c.vars || {}; } catch { return {}; } };
const tokens = new Map<string, { token: string; exp: number }>();
async function authHeaders(c: Record<string, any>, f: typeof fetch): Promise<Record<string, string>> {
  switch (c.authType) {
    case "apikey": return { [c.authHeader || "X-API-Key"]: String(c.apiKey || "") };
    case "basic": return { Authorization: "Basic " + Buffer.from(`${c.username || ""}:${c.password || ""}`).toString("base64") };
    case "bearer": return { Authorization: `Bearer ${c.token || ""}` };
    case "oauth2": {
      const k = `${c.tokenUrl}|${c.clientId}`, hit = tokens.get(k);
      if (hit && hit.exp > Date.now()) return { Authorization: `Bearer ${hit.token}` };
      const bad = await checkUrl(String(c.tokenUrl || "")); if (bad) throw new Error(`token URL: ${bad}`);
      const r = await f(c.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(8000),
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId || "", client_secret: c.clientSecret || "", ...(c.scope ? { scope: c.scope } : {}) }) });
      if (!r.ok) throw new Error(`token endpoint HTTP ${r.status}`);
      const j: any = await r.json(); tokens.set(k, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 300) * 1000 - 30_000 });
      return { Authorization: `Bearer ${j.access_token}` };
    }
    default: return {};
  }
}
const endpoint = (c: Record<string, any>, entity: string) => {
  const e = (typeof c.endpoints === "string" ? JSON.parse(c.endpoints || "{}") : c.endpoints || {})[entity];
  if (!e || !e.path) throw new Error(`no endpoint set for ${entity}`);
  return e as { method?: string; path: string; template?: unknown; itemsPath?: string; sample?: any[] };
};

const plugin: ConnectorPlugin = {
  type: "custom-rest",
  label: "Custom REST",
  description: "Send orders, invoices, collections or stock to any REST/JSON endpoint, and pull products, customers or stock from one. Set up entirely here.",
  configFields: [
    { key: "baseUrl", label: "Base URL", kind: "text", help: "https://erp.example.com/api" },
    { key: "authType", label: "Auth", kind: "select", options: ["none", "apikey", "basic", "bearer", "oauth2"] },
    { key: "authHeader", label: "API key header", kind: "text", help: "for auth = apikey, e.g. X-API-Key" },
    { key: "apiKey", label: "API key", kind: "secret" },
    { key: "username", label: "Username", kind: "text" }, { key: "password", label: "Password", kind: "secret" },
    { key: "token", label: "Bearer token", kind: "secret" },
    { key: "tokenUrl", label: "OAuth2 token URL", kind: "text" }, { key: "clientId", label: "OAuth2 client id", kind: "text" },
    { key: "clientSecret", label: "OAuth2 client secret", kind: "secret" }, { key: "scope", label: "OAuth2 scope", kind: "text" },
    { key: "endpoints", label: "Endpoints (JSON)", kind: "json", help: '{"orders":{"method":"POST","path":"/orders","template":"{{$mapped}}"},"products":{"method":"GET","path":"/products","itemsPath":"data"}}' },
    { key: "vars", label: "Template variables (JSON)", kind: "json", help: '{"db":"sample-db","uid":2} — use as {{config.db}} in templates' },
    { key: "events", label: "Send on events", kind: "text", help: "comma separated, e.g. order.created,invoice.created" },
    { key: "scheduleMinutes", label: "Also push changes every N minutes (0 = off)", kind: "number" },
  ],
  out: ["orders", "invoices", "collections", "stock"],
  in: ["products", "stock", "customers", "distributors"],
  async send({ config, entity, mapped, record, sample, fetchImpl }) {
    const e = endpoint(config, entity), ctx = { $mapped: mapped, $record: record, ...mapped, config: { ...vars(config), apiKey: config.apiKey, password: config.password } };
    const method = String(e.method || "POST").toUpperCase(), url = String(config.baseUrl || "").replace(/\/$/, "") + fillTemplate(e.path, ctx);
    const body = renderTemplate(e.template ?? "{{$mapped}}", ctx);
    const request = { method, url, body };
    if (sample) { // never show secrets in previews or the delivery log
      let t = JSON.stringify(request); for (const k of ["apiKey", "password", "token", "clientSecret"]) if (config[k]) t = t.split(String(config[k])).join("******");
      return { status: 0, request: JSON.parse(t) };
    }
    const bad = await checkUrl(url); if (bad) throw new Error(bad);
    const r = await fetchImpl(url, { method, redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", ...(await authHeaders(config, fetchImpl)) }, body: method === "GET" ? undefined : JSON.stringify(body) });
    const text = (await r.text()).slice(0, 500);
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
    // JSON-RPC style errors come back as HTTP 200 with an "error" member.
    try { const j = JSON.parse(text); if (j && j.error) throw new Error(`remote error: ${JSON.stringify(j.error).slice(0, 200)}`); } catch (x: any) { if (/^remote error/.test(x.message)) throw x; }
    return { status: r.status, request: { method, url }, response: text };
  },
  async pull({ config, entity, sample, fetchImpl }) {
    const e = endpoint(config, entity);
    if (sample) return Array.isArray(e.sample) ? e.sample : [];
    const url = String(config.baseUrl || "").replace(/\/$/, "") + e.path, method = String(e.method || "GET").toUpperCase();
    const bad = await checkUrl(url); if (bad) throw new Error(bad);
    const r = await fetchImpl(url, { method, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json", ...(await authHeaders(config, fetchImpl)) },
      body: method === "GET" ? undefined : JSON.stringify(renderTemplate(e.template ?? {}, { config: { ...vars(config), apiKey: config.apiKey, password: config.password } })) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json(); const rows = e.itemsPath ? get(j, e.itemsPath) : j;
    return Array.isArray(rows) ? rows.slice(0, 5000) : [];
  },
};
export default plugin;
