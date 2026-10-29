// OpenAPI 3.0 description of /api/v1, plus a tiny same-origin docs page (no CDN, fits the strict CSP).
import { ALL_SCOPES } from "./apikeys.js";
import { EVENTS } from "./webhooks.js";

const S = (type: string, extra: object = {}) => ({ type, ...extra });
const str = S("string"), int = S("integer"), num = S("number"), bool = S("boolean"), ts = S("string", { format: "date-time" }), nstr = S("string", { nullable: true });
const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });

const schemas: Record<string, any> = {
  Product: obj({ id: int, sku: str, barcode: nstr, external_id: nstr, item_code: str, item_external_id: nstr, name: str, category: nstr, kind: str, hsn: nstr, mrp: num, price: num, attrs: S("object", { additionalProperties: str }), updated_at: ts }),
  ProductUpsert: obj({ external_id: str, sku: str, barcode: S("string", { description: "EAN/UPC/QR value for scanning" }), item_code: str, item_external_id: str, name: str, category: str, hsn: str, mrp: num, price: num, units: S("string", { description: "e.g. PCS=1;BOX=12" }), attrs: S("object", { additionalProperties: str }) }, ["mrp", "price"]),
  Stock: obj({ id: int, sku: str, product_external_id: nstr, distributor_id: S("integer", { nullable: true }), distributor_external_id: nstr, batch_no: str, expiry: nstr, qty: S("integer", { description: "base units" }), updated_at: ts }),
  StockUpsert: obj({ sku: str, product_external_id: str, distributor_external_id: str, distributor_id: int, batch_no: str, expiry: S("string", { format: "date" }), qty: int, unit: str }, ["qty"]),
  Customer: obj({ id: int, code: str, external_id: nstr, name: str, owner_name: nstr, phone: nstr, address: nstr, city: nstr, pincode: nstr, state_code: nstr, gstin: nstr, credit_days: S("integer", { nullable: true }), credit_limit: S("number", { nullable: true }), distributor_id: S("integer", { nullable: true }), distributor_external_id: nstr, updated_at: ts }),
  CustomerUpsert: obj({ external_id: str, code: str, name: str, owner_name: str, phone: str, address: str, city: str, pincode: str, state_code: str, gstin: str, credit_days: int, credit_limit: num, distributor_external_id: str }, ["name"]),
  Distributor: obj({ id: int, external_id: nstr, name: str, email: str, phone: nstr, active: bool, updated_at: ts }),
  DistributorUpsert: obj({ external_id: str, name: str, email: str, phone: str }),
  OrderLine: obj({ id: int, sku: str, product_external_id: nstr, uom: str, qty: int, base_qty: int, price: num, discount_pct: num, amount: num, free: bool }),
  Order: obj({ id: int, client_ref: str, external_id: nstr, status: S("string", { enum: ["placed", "accepted", "fulfilled", "rejected"] }), shop_id: int, customer_code: str, customer_external_id: nstr, distributor_id: S("integer", { nullable: true }), rep_id: int, total: num, savings: num, created_at: ts, updated_at: ts, lines: S("array", { items: ref("OrderLine") }) }),
  InvoiceLine: obj({ id: int, sku: str, description: str, hsn: nstr, base_qty: int, uom: str, rate: num, taxable: num, gst_rate: num, cgst: num, sgst: num, igst: num, total: num }),
  Invoice: obj({ id: int, number: str, external_id: nstr, kind: S("string", { enum: ["invoice", "credit_note"] }), issuer: str, fy: str, doc_date: str, order_id: S("integer", { nullable: true }), shop_id: int, customer_code: str, customer_external_id: nstr, place_of_supply: nstr, intra_state: bool, taxable: num, cgst: num, sgst: num, igst: num, round_off: num, total: num, irn: nstr, created_at: ts, lines: S("array", { items: ref("InvoiceLine") }) }),
  Collection: obj({ id: int, number: str, external_id: nstr, issuer: str, shop_id: int, customer_code: str, customer_external_id: nstr, pay_date: str, mode: str, reference: nstr, cheque_date: nstr, amount: num, status: str, bounce_reason: nstr, collected_by: S("integer", { nullable: true }), created_at: ts }),
  User: obj({ id: int, external_id: nstr, name: str, email: str, phone: nstr, role: str, active: bool, updated_at: ts }),
  UpsertResult: obj({ inserted: int, updated: int, errors: S("array", { items: obj({ index: int, external_id: nstr, error: str }) }) }),
  Error: obj({ error: str }),
  WebhookEvent: obj({ id: S("string", { format: "uuid" }), event: S("string", { enum: [...EVENTS] }), created_at: ts, data: S("object") }),
};
const pageParams = [
  { name: "limit", in: "query", schema: S("integer", { minimum: 1, maximum: 500, default: 100 }) },
  { name: "page", in: "query", schema: S("integer", { minimum: 1, default: 1 }) },
  { name: "updated_since", in: "query", description: "Only rows changed at or after this time. Store `server_time` from the last call and pass it next time.", schema: ts },
];
const errs = { 401: { description: "Missing, invalid or revoked key", content: { "application/json": { schema: ref("Error") } } }, 403: { description: "Key lacks the scope" }, 429: { description: "Rate limited (see Retry-After)" } };
const listOp = (tag: string, schema: string, scope: string, extra: any[] = []) => ({ get: {
  tags: [tag], summary: `List ${tag.toLowerCase()}`, operationId: `list${tag.replace(/\W/g, "")}`, description: `Scope: \`${scope}\``, parameters: [...pageParams, ...extra],
  responses: { 200: { description: "A page", content: { "application/json": { schema: obj({ data: S("array", { items: ref(schema) }), page: int, limit: int, has_more: bool, next_page: S("integer", { nullable: true }), server_time: ts }) } } }, ...errs } } });
