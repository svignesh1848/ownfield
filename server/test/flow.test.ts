// Flow changes: van stock from source + unload, van payments + settlement, productive calls, must-sell, suggested order,
// scheme claims, claim approval rules, expiry block + adjustment approval + GRN, perfect store, start/end day, retailer home.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {}; let sku = "";
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const on = (features: Record<string, boolean>) => request(app).put("/api/company/settings").set(as("adm")).send({ features }).expect(200);
const stockOf = async (dist: number | null) => Number((await db.query(`SELECT COALESCE(SUM(qty),0) AS q FROM stock WHERE variant_id=(SELECT id FROM variants WHERE sku=$1) AND ${dist == null ? "distributor_id IS NULL" : "distributor_id=" + dist}`, [sku])).rows[0].q);

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "FL", name: "FL (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("FL", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"], ["Dist", "d@x.com", "distributor", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.rep = await login("FL", "r@x.com"); T.dist = await login("FL", "d@x.com"); T.mgr = await login("FL", "m@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false, stock: true, batches: true, distInventory: true, vanSales: true }, gst: { legalName: "FL Sample Co", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s = shops[0].id; id.s2 = shops[1].id;
  const users = (await request(app).get("/api/users").set(as("adm"))).body; id.rep = users.find((u: any) => u.email === "r@x.com").id; id.dist = users.find((u: any) => u.email === "d@x.com").id;
  sku = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1")).rows[0].sku;
  await db.query("DELETE FROM stock WHERE variant_id=(SELECT id FROM variants WHERE sku=$1)", [sku]);
  await request(app).post("/api/inventory/moves").set(as("adm")).send({ distributorId: "company", kind: "in", lines: [{ sku, qty: 30, batch: "B1", expiry: "2099-01-31" }, { sku, qty: 10, batch: "B0", expiry: "2098-01-31" }] }).expect(201);
});

describe("1. van load from source stock, and unload", () => {
  it("loading deducts the source stock (FEFO) and refuses more than is there", async () => {
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: "company", lines: [{ sku, qty: 99 }] }).expect(409);
    expect(await stockOf(null)).toBe(40);
    const L = (await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: "company", lines: [{ sku, qty: 15 }] }).expect(201)).body;
    expect(L.lines[0]).toMatchObject({ loaded: 15, left: 15 }); expect(await stockOf(null)).toBe(25);
    expect(Number((await db.query("SELECT qty FROM stock WHERE batch_no='B0'")).rows[0].qty)).toBe(0); // nearest expiry taken first
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: id.dist, lines: [{ sku, qty: 1 }] }).expect(409); // one source per van
  });
  it("unload returns what is left to the source and the ledger shows it", async () => {
    await request(app).post("/api/van/unload").set(as("rep")).send({ lines: [{ sku, qty: 16 }] }).expect(409);
    const u = (await request(app).post("/api/van/unload").set(as("rep")).send({ lines: [{ sku, qty: 5 }] }).expect(200)).body;
    expect(u.lines[0]).toMatchObject({ unloaded: 5, left: 10 }); expect(await stockOf(null)).toBe(30);
    const kinds = (await db.query("SELECT kind FROM stock_moves WHERE kind LIKE 'van_%'")).rows.map((r: any) => r.kind);
    expect(kinds).toContain("van_load"); expect(kinds).toContain("van_unload");
  });
});

describe("2. van payments and day-end settlement", () => {
  it("takes cash, UPI or credit; settlement shows cash and stock differences; manager signs off", async () => {
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p0", shopId: id.s, lines: [{ sku, qty: 1 }], payment: { mode: "card" } }).expect(400);
    const a = (await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p1", shopId: id.s, lines: [{ sku, qty: 2 }], payment: { mode: "cash" } }).expect(201)).body;
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p2", shopId: id.s2, lines: [{ sku, qty: 1 }], payment: { mode: "upi", reference: "UPI123" } }).expect(201);
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p3", shopId: id.s2, lines: [{ sku, qty: 1 }], payment: { mode: "credit" } }).expect(201);
    const cash = Number(a.invoice.total);
    const L = (await request(app).get("/api/van/today").set(as("rep"))).body;
    expect(L.settlement.cash).toBeCloseTo(cash); expect(L.settlement.upi).toBeGreaterThan(0); expect(L.settlement.credit).toBeGreaterThan(0);
    await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("mgr")).expect(409); // not closed yet
    const cr = await request(app).post("/api/van/close").set(as("rep")).send({ counts: [{ sku, qty: L.lines[0].left - 1 }], cashCounted: 0 }); if (cr.status !== 200) console.log("CLOSE", cr.body); const c = cr.body;
    expect(c.settlement).toMatchObject({ cash_diff: -cash, stock_diff_units: -1, signed_off_by: null });
    await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("rep")).expect(403);
    const s = (await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("mgr")).send({ note: "₹50 short, recovered" }).expect(200)).body;
    expect(s.settlement.signed_off_by).toBe("Mgr");
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM payments WHERE mode IN ('cash','upi')")).rows[0].n)).toBe(2);
  });
});
