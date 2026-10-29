import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { poPrice } from "../src/purchase.js";
import { templateSettings } from "../src/templates.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const distStock = async () => Object.fromEntries((await request(app).get("/api/stock").set(as("d1"))).body.filter((s: any) => s.sku === "SPARA-500").map((s: any) => [s.batch_no, s.qty]));

beforeAll(async () => {
  const db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "PH", name: "PH (sample)", industry: "pharma", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("PH", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Dist One", "d1@x.com", "distributor", "pw"], ["Dist Two", "d2@x.com", "distributor", "pw"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.d1 = await login("PH", "d1@x.com"); T.d2 = await login("PH", "d2@x.com"); T.rep = await login("PH", "r@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ gst: { legalName: "Sample Pharma (sample)", gstin: "33AAAAA0000A1Z5", stateCode: "33" },
    po: { priceBase: "billing", marginPct: 10, productDiscounts: [{ scope: "category", key: "analgesic", pct: 5 }, { scope: "item", key: "SAMPLE-SYRUP", pct: 2 }] } }).expect(200);
  const ds = (await request(app).get("/api/distributors").set(as("adm"))).body; id.d1 = ds.find((d: any) => d.email === "d1@x.com").id; id.d2 = ds.find((d: any) => d.email === "d2@x.com").id;
  await request(app).put(`/api/distributors/${id.d1}/profile`).set(as("adm")).send({ margin_pct: 8, discount_pct: 2 }).expect(200);
  await request(app).put(`/api/distributors/${id.d1}/profile`).set(as("d1")).send({ legal_name: "Sample Dist One", gstin: "29BBBBB1111B1Z1", margin_pct: 0 }).expect(200);
});

describe("PO pricing", () => {
  it("price base → margin (distributor override) → product/category → distributor discount", async () => {
    const s = templateSettings("fmcg"); s.po = { ...s.po, priceBase: "mrp", marginPct: 10, productDiscounts: [{ scope: "category", key: "Biscuits", pct: 5 }, { scope: "item", key: "X", pct: 50 }] };
    expect(poPrice({ billing_price: 8, mrp: 10, item_code: "B", category: "Biscuits" }, s, null)).toMatchObject({ base: 10, marginPct: 10, productDiscPct: 5, distDiscPct: 0, rate: 8.55 });
    expect(poPrice({ billing_price: 8, mrp: 10, item_code: "X", category: "Biscuits" }, s, { margin_pct: 0, discount_pct: 10 }).rate).toBe(4.5);
    const prof = (await request(app).get(`/api/distributors/${id.d1}/profile`).set(as("adm"))).body;
    expect(Number(prof.margin_pct)).toBe(8); // distributor cannot change commercial terms
    const list = (await request(app).get("/api/po-price").set(as("d1"))).body;
    expect(list.find((v: any) => v.sku === "SPARA-500")).toMatchObject({ base: 22, marginPct: 8, productDiscPct: 5, distDiscPct: 2, rate: 18.84, gst: 5 });
    expect(list.find((v: any) => v.sku === "SSYR-100ML").productDiscPct).toBe(2);
  });
});

