import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate, type Db } from "../src/db.js";
import { txDb } from "./txdb.js";
import { gstinError, gstinInfo, gstinCheckChar } from "../src/gstin.js";
import { fyOf } from "../src/billing.js";

let app: any, db: Db; const T: Record<string, string> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const put = (gst: any) => request(app).put("/api/company/settings").set(as("adm")).send({ gst });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeAll(async () => {
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ff-up-"));
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code: "GP", name: "GP (sample)", industry: "pharma", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T.adm = await login("GP", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.rep = await login("GP", "r@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
});

describe("GSTIN helpers", () => {
  it("validates format and check digit, derives state and PAN", () => {
    expect(gstinError("27AAPFU0939F1ZV")).toBe(""); expect(gstinError("29AAGCB7383J1Z4")).toBe("");
    expect(gstinError("27AAPFU0939F1ZX")).toMatch(/check digit/); expect(gstinError("00AAPFU0939F1ZV")).toMatch(/state code/);
    expect(gstinError("27AAPFU0939F1Z")).toMatch(/15/); expect(gstinError("2712345678901ZV")).toMatch(/format|15/);
    expect(gstinInfo("27AAPFU0939F1ZV")).toEqual({ stateCode: "27", state: "Maharashtra", pan: "AAPFU0939F" });
    expect(gstinCheckChar("33AAAAA0000A1Z")).toBe("9");
    expect(fyOf("2027-03-31", 4)).toBe("2026-27"); expect(fyOf("2027-03-31", 1)).toBe("2027");
  });
});

describe("company GST profile", () => {
  it("auto-derives state code, state name and PAN; rejects bad identifiers", async () => {
    const s = (await put({ legalName: "Sample Traders Pvt Ltd", gstin: "27aapfu0939f1zv", address: "1 Sample Road, Pune" }).expect(200)).body.settings.gst;
    expect(s).toMatchObject({ gstin: "27AAPFU0939F1ZV", stateCode: "27", stateName: "Maharashtra", pan: "AAPFU0939F" });
    await put({ gstin: "27AAPFU0939F1ZX" }).expect(400);
    await put({ pan: "ABCDE1234F" }).expect(400);
    for (const bad of [{ tan: "X" }, { cin: "123" }, { udyam: "UDYAM-1" }, { bankIfsc: "HDFC1234567" }, { upiId: "nope" }, { regType: "x" }, { fyStartMonth: 13 }, { logo: "javascript:1" }, { branches: [{ name: "B", gstin: "29AAGCB7383J1Z5" }] }])
      await put(bad).expect(400);
  });
  it("saves the full profile and prints it on invoices", async () => {
    const g = (await put({ tradeName: "Sample Mart", tan: "PNEA12345B", cin: "U12345MH2020PTC123456", udyam: "UDYAM-MH-01-0001234", regType: "regular", email: "acc@example.com", phone: "+91 98765 43210",
      pincode: "411001", bankName: "Sample Bank", bankAccount: "123456789012", bankIfsc: "SBIN0001234", bankBranch: "Pune", upiId: "sample@upi", logo: PNG, signatoryName: "A Sample", signatoryDesignation: "Director", signature: PNG,
      einvoiceApplicable: true, ewayBill: true, tcsApplicable: false, tdsApplicable: true, defaultHsn: "3004", lutNo: "AD270000000000X", terms: "Goods once sold will not be taken back.", declaration: "We declare that this invoice shows the actual price.",
      branches: [{ name: "Bengaluru depot", gstin: "29AAGCB7383J1Z4", address: "2 Sample St", pincode: "560001" }] }).expect(200)).body.settings.gst;
    expect(g.branches[0]).toMatchObject({ stateCode: "29" }); expect(g.ewayBill).toBe(true);
    const shop = (await request(app).get("/api/shops").set(as("adm"))).body[0];
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "gp1", shopId: shop.id, lines: [{ sku: "SPARA-500", qty: 1 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
    const inv = (await request(app).post(`/api/orders/${o.id}/invoice`).set(as("adm")).expect(201)).body;
    const html = (await request(app).get(`/api/invoices/${inv.id}/print`).set(as("adm")).expect(200)).text;
    for (const s of ["Sample Mart", "PAN AAPFU0939F", "CIN U12345MH2020PTC123456", "IFSC SBIN0001234", "UPI sample@upi", "A Sample, Director", "Authorised signatory", "LUT", "Goods once sold", "Maharashtra (27)"]) expect(html).toContain(s);
    expect(html).toContain("<img class=\"logo\"");
  });
  it("outlet import rejects a GSTIN with a wrong check digit", async () => {
    const r = (await request(app).post("/api/import/shops").set(as("adm")).attach("file", csv([["Code", "Name", "GSTIN"], ["X1", "Sample X", "27AAPFU0939F1ZX"], ["X2", "Sample Y", "27AAPFU0939F1ZV"]]), "s.csv").expect(200)).body;
    expect(r.errors.length).toBe(1); expect(r.inserted).toBe(1);
  });
});
