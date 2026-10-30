import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
async function acceptedOrder(shop: number, by: string) {
  const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: `o${++n}`, shopId: shop, lines: [{ sku: "STEE-2Y-RED", qty: 10 }] }).expect(201)).body;
  await request(app).post(`/api/orders/${o.id}/status`).set(as(by)).send({ status: "accepted" }).expect(200);
  return o.id;
}

beforeAll(async () => {
  const db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "AP", name: "AP (sample)", industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("AP", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Dist One", "d1@x.com", "distributor", "pw"], ["Dist Two", "d2@x.com", "distributor", "pw"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  for (const k of ["d1", "d2", "rep"]) T[k] = await login("AP", k === "rep" ? "r@x.com" : `${k}@x.com`);
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { distributorBilling: true }, gst: { legalName: "Sample Apparel Co (sample)", gstin: "33AAAAA0000A1Z9", stateCode: "33", pincode: "600001" } }).expect(200);
  const ds = (await request(app).get("/api/distributors").set(as("adm"))).body; id.d1 = ds.find((d: any) => d.email === "d1@x.com").id; id.d2 = ds.find((d: any) => d.email === "d2@x.com").id;
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s1 = shops[0].id; id.s2 = shops[1].id; id.s3 = shops[2].id;
  await request(app).post(`/api/shops/${id.s1}/distributor`).set(as("adm")).send({ distributorId: id.d1 });
  await request(app).post(`/api/shops/${id.s2}/distributor`).set(as("adm")).send({ distributorId: id.d2 });
});

describe("distributor billing under own GSTIN", () => {
  let d1inv: any;
  it("needs a GST profile; then invoices with own GSTIN and own numbering", async () => {
    const oid = await acceptedOrder(id.s1, "d1");
    expect((await request(app).post(`/api/orders/${oid}/invoice`).set(as("d1")).send({})).status).toBe(400);
    await request(app).put(`/api/distributors/${id.d1}/profile`).set(as("d1")).send({ legal_name: "Sample Dist One LLP", gstin: "29BBBBB1111B1ZJ", invoice_prefix: "D1", number_format: "{prefix}/{fy}/{seq:3}", pincode: "560001" }).expect(200);
    expect((await request(app).post(`/api/orders/${oid}/invoice`).set(as("adm")).send({})).status).toBe(409);
    d1inv = (await request(app).post(`/api/orders/${oid}/invoice`).set(as("d1")).send({}).expect(201)).body;
    expect(d1inv.number).toMatch(/^D1\/\d{4}-\d{2}\/001$/);
    expect(d1inv).toMatchObject({ issuer: `d${id.d1}`, intra_state: false, taxable: 2800, igst: 140, total: 2940 });
    expect(d1inv.seller).toMatchObject({ name: "Sample Dist One LLP", gstin: "29BBBBB1111B1ZJ", state: "29", pin: "560001" });
  });
  it("company and other distributors keep separate series; visibility scoped to issuer", async () => {
    const own = await acceptedOrder(id.s3, "adm");
    const ci = (await request(app).post(`/api/orders/${own}/invoice`).set(as("adm")).send({}).expect(201)).body;
    expect(ci.number).toMatch(/^INV\/\d{4}-\d{2}\/0001$/); expect(ci.intra_state).toBe(true);
    await request(app).put(`/api/distributors/${id.d2}/profile`).set(as("d2")).send({ legal_name: "Sample Dist Two", gstin: "33CCCCC2222C1ZF" }).expect(200);
    const o2 = await acceptedOrder(id.s2, "d2");
    await request(app).post(`/api/orders/${o2}/invoice`).set(as("d1")).send({}).expect(404);
    const d2inv = (await request(app).post(`/api/orders/${o2}/invoice`).set(as("d2")).send({}).expect(201)).body;
    expect(d2inv.number).toBe(ci.number); // same text is fine: different GSTIN/issuer
    await request(app).get(`/api/invoices/${d1inv.id}`).set(as("d2")).expect(404);
    expect((await request(app).get("/api/invoices").set(as("d1"))).body.map((i: any) => i.id)).toEqual([d1inv.id]);
    expect((await request(app).get("/api/invoices").set(as("adm"))).body).toHaveLength(3);
    expect((await request(app).get(`/api/invoices/${d1inv.id}/print`).set(as("d1"))).text).toContain("29BBBBB1111B1ZJ");
  });
  it("credit notes only by the issuer, in the issuer's series", async () => {
    const body = { reason: "Sample return", lines: [{ invoiceLineId: d1inv.lines[0].id, qty: 2 }] };
    await request(app).post(`/api/invoices/${d1inv.id}/credit-note`).set(as("adm")).send(body).expect(404);
    await request(app).post(`/api/invoices/${d1inv.id}/credit-note`).set(as("d2")).send(body).expect(404);
    const cn = (await request(app).post(`/api/invoices/${d1inv.id}/credit-note`).set(as("d1")).send(body).expect(201)).body;
    expect(cn.number).toMatch(/^CN\/\d{4}-\d{2}\/001$/); expect(cn).toMatchObject({ taxable: 560, igst: 28 });
  });
  it("turning distributor billing off blocks distributors and returns billing to the company", async () => {
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { distributorBilling: false } }).expect(200);
    const oid = await acceptedOrder(id.s1, "d1");
    await request(app).post(`/api/orders/${oid}/invoice`).set(as("d1")).send({}).expect(403);
    await request(app).post(`/api/orders/${oid}/invoice`).set(as("adm")).send({}).expect(201);
  });
});