describe("PO lifecycle", () => {
  let po: any;
  it("distributor drafts, edits and submits; numbered per distributor per FY", async () => {
    await request(app).post("/api/pos").set(as("rep")).send({ lines: [{ sku: "SPARA-500", qty: 1 }] }).expect(403);
    po = (await request(app).post("/api/pos").set(as("d1")).send({ lines: [{ sku: "SPARA-500", qty: 2, uom: "BOX" }] }).expect(201)).body;
    expect(po).toMatchObject({ status: "draft", number: null });
    po = (await request(app).put(`/api/pos/${po.id}`).set(as("d1")).send({ lines: [{ sku: "SPARA-500", qty: 5, uom: "BOX" }, { sku: "SPARA-650", qty: 10 }] }).expect(200)).body;
    expect(po.lines[0]).toMatchObject({ qty_requested: 50, rate: 18.84, gst_rate: 5 });
    po = (await request(app).post(`/api/pos/${po.id}/submit`).set(as("d1")).expect(200)).body;
    expect(po.number).toMatch(/^PO\/\d{4}-\d{2}\/0001$/);
    await request(app).put(`/api/pos/${po.id}`).set(as("d1")).send({ lines: [{ sku: "SPARA-500", qty: 1 }] }).expect(409);
    const p2 = (await request(app).post("/api/pos").set(as("d2")).send({ lines: [{ sku: "SSYR-100ML", qty: 1 }] }).expect(201)).body;
    expect((await request(app).post(`/api/pos/${p2.id}/submit`).set(as("d2"))).body.number).toBe(po.number);
    await request(app).get(`/api/pos/${p2.id}`).set(as("d1")).expect(404);
    await request(app).post(`/api/pos/${p2.id}/reject`).set(as("adm")).send({}).expect(400);
    expect((await request(app).post(`/api/pos/${p2.id}/reject`).set(as("adm")).send({ reason: "Sample: duplicate request" }).expect(200)).body).toMatchObject({ status: "rejected", reject_reason: "Sample: duplicate request" });
  });
  it("approval edits qty, audits price override, GST on final rate (IGST for other state)", async () => {
    const [l1, l2] = po.lines;
    await request(app).post(`/api/pos/${po.id}/approve`).set(as("adm")).send({ lines: [{ lineId: l1.id, qty: 40, rate: 18 }] }).expect(400);
    po = (await request(app).post(`/api/pos/${po.id}/approve`).set(as("adm")).send({ lines: [{ lineId: l1.id, qty: 40, rate: 18, reason: "Sample festive price" }, { lineId: l2.id, qty: 0 }] }).expect(200)).body;
    expect(po.status).toBe("approved"); expect(po.intra_state).toBe(false);
    expect(po.lines[0]).toMatchObject({ qty_approved: 40, computed_rate: 18.84, rate: 18, taxable: 720, tax: 36, total: 756 });
    expect(po).toMatchObject({ taxable: 720, tax: 36, total: 756 });
    expect(po.audit[0]).toMatchObject({ old_rate: 18.84, new_rate: 18, reason: "Sample festive price", user_name: "Admin" });
    await request(app).post(`/api/pos/${po.id}/approve`).set(as("adm")).send({}).expect(409);
  });
  it("partial dispatch FEFO from company stock, receipt into distributor stock with batches", async () => {
    po = (await request(app).post(`/api/pos/${po.id}/dispatch`).set(as("adm")).send({ lines: [{ lineId: po.lines[0].id, qty: 25 }] }).expect(200)).body;
    expect(po.status).toBe("partially_dispatched");
    expect(po.dispatches[0].lines).toMatchObject([{ qty: 25, batch_no: "SB-0127", expiry: "2027-01-31" }]);
    await request(app).post(`/api/pos/${po.id}/dispatch`).set(as("adm")).send({ lines: [{ lineId: po.lines[0].id, qty: 16 }] }).expect(409);
    po = (await request(app).post(`/api/pos/${po.id}/dispatch`).set(as("adm")).send({}).expect(200)).body;
    expect(po.status).toBe("dispatched");
    expect(po.dispatches[1].lines.map((l: any) => [l.batch_no, l.qty])).toEqual([["SB-0127", 5], ["SB-0627", 10]]);
    await request(app).post(`/api/pos/${po.id}/dispatches/${po.dispatches[0].id}/receive`).set(as("adm")).expect(403);
    po = (await request(app).post(`/api/pos/${po.id}/dispatches/${po.dispatches[0].id}/receive`).set(as("d1")).expect(200)).body;
    expect(await distStock()).toEqual({ "SB-0127": 25 });
    await request(app).post(`/api/pos/${po.id}/dispatches/${po.dispatches[0].id}/receive`).set(as("d1")).expect(409);
    po = (await request(app).post(`/api/pos/${po.id}/dispatches/${po.dispatches[1].id}/receive`).set(as("d1")).expect(200)).body;
    expect(po.status).toBe("received"); expect(po.lines[0].qty_received).toBe(40);
    expect(await distStock()).toEqual({ "SB-0127": 30, "SB-0627": 10 });
  });
  it("printable and CSV export; feature toggle respected", async () => {
    const html = (await request(app).get(`/api/pos/${po.id}/print`).set(as("d1")).expect(200)).text;
    expect(html).toContain(po.number); expect(html).toContain("Sample festive price");
    const c = await request(app).get(`/api/pos/${po.id}/export`).set(as("adm")).expect(200);
    expect(c.headers["content-type"]).toMatch(/csv/); expect(c.text.split("\n")[0]).toContain("distributor_disc_pct");
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { purchaseOrders: false } }).expect(200);
    await request(app).post("/api/pos").set(as("d1")).send({ lines: [{ sku: "SPARA-500", qty: 1 }] }).expect(400);
  });
});
