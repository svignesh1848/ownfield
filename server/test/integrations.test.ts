import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";
import { drain, sign, backoffMs } from "../src/integrations/webhooks.js";
import { applyMapping, formatDate } from "../src/connectors/mapping.js";
import { tallyXml } from "../src/connectors/plugins/tally-xml.js";
import { plugins } from "../src/connectors/registry.js";

process.env.WEBHOOK_ALLOW_PRIVATE = "1"; // tests use example hosts without DNS
let app: any, db: any; const T: Record<string, string> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let key = "", roKey = "", shopId = 0;

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const code of ["IN", "OT"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code, name: `${code} (sample)`, industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("IN", "a@x.com"); T.oth = await login("OT", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.rep = await login("IN", "r@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false, stock: true } }).expect(200);
  shopId = (await request(app).get("/api/shops").set(as("adm"))).body[0].id;
});

describe("API keys and /api/v1", () => {
  it("serves the OpenAPI spec and docs without a key", async () => {
    const s = (await request(app).get("/api/v1/openapi.json").expect(200)).body;
    expect(s.openapi).toBe("3.0.3"); expect(Object.keys(s.paths)).toContain("/products/upsert");
    expect((await request(app).get("/api/v1/docs").expect(200)).text).toContain("docs.js");
  });
  it("admin creates a scoped key (hashed at rest), others cannot", async () => {
    await request(app).post("/api/integrations/keys").set(as("rep")).send({ name: "x", scopes: ["products:read"] }).expect(403);
    await request(app).post("/api/integrations/keys").set(as("adm")).send({ name: "x", scopes: ["bogus"] }).expect(400);
    const r = (await request(app).post("/api/integrations/keys").set(as("adm")).send({ name: "ERP sync", scopes: ["products:read", "products:write", "stock:read", "stock:write", "customers:read", "customers:write", "distributors:write", "orders:read", "orders:write", "invoices:read"] }).expect(201)).body;
    key = r.key; expect(key).toMatch(/^ffk_/);
    const row = (await db.query("SELECT key_hash FROM api_keys WHERE id=$1", [r.id])).rows[0];
    expect(row.key_hash).not.toContain(key.slice(13));
    roKey = (await request(app).post("/api/integrations/keys").set(as("adm")).send({ name: "Read only", scopes: ["products:read"] }).expect(201)).body.key;
    expect((await request(app).get("/api/integrations/keys").set(as("adm"))).body.keys[0]).not.toHaveProperty("key_hash");
  });
  it("authenticates, enforces scopes and paginates", async () => {
    await request(app).get("/api/v1/products").expect(401);
    await request(app).get("/api/v1/products").set("X-API-Key", "ffk_00000000_" + "a".repeat(30)).expect(401);
    const me = (await request(app).get("/api/v1/me").set("Authorization", `Bearer ${key}`).expect(200)).body;
    expect(me.company.code).toBe("IN");
    await request(app).post("/api/v1/products/upsert").set("X-API-Key", roKey).send({ items: [{ sku: "x" }] }).expect(403);
    const p = (await request(app).get("/api/v1/products?limit=2").set("X-API-Key", roKey).expect(200)).body;
    expect(p.data.length).toBe(2); expect(p.has_more).toBe(true); expect(p.next_page).toBe(2);
    await request(app).get("/api/v1/products?updated_since=nope").set("X-API-Key", roKey).expect(400);
  });
  it("upserts master data and stock by external_id, filters by updated_since", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const up = (await request(app).post("/api/v1/products/upsert").set("X-API-Key", key).send({ items: [
      { external_id: "ERP-P1", sku: "SAMPLE-ERP-1", name: "Sample ERP shirt", mrp: 500, price: 400 },
      { external_id: "ERP-P2", sku: "SAMPLE-ERP-2", name: "Bad", mrp: 100, price: 200 }] }).expect(200)).body;
    expect(up.inserted).toBe(1); expect(up.errors[0]).toMatchObject({ index: 1, external_id: "ERP-P2" });
    const again = (await request(app).post("/api/v1/products/upsert").set("X-API-Key", key).send({ items: [{ external_id: "ERP-P1", name: "Sample ERP shirt v2", mrp: 520, price: 410 }] }).expect(200)).body;
    expect(again.updated).toBe(1);
    const changed = (await request(app).get(`/api/v1/products?updated_since=${encodeURIComponent(since)}`).set("X-API-Key", key).expect(200)).body.data;
    expect(changed.map((x: any) => x.external_id)).toContain("ERP-P1");
    expect(changed.find((x: any) => x.external_id === "ERP-P1")).toMatchObject({ name: "Sample ERP shirt v2", price: 410 });
    const d = (await request(app).post("/api/v1/distributors/upsert").set("X-API-Key", key).send({ items: [{ external_id: "ERP-D1", name: "Sample Distributor", email: "dist.sample@example.com" }] }).expect(200)).body;
    expect(d.inserted).toBe(1);
    const c = (await request(app).post("/api/v1/customers/upsert").set("X-API-Key", key).send({ items: [{ external_id: "ERP-C1", code: "SMP-C1", name: "Sample Shop One", city: "Chennai", distributor_external_id: "ERP-D1", credit_days: 15 }] }).expect(200)).body;
    expect(c.inserted).toBe(1);
    const cust = (await request(app).get("/api/v1/customers").set("X-API-Key", key).expect(200)).body.data.find((x: any) => x.external_id === "ERP-C1");
    expect(cust).toMatchObject({ code: "SMP-C1", distributor_external_id: "ERP-D1", credit_days: 15 });
    const s = (await request(app).post("/api/v1/stock/upsert").set("X-API-Key", key).send({ items: [{ product_external_id: "ERP-P1", qty: 40 }, { product_external_id: "ERP-P1", distributor_external_id: "ERP-D1", qty: 5 }] }).expect(200)).body;
    expect(s.errors).toEqual([]);
    const st = (await request(app).get("/api/v1/stock?limit=500").set("X-API-Key", key).expect(200)).body.data.filter((x: any) => x.product_external_id === "ERP-P1");
    expect(st.map((x: any) => x.qty).sort()).toEqual([40, 5]);
    // tenant isolation: the other company sees nothing of this
    const k2 = (await request(app).post("/api/integrations/keys").set(as("oth")).send({ name: "o", scopes: ["products:read"] }).expect(201)).body.key;
    expect((await request(app).get("/api/v1/products?limit=500").set("X-API-Key", k2)).body.data.some((x: any) => x.external_id === "ERP-P1")).toBe(false);
  });
  it("revoked keys stop working and actions are audit-logged", async () => {
    const r = (await request(app).post("/api/integrations/keys").set(as("adm")).send({ name: "Temp", scopes: ["products:read"] }).expect(201)).body;
    await request(app).get("/api/v1/products").set("X-API-Key", r.key).expect(200);
    await request(app).delete(`/api/integrations/keys/${r.id}`).set(as("adm")).expect(200);
    await request(app).get("/api/v1/products").set("X-API-Key", r.key).expect(401);
    const acts = (await db.query("SELECT action FROM security_audit_log")).rows.map((x: any) => x.action);
    expect(acts).toEqual(expect.arrayContaining(["apikey.create", "apikey.revoke", "api.products.upsert"]));
  });
});

