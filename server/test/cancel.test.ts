import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, db: any; const T: Record<string, string> = {}; const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
const place = async () => (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: `c${++n}`, shopId: ids.s1, lines: [{ variantId: ids.v, qty: 2 }] }).expect(201)).body;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "ACME", name: "ACME", userLimit: 20, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.a = await login("ACME", "a@x.com");
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep One", "r1@x.com", "sales_rep", "pw"], ["Rep Two", "r2@x.com", "sales_rep", "pw"], ["Dist One", "d1@x.com", "distributor", "pw"]]), "u.csv");
  await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email"], ["S1", "Shop 1", "d1@x.com"]]), "s.csv");
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-2Y", "2Y", "400", "300"]]), "p.csv");
  for (const k of ["r1", "r2", "d1"]) T[k] = await login("ACME", `${k}@x.com`);
  ids.s1 = (await request(app).get("/api/shops").set(H("a"))).body[0].id;
  ids.v = (await db.query("SELECT id FROM variants WHERE sku='T-2Y'")).rows[0].id;
});

describe("order cancel / reject reason", () => {
  it("rep cancels own new order with a reason; others cannot; reason required", async () => {
    const o = await place();
    await request(app).post(`/api/orders/${o.id}/cancel`).set(H("r2")).send({ reason: "x" }).expect(404);
    await request(app).post(`/api/orders/${o.id}/cancel`).set(H("r1")).send({}).expect(400);
    const c = (await request(app).post(`/api/orders/${o.id}/cancel`).set(H("r1")).send({ reason: "shop changed mind" }).expect(200)).body;
    expect(c.status).toBe("cancelled"); expect(c.status_reason).toBe("shop changed mind");
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(409);
    await request(app).post(`/api/orders/${o.id}/cancel`).set(H("r1")).send({ reason: "again" }).expect(409);
  });
  it("rep cannot cancel after acceptance; distributor can; delivered cannot", async () => {
    const o = await place();
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    await request(app).post(`/api/orders/${o.id}/cancel`).set(H("r1")).send({ reason: "x" }).expect(409);
    expect((await request(app).post(`/api/orders/${o.id}/cancel`).set(H("d1")).send({ reason: "out of route" }).expect(200)).body.status).toBe("cancelled");
    const p = await place();
    await request(app).post(`/api/orders/${p.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    await request(app).post(`/api/orders/${p.id}/status`).set(H("d1")).send({ status: "fulfilled" }).expect(200);
    await request(app).post(`/api/orders/${p.id}/cancel`).set(H("a")).send({ reason: "x" }).expect(409);
  });
  it("reject keeps the distributor's reason", async () => {
    const o = await place();
    const r = (await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "rejected", reason: "credit overdue" }).expect(200)).body;
    expect(r.status_reason).toBe("credit overdue");
  });
});
