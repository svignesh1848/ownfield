// End-to-end business flow across roles (sign-up → setup → rep day → approval → distributor → billing → collections → reports),
// checking that numbers agree between screens. Uses the pg-mem transaction helper.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db.js";
import { gstinCheckChar } from "../src/gstin.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const I: Record<string, number> = {};
const H = (k: string) => ({ Authorization: `Bearer ${T[k]}` });
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const G = (x: string) => x + gstinCheckChar(x);
const login = async (e: string) => (await request(app).post("/api/auth/login").send({ companyCode: "E2E1", email: e, password: "goodpass1" }).expect(200)).body.token;

beforeAll(async () => {
  const db = txDb(); await migrate(db); app = createApp(db, "t");
  T.a = (await request(app).post("/api/signup").send({ companyName: "E2E Traders", companyCode: "E2E1", industry: "fmcg", adminName: "Asha", email: "a@x.com", password: "goodpass1", consent: true }).expect(201)).body.token;
  await request(app).put("/api/company/settings").set(H("a")).send({ gst: { gstin: G("33AAAAA0000A1Z"), legalName: "E2E Traders", stateCode: "33" },
    features: { distInventory: true, distributorBilling: true, claims: true } }).expect(200);
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price", "HSN"], ["TEE", "T-2Y", "2Y", "400", "300", "6109"], ["TEE", "T-3Y", "3Y", "500", "400", "6109"]]), "p.csv").expect(200);
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r1@x.com", "sales_rep", "goodpass1"], ["Dist", "d1@x.com", "distributor", "goodpass1"], ["Mgr", "m1@x.com", "manager", "goodpass1"]]), "u.csv").expect(200);
  for (const k of ["r1", "d1", "m1"]) T[k] = await login(`${k}@x.com`);
  const sh = (await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email", "GSTIN", "State Code", "Credit Limit", "Credit Days"],
    ["S1", "Shop 1", "d1@x.com", G("33BBBBB0000B1Z"), "33", "5000", "15"], ["S2", "Shop 2", "d1@x.com", G("29CCCCC0000C1Z"), "29", "", ""]]), "s.csv").expect(200)).body;
  expect(sh.errors).toEqual([]);
  const shops = (await request(app).get("/api/shops").set(H("a"))).body; I.s1 = shops.find((s: any) => s.code === "S1").id; I.s2 = shops.find((s: any) => s.code === "S2").id;
  I.d1 = (await request(app).get("/api/distributors").set(H("a"))).body[0].id;
  await request(app).put(`/api/distributors/${I.d1}/profile`).set(H("a")).send({ gstin: G("33DDDDD0000D1Z"), legal_name: "Dist Pvt" }).expect(200);
  I.v = (await request(app).get("/api/products").set(H("a"))).body.find((p: any) => p.sku === "T-2Y").id;
  I.item = (await request(app).get("/api/items").set(H("a"))).body[0].id;
  await request(app).post("/api/schemes").set(H("a")).send({ name: "5% on 4+", itemId: I.item, minQty: 4, discountPct: 5 }).expect(201);
  await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv([["SKU", "Qty"], ["T-2Y", "100"]]), "st.csv").expect(200);
});

const stock = async () => (await request(app).get("/api/stock").set(H("d1"))).body.find((s: any) => s.variant_id === I.v).qty;