describe("webhooks", () => {
  let hookId = 0, secret = "";
  it("rejects bad URLs and registers a signed webhook", async () => {
    await request(app).post("/api/integrations/webhooks").set(as("adm")).send({ url: "http://erp.example.com/h", events: ["order.created"] }).expect(400);
    await request(app).post("/api/integrations/webhooks").set(as("adm")).send({ url: "https://erp.example.com/h", events: ["nope"] }).expect(400);
    const r = (await request(app).post("/api/integrations/webhooks").set(as("adm")).send({ url: "https://erp.example.com/h", events: ["order.created", "order.approved", "invoice.created", "stock.low"] }).expect(201)).body;
    hookId = r.id; secret = r.secret; expect(secret).toMatch(/^whsec_/);
  });
  it("queues events on order flow, signs with HMAC and retries with backoff", async () => {
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "wh1", shopId, lines: [{ sku: "SAMPLE-ERP-1", qty: 2 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
    const q = (await db.query("SELECT event FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id", [hookId])).rows.map((x: any) => x.event);
    expect(q).toEqual(expect.arrayContaining(["order.created", "order.approved"]));
    const seen: any[] = [];
    let fail = true;
    const fake: any = async (url: string, init: any) => { seen.push({ url, init }); return { status: fail ? 503 : 200 }; };
    await drain(db, { fetchImpl: fake, limit: 50 });
    const h = seen[0].init.headers;
    expect(h["X-FieldForce-Signature"]).toBe(sign(secret, h["X-FieldForce-Timestamp"], seen[0].init.body));
    expect(h["X-FieldForce-Signature"]).toBe("sha256=" + crypto.createHmac("sha256", secret).update(`${h["X-FieldForce-Timestamp"]}.${seen[0].init.body}`).digest("hex"));
    const d = (await db.query("SELECT * FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id LIMIT 1", [hookId])).rows[0];
    expect(d.status).toBe("pending"); expect(d.attempts).toBe(1); expect(new Date(d.next_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(backoffMs(3)).toBe(120_000);
    await db.query("UPDATE webhook_deliveries SET next_at=NOW() WHERE webhook_id=$1", [hookId]);
    fail = false; await drain(db, { fetchImpl: fake, limit: 50 });
    expect((await db.query("SELECT status FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id LIMIT 1", [hookId])).rows[0].status).toBe("delivered");
    const log = (await request(app).get("/api/integrations/deliveries").set(as("adm")).expect(200)).body;
    expect(log.length).toBeGreaterThan(0); expect(log[0]).toHaveProperty("target");
  });
});

describe("connectors", () => {
  it("mapping engine: rename, constant, date, number, lookup, template, nested lines", () => {
    const rec = { id: 7, created_at: "2026-10-29T10:05:00Z", total: 12.345, mode: "cash", customer: { code: "C1" }, lines: [{ sku: "A", qty: 2 }] };
    expect(applyMapping([
      { to: "ref", from: "id" }, { to: "type", transform: "constant", value: "OR" }, { to: "d", from: "created_at", transform: "date", format: "DD.MM.YYYY" },
      { to: "amt", from: "total", transform: "number", format: "2" }, { to: "ledger", from: "mode", transform: "lookup", table: { cash: "Cash", "*": "Bank" } },
      { to: "party.code", from: "customer.code" }, { to: "note", transform: "template", value: "Order {{id}}" }, { to: "items", from: "lines", each: [{ to: "m", from: "sku" }, { to: "q", from: "qty" }] },
      { to: "x", from: "missing", default: "D" },
    ], rec)).toEqual({ ref: 7, type: "OR", d: "29.10.2026", amt: 12.35, ledger: "Cash", party: { code: "C1" }, note: "Order 7", items: [{ m: "A", q: 2 }], x: "D" });
    expect(formatDate("2026-01-05", "YYYYMMDD")).toBe("20260105");
    expect(tallyXml([{ voucher_type: "Sales", voucher_no: "S/1", date: "20261029", party: "Sample & Co", amount: 10, lines: [{ item: "Shirt", qty: 1, uom: "Nos", rate: 10, amount: 10 }] }])).toContain("Sample &amp; Co");
  });
  it("loads plugins from the plugins folder", async () => {
    expect([...(await plugins()).keys()]).toEqual(expect.arrayContaining(["custom-rest", "file", "tally-xml"]));
  });
  it("presets create sample-mode connectors; test-send records the request without calling out", async () => {
    const list = (await request(app).get("/api/integrations/connectors").set(as("adm")).expect(200)).body;
    expect(list.presets.map((p: any) => p.id)).toEqual(expect.arrayContaining(["odoo", "sap", "tally", "logic-erp", "wms", "csv"]));
    const c = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ preset: "odoo" }).expect(201)).body;
    expect(c.mode).toBe("sample"); expect(c.enabled).toBe(false);
    const t = (await request(app).post(`/api/integrations/connectors/${c.id}/test`).set(as("adm")).expect(200)).body;
    expect(t.status).toBe("sample");
    const sent = JSON.parse(t.detail);
    expect(sent.url).toBe("https://odoo.example.com/jsonrpc"); expect(sent.body.params.args[3]).toBe("sale.order");
    expect(sent.body.params.args[5][0].client_order_ref).toBe("wh1");
    const pr = (await request(app).post(`/api/integrations/connectors/${c.id}/pull`).set(as("adm")).send({ entity: "products" }).expect(200)).body;
    expect(pr).toMatchObject({ sample: true, fetched: 1, inserted: 1 });
    // secrets are masked and kept when the masked value is sent back
    await request(app).patch(`/api/integrations/connectors/${c.id}`).set(as("adm")).send({ config: { apiKey: "sample-secret" } }).expect(200);
    const again = (await request(app).patch(`/api/integrations/connectors/${c.id}`).set(as("adm")).send({ config: { apiKey: "******" }, enabled: true }).expect(200)).body;
    expect(again.config.apiKey).toBe("******");
    expect(JSON.parse((await db.query("SELECT config FROM connectors WHERE id=$1", [c.id])).rows[0].config).apiKey).toBe("sample-secret");
    await request(app).patch(`/api/integrations/connectors/${c.id}`).set(as("adm")).send({ mapping: { orders: [{ transform: "x" }] } }).expect(400);
  });
  it("Logic ERP stays parked; file connector exports and imports with a mapping", async () => {
    const l = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ preset: "logic-erp" }).expect(201)).body;
    await request(app).patch(`/api/integrations/connectors/${l.id}`).set(as("adm")).send({ mode: "live" }).expect(400);
    const f = await request(app).get(`/api/integrations/connectors/${l.id}/export?entity=orders`).set(as("adm")).expect(200);
    expect(f.text.split("\r\n")[0]).toContain("Bill No"); expect(f.text).toContain("items.Item Code");
    const tally = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ preset: "tally" }).expect(201)).body;
    expect((await request(app).get(`/api/integrations/connectors/${tally.id}/export?entity=orders`).set(as("adm")).expect(200)).text).toContain("<VOUCHER");
    const file = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ type: "file", name: "Shop sheet" }).expect(201)).body;
    await request(app).patch(`/api/integrations/connectors/${file.id}`).set(as("adm")).send({ mapping: { customers: [{ to: "code", from: "Party Code" }, { to: "name", from: "Party Name" }, { to: "city", from: "Town", transform: "upper" }] } }).expect(200);
    const im = (await request(app).post(`/api/integrations/connectors/${file.id}/import?entity=customers`).set(as("adm")).attach("file", csv([["Party Code", "Party Name", "Town"], ["SMP-F1", "Sample File Shop", "madurai"]]), "c.csv").expect(200)).body;
    expect(im.inserted).toBe(1);
    expect((await request(app).get("/api/shops").set(as("adm"))).body.find((s: any) => s.code === "SMP-F1").city).toBe("MADURAI");
  });
  it("inbound webhook maps and upserts, with optional HMAC", async () => {
    const c = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ type: "custom-rest", name: "Inbound" }).expect(201)).body;
    await request(app).patch(`/api/integrations/connectors/${c.id}`).set(as("adm")).send({ enabled: true, config: { inboundSecret: "s3" }, mapping: { stock: [{ to: "sku", from: "item" }, { to: "qty", from: "on_hand", transform: "number" }] } }).expect(200);
    const path = c.inbound_path.replace("{entity}", "stock"), body = JSON.stringify([{ item: "SAMPLE-ERP-1", on_hand: "3" }]);
    await request(app).post(path).set("Content-Type", "application/json").send(body).expect(401);
    const sig = "sha256=" + crypto.createHmac("sha256", "s3").update(body).digest("hex");
    const r = (await request(app).post(path).set("Content-Type", "application/json").set("X-Signature", sig).send(body).expect(200)).body;
    expect(r.errors).toEqual([]);
    expect((await db.query("SELECT event FROM webhook_deliveries WHERE event='stock.low'")).rows.length).toBeGreaterThan(0);
    await request(app).post("/api/v1/inbound/wrong-token/stock").send([{}]).expect(404);
  });
});

