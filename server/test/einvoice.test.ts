import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { GspStubProvider, nicPayload, uqc } from "../src/einvoice.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
async function invoice(shop: number) {
  const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: `e${++n}`, shopId: shop, lines: [{ sku: "STEE-2Y-RED", qty: 10 }] }).expect(201)).body;
  await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
  return (await request(app).post(`/api/orders/${o.id}/invoice`).set(as("adm")).send({}).expect(201)).body;
}

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "EI", name: "EI (sample)", industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("EI", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.rep = await login("EI", "r@x.com");
  await request(app).post("/api/import/shops").set(as("adm")).attach("file", csv([["Code", "Name", "Address", "City", "State Code", "GSTIN", "PIN Code"],
    ["EB2B", "Sample B2B Outlet", "12 Sample Street", "Bengaluru", "29", "29BBBBB1111B1ZJ", "560001"], ["EB2C", "Sample Walk-in Outlet", "1 Sample Road", "Chennai", "33", "", "600002"]]), "s.csv").expect(200);
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false }, gst: { legalName: "EI Sample Co", gstin: "33AAAAA0000A1Z9", stateCode: "33", address: "5 Sample Lane", city: "Chennai", pincode: "600001" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.b2b = shops.find((s: any) => s.code === "EB2B").id; id.b2c = shops.find((s: any) => s.code === "EB2C").id;
});

describe("e-invoicing", () => {
  let inv: any;
  it("is off by default (per-company toggle)", async () => {
    inv = await invoice(id.b2b);
    await request(app).post(`/api/invoices/${inv.id}/einvoice`).set(as("adm")).expect(403);
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { eInvoice: true }, einvoice: { provider: "test" } }).expect(200);
  });
  it("builds NIC v1.1 JSON", async () => {
    const j = (await request(app).get(`/api/invoices/${inv.id}/einvoice/json`).set(as("adm")).expect(200)).body;
    expect(j).toMatchObject({ Version: "1.1", TranDtls: { SupTyp: "B2B" }, DocDtls: { Typ: "INV", No: inv.number },
      SellerDtls: { Gstin: "33AAAAA0000A1Z9", Pin: 600001, Stcd: "33", Loc: "Chennai" }, BuyerDtls: { Gstin: "29BBBBB1111B1ZJ", Pos: "29", Pin: 560001, Stcd: "29" },
      ValDtls: { AssVal: 2800, IgstVal: inv.igst, CgstVal: 0, TotInvVal: inv.total } });
    expect(j.DocDtls.Dt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(j.ItemList[0]).toMatchObject({ SlNo: "1", IsServc: "N", HsnCd: "6109", Qty: 10, Unit: "PCS", AssAmt: 2800, GstRt: inv.lines[0].gst_rate });
    expect([uqc("case"), uqc("strip"), uqc("weird")]).toEqual(["CTN", "STR", "OTH"]);
    expect(() => nicPayload({ ...inv, buyer: { ...inv.buyer, gstin: "" } })).toThrow(/B2B only/);
    const b2c = await invoice(id.b2c);
    expect((await request(app).post(`/api/invoices/${b2c.id}/einvoice`).set(as("adm")).expect(400)).body.error).toMatch(/B2B only/);
  });
  it("TEST provider issues a fake IRN + QR, shown on the print, once", async () => {
    const r = (await request(app).post(`/api/invoices/${inv.id}/einvoice`).set(as("adm")).expect(201)).body;
    expect(r.irn).toMatch(/^[0-9a-f]{64}$/); expect(r.ack_no).toMatch(/^TEST/); expect(r).toMatchObject({ einv_status: "generated", einv_provider: "TEST" });
    expect(JSON.parse(Buffer.from(r.signed_qr.split(".")[1], "base64url").toString())).toMatchObject({ TEST: expect.stringContaining("NOT A VALID"), Irn: r.irn });
    await request(app).post(`/api/invoices/${inv.id}/einvoice`).set(as("adm")).expect(409);
    const html = (await request(app).get(`/api/invoices/${inv.id}/print`).set(as("adm"))).text;
    expect(html).toContain(r.irn); expect(html).toContain("TEST E-INVOICE — NOT VALID FOR GST"); expect(html).toContain("data:image/png;base64,");
  });
  it("credit notes reference the original invoice", async () => {
    const cn = (await request(app).post(`/api/invoices/${inv.id}/credit-note`).set(as("adm")).send({ reason: "Sample return", lines: [{ invoiceLineId: inv.lines[0].id, qty: 1 }] }).expect(201)).body;
    const j = (await request(app).get(`/api/invoices/${cn.id}/einvoice/json`).set(as("adm"))).body;
    expect(j.DocDtls.Typ).toBe("CRN"); expect(j.RefDtls.PrecDocDtls[0].InvNo).toBe(inv.number);
  });
  it("cancel only within 24h, with a reason", async () => {
    await request(app).post(`/api/invoices/${inv.id}/einvoice/cancel`).set(as("adm")).send({ reason: "9", remark: "x" }).expect(400);
    const other = await invoice(id.b2b);
    await request(app).post(`/api/invoices/${other.id}/einvoice`).set(as("adm")).expect(201);
    await db.query("UPDATE invoices SET einv_ack_at=$1 WHERE id=$2", [new Date(Date.now() - 25 * 3600e3), other.id]);
    expect((await request(app).post(`/api/invoices/${other.id}/einvoice/cancel`).set(as("adm")).send({ reason: "2", remark: "late" }).expect(409)).body.error).toMatch(/24 hours/);
    const c = (await request(app).post(`/api/invoices/${inv.id}/einvoice/cancel`).set(as("adm")).send({ reason: "2", remark: "Sample wrong qty" }).expect(200)).body;
    expect(c).toMatchObject({ einv_status: "cancelled", einv_cancel_reason: "Data entry mistake: Sample wrong qty" });
    await request(app).post(`/api/invoices/${inv.id}/einvoice/cancel`).set(as("adm")).send({ reason: "2", remark: "again" }).expect(409);
    expect((await request(app).get(`/api/invoices/${inv.id}/print`).set(as("adm"))).text).toContain("IRN CANCELLED");
  });
  it("GSP stub validates env and never calls out", async () => {
    await expect(new GspStubProvider({}).generate()).rejects.toMatchObject({ status: 503, message: expect.stringContaining("EINV_GSP_BASE_URL") });
    const env = Object.fromEntries(GspStubProvider.ENV.map(k => [k, "x"]));
    await expect(new GspStubProvider(env).generate()).rejects.toMatchObject({ status: 501, message: expect.stringContaining("No real API call") });
    await request(app).put("/api/company/settings").set(as("adm")).send({ einvoice: { provider: "gsp" } }).expect(200);
    const x = await invoice(id.b2b);
    expect((await request(app).post(`/api/invoices/${x.id}/einvoice`).set(as("adm"))).status).toBe(503);
    await request(app).put("/api/company/settings").set(as("adm")).send({ einvoice: { provider: "live" } }).expect(400);
  });
});