describe("end-to-end flow", () => {
  it("outlet import keeps credit limit and days, and the rep's credit check uses them", async () => {
    const c = (await request(app).get(`/api/credit-check?shopId=${I.s1}&amount=100`).set(H("r1")).expect(200)).body;
    expect(c.terms).toMatchObject({ limit: 5000, days: 15 });
    const bad = (await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Credit Limit"], ["S9", "X", "-5"]]), "s.csv")).body;
    expect(bad.errors[0].error).toMatch(/credit limit/);
  });
  it("missing ids give a clear 400, not a server error", async () => {
    for (const [m, u, b] of [["post", "/api/orders", { clientRef: "z", lines: [{ variantId: I.v, qty: 1 }] }], ["post", "/api/visits/checkin", { lat: 13, lng: 80 }], ["get", "/api/credit-check?amount=5", null], ["post", "/api/orders/undefined/cancel", { reason: "x" }]] as const) {
      const r = await (request(app) as any)[m](u).set(H("r1")).send(b ?? undefined);
      expect(r.status, u).toBe(400); expect(r.body.error).toMatch(/missing or wrong/);
    }
  });
  it("order → partial delivery → invoice → collection → credit note: totals, stock and outstanding agree", async () => {
    const o = (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "e1", shopId: I.s1, lines: [{ variantId: I.v, qty: 5 }] }).expect(201)).body;
    expect(Number(o.total)).toBe(1425); // 5 × 300 less 5% scheme
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    expect(await stock()).toBe(95);
    const lid = (await request(app).get("/api/orders").set(H("d1"))).body.find((x: any) => x.id === o.id).lines[0].id;
    expect(Number((await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "fulfilled", lines: [{ id: lid, qty: 4 }], reason: "short" }).expect(200)).body.total)).toBe(1140);
    expect(await stock()).toBe(96);
    const inv = (await request(app).post(`/api/orders/${o.id}/invoice`).set(H("d1")).send({}).expect(201)).body;
    expect(inv).toMatchObject({ taxable: 1140, cgst: 102.6, sgst: 102.6, igst: 0, total: 1345 });
    const p = (await request(app).post("/api/payments").set(H("r1")).send({ shopId: I.s1, amount: 345, mode: "cash", clientRef: "pay1" }).expect(201)).body;
    expect(p.allocations[0]).toMatchObject({ invoice_id: inv.id, amount: 345 });
    const ilid = (await request(app).get(`/api/invoices/${inv.id}`).set(H("d1"))).body.lines[0].id;
    const cn = (await request(app).post(`/api/invoices/${inv.id}/credit-note`).set(H("d1")).send({ reason: "damaged", lines: [{ invoiceLineId: ilid, qty: 1 }] }).expect(201)).body;
    expect(cn.taxable).toBe(285);
    const out = (await request(app).get("/api/outstanding").set(H("r1"))).body.find((x: any) => x.shop_id === I.s1);
    expect(out.outstanding).toBe(1345 - 345 - cn.total);
  });
  it("inter-state outlet is billed with IGST", async () => {
    const o = (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "e2", shopId: I.s2, lines: [{ variantId: I.v, qty: 2 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "fulfilled" }).expect(200);
    expect((await request(app).post(`/api/orders/${o.id}/invoice`).set(H("d1")).send({}).expect(201)).body).toMatchObject({ intra_state: false, igst: 108, cgst: 0, total: 708 });
  });
  it("report builder order totals match the dashboard (cancelled and rejected left out)", async () => {
    const c = (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "e3", shopId: I.s1, lines: [{ variantId: I.v, qty: 1 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${c.id}/cancel`).set(H("r1")).send({ reason: "dup" }).expect(200);
    const rj = (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "e4", shopId: I.s1, lines: [{ variantId: I.v, qty: 1 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${rj.id}/status`).set(H("d1")).send({ status: "rejected", reason: "no" }).expect(200);
    const dash = (await request(app).get("/api/dashboard").set(H("m1"))).body.reduce((a: any, r: any) => ({ n: a.n + r.orders, v: a.v + r.value }), { n: 0, v: 0 });
    const rep = (await request(app).post("/api/custom-reports/from-template/sales_by_rep").set(H("a")).send({}).expect(201)).body;
    const row = (await request(app).get(`/api/custom-reports/${rep.id}/run`).set(H("a")).expect(200)).body.rows[0];
    expect({ n: row.count, v: row.sum_value }).toEqual(dash);
    expect(dash).toEqual({ n: 2, v: 1740 });
  });
});
