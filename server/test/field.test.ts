import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { dayKey } from "../src/field.js";

let app: any; const T: Record<string, string> = {}; const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); const db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const code of ["ACME", "BETA"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code, name: code, userLimit: 20, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.a = await login("ACME", "a@x.com"); T.b = await login("BETA", "a@x.com");
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"],
    ["Rep One", "r1@x.com", "sales_rep", "pw"], ["Rep Two", "r2@x.com", "sales_rep", "pw"], ["Dist One", "d1@x.com", "distributor", "pw"], ["Dist Two", "d2@x.com", "distributor", "pw"]]), "u.csv");
  await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email"], ["S1", "Sample Shop 1", "d1@x.com"], ["S2", "Sample Shop 2", ""]]), "s.csv");
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-2Y", "2Y", "400", "300"], ["TEE", "T-3Y", "3Y", "400", "300"]]), "p.csv");
  for (const k of ["r1", "r2", "d1", "d2"]) T[k] = await login("ACME", `${k}@x.com`);
  const shops = (await request(app).get("/api/shops").set(H("a"))).body; ids.s1 = shops.find((s: any) => s.code === "S1").id; ids.s2 = shops.find((s: any) => s.code === "S2").id;
  const reps = (await request(app).get("/api/reps").set(H("a"))).body; ids.r1 = reps.find((r: any) => r.email === "r1@x.com").id;
  ids.d2 = (await request(app).get("/api/distributors").set(H("a"))).body.find((d: any) => d.email === "d2@x.com").id;
});

describe("beats", () => {
  it("manager assigns beat; rep sees only own; other tenant blocked", async () => {
    await request(app).post("/api/beats").set(H("a")).send({ name: "Mon North", repId: ids.r1, shopIds: [ids.s2, ids.s1] }).expect(201);
    const mine = (await request(app).get("/api/beats").set(H("r1"))).body;
    expect(mine[0].shops.map((s: any) => s.id)).toEqual([ids.s2, ids.s1]);
    expect((await request(app).get("/api/beats").set(H("r2"))).body).toHaveLength(0);
    await request(app).post("/api/beats").set(H("b")).send({ name: "x", shopIds: [ids.s1] }).expect(404);
  });
});

describe("visits", () => {
  it("requires GPS, one open visit at a time, checkout closes", async () => {
    await request(app).post("/api/visits/checkin").set(H("r1")).send({ shopId: ids.s1 }).expect(400);
    const v = (await request(app).post("/api/visits/checkin").set(H("r1")).send({ shopId: ids.s1, lat: 13.08, lng: 80.27 }).expect(201)).body;
    await request(app).post("/api/visits/checkin").set(H("r1")).send({ shopId: ids.s2, lat: 13, lng: 80 }).expect(409);
    await request(app).post(`/api/visits/${v.id}/checkout`).set(H("r2")).send({ noOrderReason: "Shop closed", lat: 13, lng: 80 }).expect(404);
    expect((await request(app).post(`/api/visits/${v.id}/checkout`).set(H("r1")).send({ noOrderReason: "Shop closed", lat: 13.081, lng: 80.271 }).expect(200)).body.check_out_at).toBeTruthy();
  });
});

describe("orders & distributor inbox", () => {
  let oid: number;
  it("prices from billing price, routes to mapped distributor, idempotent clientRef", async () => {
    const body = { clientRef: "dev1-0001", shopId: ids.s1, lines: [{ sku: "T-2Y", qty: 3 }, { sku: "T-3Y", qty: 2 }, { sku: "T-3Y", qty: 0 }] };
    const o = (await request(app).post("/api/orders").set(H("r1")).send(body).expect(201)).body;
    expect(Number(o.total)).toBe(1500); oid = o.id;
    expect((await request(app).post("/api/orders").set(H("r1")).send(body).expect(200)).body.duplicate).toBe(true);
    expect((await request(app).get("/api/orders").set(H("d1"))).body).toHaveLength(1);
    expect((await request(app).get("/api/orders").set(H("d2"))).body).toHaveLength(0);
    await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "x", shopId: ids.s1, lines: [] }).expect(400);
  });
  it("status flow placed->accepted->fulfilled; wrong distributor / bad transition rejected", async () => {
    await request(app).post(`/api/orders/${oid}/status`).set(H("d2")).send({ status: "accepted" }).expect(404);
    await request(app).post(`/api/orders/${oid}/status`).set(H("d1")).send({ status: "fulfilled" }).expect(409);
    await request(app).post(`/api/orders/${oid}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    expect((await request(app).post(`/api/orders/${oid}/status`).set(H("d1")).send({ status: "fulfilled" }).expect(200)).body.status).toBe("fulfilled");
  });
  it("remap shop to another distributor", async () => {
    await request(app).post(`/api/shops/${ids.s2}/distributor`).set(H("a")).send({ distributorId: ids.d2 }).expect(200);
    await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "dev1-0002", shopId: ids.s2, lines: [{ sku: "T-2Y", qty: 1 }] }).expect(201);
    expect((await request(app).get("/api/orders").set(H("d2"))).body).toHaveLength(1);
  });
});

describe("dashboard", () => {
  it("aggregates visits and orders by rep/day; reps cannot view", async () => {
    const d = (await request(app).get("/api/dashboard").set(H("a")).expect(200)).body;
    expect(d).toEqual([{ day: dayKey(new Date()), repId: ids.r1, rep: "Rep One", visits: 1, orders: 2, value: 1800 }]);
    await request(app).get("/api/dashboard").set(H("r1")).expect(403);
    expect((await request(app).get("/api/dashboard").set(H("b"))).body).toHaveLength(0);
  });
});
