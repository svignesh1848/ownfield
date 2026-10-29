import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate, withTx, type Db } from "../src/db.js";
import { allocateStock } from "../src/field.js";
import { txDb } from "./txdb.js";
import { fyOf, rateFor, formatNumber } from "../src/billing.js";
import { defaultGst } from "../src/templates.js";

let app: any, db: Db; const T: Record<string, string> = {}; let shopIntra: number, shopInter: number;
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const GST = { legalName: "Sample Pharma Distributors (sample)", gstin: "33AAAAA0000A1Z5", stateCode: "33", address: "1 Sample Street, Chennai" };
const order = async (ref: string, shopId: number, lines: any[]) => (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: ref, shopId, lines }).expect(201)).body;
const accept = (id: number) => request(app).post(`/api/orders/${id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
const stockOf = async (sku: string) => Object.fromEntries((await request(app).get("/api/stock").set(as("adm"))).body.filter((s: any) => s.sku === sku).map((s: any) => [s.batch_no, s.qty]));
const pid = (id: number) => request(app).post(`/api/orders/${id}/invoice`).set(as("adm"));

beforeAll(async () => {
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ff-up-"));
  db = txDb();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code: "PH", name: "PH (sample)", industry: "pharma", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T.adm = await login("PH", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep A", "r@x.com", "sales_rep", "pw"], ["Rep B", "r2@x.com", "sales_rep", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.rep = await login("PH", "r@x.com"); T.rep2 = await login("PH", "r2@x.com"); T.mgr = await login("PH", "m@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).post("/api/import/shops").set(as("adm")).attach("file", csv([["Code", "Name", "City", "GSTIN", "State Code"],
    ["TN1", "Sample Chennai Chemist", "Chennai", "33BBBBB1111B1Z1", ""], ["KA1", "Sample Bengaluru Chemist", "Bengaluru", "29CCCCC2222C1Z2", ""]]), "s.csv").expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body;
  shopIntra = shops.find((s: any) => s.code === "TN1").id; shopInter = shops.find((s: any) => s.code === "KA1").id;
  expect(shops.find((s: any) => s.code === "KA1").state_code).toBe("29");
});

describe("GST helpers", () => {
  it("financial year, HSN rate lookup, numbering", () => {
    expect(fyOf("2027-03-31")).toBe("2026-27"); expect(fyOf("2027-04-01")).toBe("2027-28"); expect(fyOf("2099-12-01")).toBe("2099-00");
    const g = { ...defaultGst("custom"), defaultRate: 18, hsnRates: [{ prefix: "30", rate: 12 }, { prefix: "3004", rate: 5 }] };
    expect(rateFor(g, "30049099")).toBe(5); expect(rateFor(g, "3002")).toBe(12); expect(rateFor(g, "8415")).toBe(18); expect(rateFor(g, null)).toBe(18);
    expect(formatNumber("{prefix}/{fy}/{seq:4}", "INV", "2026-27", 7)).toBe("INV/2026-27/0007");
    expect(() => formatNumber("{prefix}-{fy}-{seq:8}", "INVOICE", "2026-27", 1)).toThrow(/16 characters/);
  });
});

describe("GST invoices", () => {
  let inv1: any;
  it("requires GST settings and validates them", async () => {
    const o = await order("g0", shopIntra, [{ sku: "SPARA-650", qty: 1 }]); await accept(o.id);
    expect((await pid(o.id)).status).toBe(400);
    await request(app).put("/api/company/settings").set(as("adm")).send({ gst: { ...GST, gstin: "29AAAAA0000A1Z5" } }).expect(400);
    await request(app).put("/api/company/settings").set(as("adm")).send({ gst: { ...GST, numberFormat: "INV" } }).expect(400);
    const s = (await request(app).put("/api/company/settings").set(as("adm")).send({ gst: GST }).expect(200)).body.settings;
    expect(s.gst.hsnRates).toEqual([{ prefix: "3004", rate: 5 }]);
  });
  it("intra-state invoice splits CGST/SGST, numbers per FY, one invoice per accepted order", async () => {
    const o = await order("g1", shopIntra, [{ sku: "SPARA-500", qty: 4, uom: "BOX" }]);
    expect((await pid(o.id)).status).toBe(409);
    await accept(o.id);
    inv1 = (await pid(o.id).expect(201)).body;
    expect(inv1.number).toMatch(/^INV\/\d{4}-\d{2}\/0001$/);
    expect(inv1).toMatchObject({ intra_state: true, taxable: 880, cgst: 22, sgst: 22, igst: 0, total: 924, place_of_supply: "33" });
    expect(inv1.lines[0]).toMatchObject({ hsn: "3004", gst_rate: 5, base_qty: 40, uom: "BOX" });
    expect((await pid(o.id)).status).toBe(409);
    const html = (await request(app).get(`/api/invoices/${inv1.id}/print`).set(as("adm")).expect(200)).text;
    expect(html).toContain("TAX INVOICE"); expect(html).toContain(inv1.number); expect(html).toContain("CGST");
    await request(app).get(`/api/invoices/${inv1.id}/print`).set(as("rep")).expect(403);
  });
  it("inter-state invoice uses IGST; back-dated invoice gets its own FY series; future date rejected", async () => {
    const o = await order("g2", shopInter, [{ sku: "SSYR-100ML", qty: 3 }]); await accept(o.id);
    const inv = (await pid(o.id).send({ date: "2026-03-15" }).expect(201)).body;
    expect(inv.number).toBe("INV/2025-26/0001");
    expect(inv).toMatchObject({ intra_state: false, taxable: 255, cgst: 0, sgst: 0, igst: 12.75, total: 268, round_off: 0.25 });
    const o2 = await order("g3", shopInter, [{ sku: "SSYR-100ML", qty: 1 }]); await accept(o2.id);
    expect((await pid(o2.id).send({ date: "2099-01-01" })).status).toBe(400);
    expect((await pid(o2.id).expect(201)).body.number).toMatch(/\/0002$/);
  });
  it("credit notes for returns: proportional tax, restock into allocated batches, no over-return", async () => {
    expect(await stockOf("SPARA-500")).toMatchObject({ "SB-0127": 0, "SB-0627": 190 });
    const line = inv1.lines[0].id;
    const cn = (await request(app).post(`/api/invoices/${inv1.id}/credit-note`).set(as("adm")).send({ reason: "Sample damaged strips", restock: true, lines: [{ invoiceLineId: line, qty: 15 }] }).expect(201)).body;
    expect(cn.number).toMatch(/^CN\/\d{4}-\d{2}\/0001$/);
    expect(cn).toMatchObject({ kind: "credit_note", ref_invoice_id: inv1.id, taxable: 330, cgst: 8.25, sgst: 8.25, total: 347 });
    expect(await stockOf("SPARA-500")).toMatchObject({ "SB-0127": 15, "SB-0627": 190 });
    await request(app).post(`/api/invoices/${inv1.id}/credit-note`).set(as("adm")).send({ reason: "x", lines: [{ invoiceLineId: line, qty: 26 }] }).expect(409);
    await request(app).post(`/api/invoices/${inv1.id}/credit-note`).set(as("adm")).send({ reason: "Sample expiry return", restock: true, lines: [{ invoiceLineId: line, qty: 25 }] }).expect(201);
    expect(await stockOf("SPARA-500")).toMatchObject({ "SB-0127": 30, "SB-0627": 200 });
    await request(app).post(`/api/invoices/${inv1.id}/credit-note`).set(as("adm")).send({ reason: "x", lines: [{ invoiceLineId: line, qty: 1 }] }).expect(409);
    await request(app).post(`/api/invoices/${cn.id}/credit-note`).set(as("adm")).send({ reason: "x", lines: [{ invoiceLineId: cn.lines[0].id, qty: 1 }] }).expect(400);
    const html = (await request(app).get(`/api/invoices/${cn.id}/print`).set(as("adm"))).text;
    expect(html).toContain("CREDIT NOTE"); expect(html).toContain(`Against invoice <b>${inv1.number}</b>`);
  });
});

describe("database transactions for stock", () => {
  it("withTx rolls back everything on error", async () => {
    const before = (await db.query("SELECT COUNT(*) AS n FROM doc_series")).rows[0].n;
    await expect(withTx(db, async tx => { await tx.query("INSERT INTO doc_series (company_id,kind,fy,next_no) VALUES (1,'test','1999-00',5)"); throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await db.query("SELECT COUNT(*) AS n FROM doc_series")).rows[0].n).toBe(before);
  });
  it("a failure mid-allocation leaves stock untouched", async () => {
    const o = await order("t1", shopIntra, [{ sku: "SPARA-500", qty: 35 }]);
    const snap = await stockOf("SPARA-500");
    const ord = (await db.query("SELECT * FROM orders WHERE id=$1", [o.id])).rows[0];
    await expect(withTx(db, tx => allocateStock(tx, ord.company_id, ord, { afterFirstUpdate: async () => { throw new Error("crash after first update"); } }))).rejects.toThrow("crash");
    expect(await stockOf("SPARA-500")).toEqual(snap);
    expect((await db.query("SELECT COUNT(*) AS n FROM order_allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1", [o.id])).rows[0].n).toBe(0);
    await accept(o.id);
    expect(await stockOf("SPARA-500")).toMatchObject({ "SB-0127": 0, "SB-0627": 195 });
    await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(409);
  });
});

describe("targets vs achievement", () => {
  it("manager sets targets (API + import); achievement computed; reps see only their own", async () => {
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
    const reps = (await request(app).get("/api/reps").set(as("adm"))).body; const repA = reps.find((r: any) => r.email === "r@x.com").id;
    await request(app).put("/api/targets").set(as("mgr")).send({ repId: repA, month, metric: "value", target: 2000 }).expect(200);
    await request(app).put("/api/targets").set(as("mgr")).send({ repId: repA, month, metric: "bananas", target: 1 }).expect(400);
    const imp = (await request(app).post("/api/import/targets").set(as("adm")).attach("file", csv([["Rep Email", "Month", "Metric", "Target"], ["r@x.com", month, "orders", 10], ["r2@x.com", month, "visits", 20], ["nobody@x.com", month, "orders", 5]]), "t.csv")).body;
    expect(imp.inserted).toBe(2); expect(imp.errors[0].error).toMatch(/not found/);
    const all = (await request(app).get(`/api/targets?month=${month}`).set(as("mgr"))).body;
    const a = all.find((r: any) => r.repId === repA);
    const orders = (await request(app).get("/api/orders").set(as("rep"))).body.filter((o: any) => o.status !== "rejected");
    const value = Math.round(orders.reduce((s: number, o: any) => s + Number(o.total), 0) * 100) / 100;
    expect(a.metrics.find((m: any) => m.metric === "value")).toEqual({ metric: "value", target: 2000, actual: value, pct: Math.round(value / 2000 * 1000) / 10 });
    expect(a.metrics.find((m: any) => m.metric === "orders")).toMatchObject({ target: 10, actual: orders.length });
    const mine = (await request(app).get(`/api/targets?month=${month}`).set(as("rep2"))).body;
    expect(mine).toHaveLength(1); expect(mine[0].metrics.find((m: any) => m.metric === "visits").target).toBe(20);
  });
});

describe("visit photos", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
  it("rep attaches photos to own visit; images only; scoped access", async () => {
    const v = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: shopIntra, lat: 13.08, lng: 80.27 }).expect(201)).body;
    const p = (await request(app).post(`/api/visits/${v.id}/photos`).set(as("rep")).field("caption", "Sample shelf").attach("photo", jpeg, "shelf.jpg").expect(201)).body;
    expect(p).toMatchObject({ mime: "image/jpeg", caption: "Sample shelf" });
    await request(app).post(`/api/visits/${v.id}/photos`).set(as("rep")).attach("photo", Buffer.from("not an image"), "x.jpg").expect(400);
    await request(app).post(`/api/visits/${v.id}/photos`).set(as("rep2")).attach("photo", jpeg, "x.jpg").expect(404);
    const got = await request(app).get(`/api/photos/${p.id}`).set(as("mgr")).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", d => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(Buffer.compare(got.body, jpeg)).toBe(0);
    await request(app).get(`/api/photos/${p.id}`).set(as("rep2")).expect(404);
    expect((await request(app).get(`/api/visits/${v.id}/photos`).set(as("rep"))).body).toHaveLength(1);
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Shop closed", lat: 13.08, lng: 80.27 }).expect(200);
  });
});

describe("report exports", () => {
  const bin = (r: any) => r.buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
  const sheet = (b: Buffer) => { const wb = XLSX.read(b); return XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]); };
  it("exports orders/visits/gst/stock/targets as xlsx or csv for managers only", async () => {
    const orders = sheet((await bin(request(app).get("/api/reports/orders").set(as("mgr"))).expect(200)).body);
    expect(orders.length).toBeGreaterThan(3); expect(orders[0]).toHaveProperty("base_qty");
    const gst = sheet((await bin(request(app).get("/api/reports/gst?from=2026-01-01").set(as("adm"))).expect(200)).body);
    expect(gst.some((r: any) => r.type === "Credit note" && r.taxable < 0)).toBe(true);
    expect(gst.some((r: any) => r.document === "INV/2025-26/0001" && r.igst === 12.75)).toBe(true);
    const visits = await request(app).get("/api/reports/visits?format=csv").set(as("mgr")).expect(200);
    expect(visits.headers["content-type"]).toMatch(/text\/csv/); expect(visits.text.split("\n")[0]).toContain("photos");
    expect(sheet((await bin(request(app).get("/api/reports/stock").set(as("mgr")))).body).some((r: any) => r.expired === "yes")).toBe(true);
    await request(app).get("/api/reports/targets").set(as("mgr")).expect(200);
    await request(app).get("/api/reports/nope").set(as("mgr")).expect(404);
    await request(app).get("/api/reports/orders").set(as("rep")).expect(403);
    await request(app).get("/api/reports/orders?from=2026-12-01&to=2026-01-01").set(as("mgr")).expect(400);
  });
});