const upsertOp = (tag: string, schema: string, scope: string, how: string) => ({ post: {
  tags: [tag], summary: `Upsert ${tag.toLowerCase()} by external_id`, operationId: `upsert${tag.replace(/\W/g, "")}`, description: `Scope: \`${scope}\`. ${how} Up to 500 rows per call; each row succeeds or fails on its own.`,
  requestBody: { required: true, content: { "application/json": { schema: obj({ items: S("array", { items: ref(schema), maxItems: 500 }) }, ["items"]) } } },
  responses: { 200: { description: "Per-row result", content: { "application/json": { schema: ref("UpsertResult") } } }, ...errs } } });
const getOp = (tag: string, schema: string, scope: string) => ({ get: { tags: [tag], summary: `Get one`, operationId: `get${schema}`, description: `Scope: \`${scope}\``,
  parameters: [{ name: "id", in: "path", required: true, schema: int }], responses: { 200: { description: "Found", content: { "application/json": { schema: ref(schema) } } }, 404: { description: "Not found" }, ...errs } } });

export function openapiSpec() {
  return {
    openapi: "3.0.3",
    info: { title: "OwnField public API", version: "1.0.0", license: { name: "AGPL-3.0-only" },
      description: "Versioned REST API for ERP, DMS and WMS integrations. Authenticate with a company API key (`Authorization: Bearer ffk_...` or `X-API-Key`). Admins create keys under Integrations. Webhooks are signed with HMAC-SHA256: `X-FieldForce-Signature: sha256=hex(HMAC(secret, timestamp + '.' + body))`, timestamp in `X-FieldForce-Timestamp`." },
    servers: [{ url: "/api/v1" }],
    security: [{ bearer: [] }, { apiKey: [] }],
    tags: ["Products", "Stock", "Customers", "Distributors", "Orders", "Invoices", "Collections", "Users"].map(name => ({ name })),
    paths: {
      "/me": { get: { summary: "Who am I (company and scopes)", operationId: "me", responses: { 200: { description: "OK" }, ...errs } } },
      "/products": listOp("Products", "Product", "products:read"),
      "/products/{id}": getOp("Products", "Product", "products:read"),
      "/products/upsert": upsertOp("Products", "ProductUpsert", "products:write", "Matches by external_id, then sku."),
      "/stock": listOp("Stock", "Stock", "stock:read"),
      "/stock/upsert": upsertOp("Stock", "StockUpsert", "stock:write", "SETS the quantity for (location, sku, batch). No distributor = company warehouse."),
      "/customers": listOp("Customers", "Customer", "customers:read"),
      "/customers/{id}": getOp("Customers", "Customer", "customers:read"),
      "/customers/upsert": upsertOp("Customers", "CustomerUpsert", "customers:write", "Matches by external_id, then code."),
      "/distributors": listOp("Distributors", "Distributor", "distributors:read"),
      "/distributors/upsert": upsertOp("Distributors", "DistributorUpsert", "distributors:write", "Matches by external_id, then email. New distributors cannot sign in until an admin issues a reset code."),
      "/orders": listOp("Orders", "Order", "orders:read", [{ name: "status", in: "query", schema: str }]),
      "/orders/{id}": getOp("Orders", "Order", "orders:read"),
      "/orders/{id}/external-id": { put: { tags: ["Orders"], summary: "Write back the ERP document number", operationId: "setOrderExternalId", description: "Scope: `orders:write`",
        parameters: [{ name: "id", in: "path", required: true, schema: int }], requestBody: { required: true, content: { "application/json": { schema: obj({ external_id: str }, ["external_id"]) } } },
        responses: { 200: { description: "Saved" }, 404: { description: "Not found" }, ...errs } } },
      "/invoices": listOp("Invoices", "Invoice", "invoices:read"),
      "/collections": listOp("Collections", "Collection", "collections:read"),
      "/users": listOp("Users", "User", "users:read"),
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Company API key" }, apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      schemas,
    },
    "x-scopes": ALL_SCOPES,
    "x-webhook-events": [...EVENTS],
  };
}

