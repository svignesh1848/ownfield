import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const on = (features: Record<string, boolean>) => request(app).put("/api/company/settings").set(as("adm")).send({ features }).expect(200);

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "FO", name: "FO (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("FO", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"], ["Dist", "d@x.com", "distributor", "pw"]]), "u.csv");
  T.rep = await login("FO", "r@x.com"); T.dist = await login("FO", "d@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false }, gst: { legalName: "FO Sample Co", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s = shops[0].id; id.s2 = shops[1].id;
  const users = (await request(app).get("/api/users").set(as("adm"))).body; id.rep = users.find((u: any) => u.email === "r@x.com").id; id.dist = users.find((u: any) => u.email === "d@x.com").id;
  T.sku = (await request(app).get("/api/catalog").set(as("adm"))).body.items?.[0]?.variants?.[0]?.sku;
});

describe("van sales", () => {
  it("is off until the feature is on", async () => {
    await request(app).get("/api/van/today").set(as("rep")).expect(403);
    await on({ vanSales: true });
  });
  it("load, sell with invoice, and reconcile at day end", async () => {
    const sku = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1")).rows[0].sku; T.sku = sku;
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v0", shopId: id.s, lines: [{ sku, qty: 1 }] }).expect(409);
    const L = (await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, lines: [{ sku, qty: 20 }] }).expect(201)).body;
    expect(L.lines[0]).toMatchObject({ sku, loaded: 20, left: 20 });
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 25 }] }).expect(409);
    const s = (await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 6 }] }).expect(201)).body;
    expect(s.order.status).toBe("fulfilled"); expect(s.invoice.number).toBeTruthy(); expect(s.van.lines[0].left).toBe(14);
    expect((await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 6 }] }).expect(200)).body.duplicate).toBe(true);
    const c = (await request(app).post("/api/van/close").set(as("rep")).send({ counts: [{ sku, qty: 13 }] }).expect(200)).body;
    expect(c.status).toBe("closed"); expect(c.lines[0]).toMatchObject({ expected: 14, counted: 13, variance: -1 }); expect(c.sales_total).toBeGreaterThan(0);
    expect((await request(app).get("/api/van/loads").set(as("adm")).expect(200)).body.length).toBe(1);
  });
});

describe("distributor inventory", () => {
  it("goods in/out per distributor with batch and age, moves ledger, auto-moves on order acceptance", async () => {
    await request(app).get("/api/inventory").set(as("dist")).expect(403);
    await on({ distInventory: true, stock: true });
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "in", lines: [{ sku: T.sku, qty: 30, batch_no: "B1" }] }).expect(201);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "out", lines: [{ sku: T.sku, qty: 99, batch_no: "B1" }] }).expect(409);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "out", lines: [{ sku: T.sku, qty: 4, batch_no: "B1" }], note: "Sample damage" }).expect(201);
    const inv = (await request(app).get("/api/inventory").set(as("dist")).expect(200)).body;
    expect(inv.rows[0]).toMatchObject({ sku: T.sku, batch_no: "B1", qty: 26, age_band: "0-30 days" });
    // an order from a shop served by this distributor deducts stock on acceptance and logs a sale move
    await await request(app).post(`/api/shops/${id.s2}/distributor`).set(as("adm")).send({ distributorId: id.dist }).expect(200);
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "inv1", shopId: id.s2, lines: [{ sku: T.sku, qty: 5 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("dist")).send({ status: "accepted" }).expect(200);
    const moves = (await request(app).get("/api/inventory/moves").set(as("dist")).expect(200)).body;
    expect(moves.map((m: any) => [m.kind, m.qty])).toEqual([["sale", -5], ["out", -4], ["in", 30]]);
    expect((await request(app).get(`/api/inventory?distributorId=${id.dist}`).set(as("adm")).expect(200)).body.rows[0].qty).toBe(21);
  });
});