describe("two-way sync through a live Custom REST connector", () => {
  it("pulls products and stock on schedule, pushes orders and invoices on events", async () => {
    await request(app).put("/api/company/settings").set(as("adm")).send({ gst: { legalName: "IN Sample Co", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
    const c = (await request(app).post("/api/integrations/connectors").set(as("adm")).send({ type: "custom-rest", name: "Sample ERP" }).expect(201)).body;
    const endpoints = { orders: { method: "POST", path: "/so", template: { order: "{{$mapped}}" } }, invoices: { method: "POST", path: "/inv" },
      products: { method: "GET", path: "/items", itemsPath: "items" }, stock: { method: "GET", path: "/stock" } };
    await request(app).patch(`/api/integrations/connectors/${c.id}`).set(as("adm")).send({ enabled: true, mode: "live",
      config: { baseUrl: "https://erp.example.com/api", authType: "bearer", token: "sample-token", endpoints, events: "order.created,invoice.created", scheduleMinutes: 5, pull: "products,stock" },
      mapping: { products: [{ to: "external_id", from: "code" }, { to: "sku", from: "code" }, { to: "name", from: "title" }, { to: "mrp", from: "mrp" }, { to: "price", from: "rate" }],
        stock: [{ to: "product_external_id", from: "code" }, { to: "qty", from: "on_hand" }], orders: [{ to: "ref", from: "client_ref" }, { to: "party", from: "customer.code" }, { to: "items", from: "lines", each: [{ to: "item", from: "sku" }, { to: "q", from: "base_qty" }] }] } }).expect(200);
    const calls: any[] = [];
    const fake: any = async (url: string, init: any) => {
      calls.push({ url, method: init?.method, auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : null });
      const json = url.endsWith("/items") ? { items: [{ code: "SAMPLE-SYNC-1", title: "Sample synced item", mrp: 90, rate: 75 }] } : url.endsWith("/stock") ? [{ code: "SAMPLE-SYNC-1", on_hand: 12 }] : { ok: true };
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
    };
    const { scheduleTick } = await import("../src/connectors/service.js");
    await scheduleTick(db, Date.now(), fake);
    expect((await request(app).get("/api/v1/products?limit=500").set("X-API-Key", key)).body.data.find((p: any) => p.external_id === "SAMPLE-SYNC-1")).toMatchObject({ name: "Sample synced item", price: 75 });
    expect((await request(app).get("/api/v1/stock?limit=500").set("X-API-Key", key)).body.data.find((x: any) => x.product_external_id === "SAMPLE-SYNC-1").qty).toBe(12);
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "sync1", shopId, lines: [{ sku: "SAMPLE-SYNC-1", qty: 2 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
    await request(app).post(`/api/orders/${o.id}/invoice`).set(as("adm")).send({}).expect(201);
    await db.query("UPDATE webhook_deliveries SET next_at=NOW() WHERE connector_id=$1", [c.id]);
    await drain(db, { fetchImpl: fake, limit: 50 });
    const so = calls.find(x => x.url.endsWith("/so") && x.body.order.ref === "sync1"), inv = calls.find(x => x.url.endsWith("/inv"));
    expect(so.auth).toBe("Bearer sample-token"); expect(so.body.order).toMatchObject({ ref: "sync1", items: [{ item: "SAMPLE-SYNC-1", q: 2 }] });
    expect(inv.body.number).toBeTruthy();
    const st = (await db.query("SELECT status FROM webhook_deliveries WHERE connector_id=$1", [c.id])).rows.map((r: any) => r.status);
    expect(st.every((x: string) => x === "delivered")).toBe(true);
  });
});