export const DOCS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OwnField API docs</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1c2430;background:#f7f8fa}main{max-width:960px;margin:auto;padding:24px}
h1{margin:0 0 4px}.op{background:#fff;border:1px solid #e2e5ea;border-radius:8px;margin:10px 0;padding:10px 14px}
.m{display:inline-block;min-width:56px;font-weight:700;font-family:monospace}.get{color:#0a7}.post{color:#06c}.put{color:#a60}
code,pre{font-family:ui-monospace,monospace;font-size:13px}pre{background:#f0f2f5;padding:10px;border-radius:6px;overflow:auto}
details summary{cursor:pointer}.tag{margin-top:28px}</style></head>
<body><main><h1>OwnField public API v1</h1><p>Machine-readable spec: <a href="openapi.json">openapi.json</a> (OpenAPI 3). Generate clients with
<code>npx @openapitools/openapi-generator-cli generate -i &lt;this-site&gt;/api/v1/openapi.json -g python -o ./ff-client</code>. Full guide: INTEGRATIONS.md in the repository.</p>
<div id="app">Loading…</div></main><script src="docs.js"></script></body></html>`;

export const DOCS_JS = `(async function(){
var el=document.getElementById('app');var s=await (await fetch('openapi.json')).json();
function esc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function sch(x){if(!x)return'';if(x.$ref){var n=x.$ref.split('/').pop();return'<a href="#s-'+n+'">'+n+'</a>'}if(x.type==='array')return sch(x.items)+'[]';if(x.properties)return'{ '+Object.keys(x.properties).map(function(k){return esc(k)+': '+sch(x.properties[k])}).join(', ')+' }';return esc(x.type||'object')}
var h='<p>'+esc(s.info.description)+'</p><p><b>Scopes:</b> <code>'+s['x-scopes'].join('</code> <code>')+'</code></p><p><b>Webhook events:</b> <code>'+s['x-webhook-events'].join('</code> <code>')+'</code></p>';
Object.keys(s.paths).forEach(function(p){Object.keys(s.paths[p]).forEach(function(m){var o=s.paths[p][m];
h+='<div class="op"><span class="m '+m+'">'+m.toUpperCase()+'</span> <code>/api/v1'+esc(p)+'</code> — '+esc(o.summary)+'<details><summary>details</summary><p>'+esc(o.description||'')+'</p>';
if(o.parameters)h+='<p>Parameters: '+o.parameters.map(function(q){return'<code>'+esc(q.name)+'</code> ('+q.in+')'}).join(', ')+'</p>';
if(o.requestBody)h+='<p>Body: '+sch(o.requestBody.content['application/json'].schema)+'</p>';
var ok=o.responses[200];if(ok&&ok.content)h+='<p>Returns: '+sch(ok.content['application/json'].schema)+'</p>';h+='</details></div>'})});
h+='<h2 class="tag">Schemas</h2>';Object.keys(s.components.schemas).forEach(function(n){h+='<div class="op" id="s-'+n+'"><b>'+n+'</b><pre>'+esc(JSON.stringify(s.components.schemas[n].properties||s.components.schemas[n],null,1))+'</pre></div>'});
el.innerHTML=h})();`;
