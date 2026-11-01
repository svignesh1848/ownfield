import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { parseDate, parseUnits } from "../src/catalog.js";

let app: any; let owner: string; const T: Record<string, string> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const imp = (t: string, kind: string, rows: (string | number)[][]) => request(app).post(`/api/import/${kind}`).set(as(t)).attach("file", csv(rows), `${kind}.csv`);
async function company(code: string, industry: string) {
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${owner}`)
    .send({ code, name: `${code} (sample)`, industry, userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T[code] = await login(code, "a@x.com");
  await imp(code, "users", [["Name", "Email", "Role", "Password", "Drug Licence"], ["Rep", "r@x.com", "sales_rep", "pw", ""], ["Dist", "d@x.com", "distributor", "pw", "SAMPLE-DL-9"]]);
  T[code + "_rep"] = await login(code, "r@x.com"); T[code + "_dist"] = await login(code, "d@x.com");
}
const shopId = async (c: string, code?: string) => (await request(app).get("/api/shops").set(as(c))).body.find((s: any) => !code || s.code === code).id;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); const db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  owner = await login("PLATFORM", "o@x.com");
  for (const [c, i] of [["PH", "pharma"], ["FM", "fmcg"], ["SV", "services"], ["AP", "apparel"]]) await company(c, i);
});

describe("helpers", () => {
  it("parses dates and units", () => {
    expect(parseDate("31/03/2027")).toBe("2027-03-31");
    expect(parseDate("02/2028")).toBe("2028-02-29");
    expect(parseDate(46388)).toBe("2027-01-01");
    expect(() => parseDate("31/02/2027")).toThrow();
    expect(parseUnits("BOX=10|STRIP=1")).toEqual([{ code: "STRIP", factor: 1 }, { code: "BOX", factor: 10 }]);
    expect(() => parseUnits("BOX=10")).toThrow(/base unit/);
  });
});

describe("templates & settings", () => {
  it("each industry presets features/attributes; templates listed", async () => {
    const t = (await request(app).get("/api/templates")).body;
    expect(t.map((x: any) => x.id)).toEqual(["apparel", "fmcg", "pharma", "retail", "services", "custom"]);
    const ph = (await request(app).get("/api/company/settings").set(as("PH_rep"))).body;
    expect(ph.industry).toBe("pharma");
    expect(ph.settings.features).toMatchObject({ stock: true, batches: true, drugLicence: true, sizeGrid: false });
    expect(ph.settings.attributes).toEqual(["strength", "form"]);
    expect((await request(app).get("/api/company/settings").set(as("AP"))).body.settings.features.sizeGrid).toBe(true);
  });
  it("admin edits settings, validation rejects bad input, others cannot edit", async () => {
    const r = await request(app).put("/api/company/settings").set(as("AP")).send({ features: { stock: true }, attributes: "Size, Colour, Fit",
      customFields: { outlet: [{ label: "Region", type: "select", options: "North,South", required: true }] } }).expect(200);
    expect(r.body.settings.features.stock).toBe(true);
    expect(r.body.settings.attributes).toEqual(["size", "colour", "fit"]);
    await request(app).put("/api/company/settings").set(as("AP")).send({ uoms: "BOX=6" }).expect(400);
    await request(app).put("/api/company/settings").set(as("AP")).send({ customFields: { product: [{ label: "X", type: "select" }] } }).expect(400);
    await request(app).put("/api/company/settings").set(as("AP_rep")).send({ features: { gps: false } }).expect(403);
    const back = await request(app).put("/api/company/settings").set(as("AP")).send({ industry: "apparel", applyTemplate: true }).expect(200);
    expect(back.body.settings.features.stock).toBe(false);
  });
  it("loads per-template sample data, all labelled sample", async () => {
    const r = (await request(app).post("/api/company/sample-data").set(as("PH")).expect(200)).body;
    expect(r.products.errors).toEqual([]); expect(r.stock.inserted).toBe(5);
    const items = (await request(app).get("/api/items").set(as("PH"))).body;
    expect(items.every((i: any) => /sample/i.test(i.name))).toBe(true);
    expect(items[0].variants[0].attrs).toHaveProperty("strength");
    const shops = (await request(app).get("/api/shops").set(as("PH"))).body;
    expect(shops[0].drug_licence).toMatch(/SAMPLE-DL/); expect(shops[0].custom.chemist_type).toBeTruthy();
    expect((await request(app).get("/api/users").set(as("PH"))).body.find((u: any) => u.role === "distributor").drug_licence).toBe("SAMPLE-DL-9");
  });
});

describe("configurable products, units and custom fields (FMCG)", () => {
  it("import adapts to attributes; units & custom fields validated per row", async () => {
    const r = (await imp("FM", "products", [["Item Code", "Item Name", "SKU", "Pack Size", "Flavour", "MRP", "Billing Price", "Units", "Shelf life days"],
      ["SAMPLE-CHIPS", "Sample Chips", "SCH-50", "50g", "Salted", 20, 16, "PCS=1|BOX=12|CASE=120", 90],
      ["SAMPLE-CHIPS", "Sample Chips", "SCH-50M", "50g", "Masala", 20, 16, "PCS=1|BOX=12|CASE=120", "ninety"],
      ["SAMPLE-CHIPS", "Sample Chips", "SCH-BAD", "50g", "Masala", 20, 16, "BOX=12", 90]])).body;
    expect(r.inserted).toBe(1);
    expect(r.errors.map((e: any) => e.error)).toEqual([expect.stringMatching(/number/), expect.stringMatching(/base unit/)]);
    const item = (await request(app).get("/api/items").set(as("FM"))).body.find((i: any) => i.code === "SAMPLE-CHIPS");
    expect(item.variants[0].attrs).toEqual({ pack_size: "50g", flavour: "Salted" });
    expect(item.custom.shelf_life_days).toBe(90);
  });
  it("outlet custom select validated on import", async () => {
    const r = (await imp("FM", "shops", [["Code", "Name", "Outlet class"], ["O1", "Sample Outlet", "b"], ["O2", "Sample Outlet 2", "Z"]])).body;
    expect(r.inserted).toBe(1); expect(r.errors[0].error).toMatch(/one of A, B, C/);
    expect((await request(app).get("/api/shops").set(as("FM"))).body.find((s: any) => s.code === "O1").custom.outlet_class).toBe("B");
  });
  it("orders convert units to base qty, check stock, apply schemes", async () => {
    await imp("FM", "stock", [["SKU", "Qty", "Unit"], ["SCH-50", 2, "CASE"]]);
    const sid = await shopId("FM", "O1");
    const it = (await request(app).get("/api/items").set(as("FM"))).body.find((i: any) => i.code === "SAMPLE-CHIPS");
    await request(app).post("/api/schemes").set(as("FM")).send({ name: "Sample 5% on 2+ boxes", itemId: it.id, minQty: 24, discountPct: 5 }).expect(201);
    const o = (await request(app).post("/api/orders").set(as("FM_rep")).send({ clientRef: "fm1", shopId: sid, lines: [{ sku: "SCH-50", qty: 2, uom: "BOX" }] }).expect(201)).body;
    expect(Number(o.total)).toBe(364.8); // 24 pcs × 16 × 0.95
    const big = await request(app).post("/api/orders").set(as("FM_rep")).send({ clientRef: "fm2", shopId: sid, lines: [{ sku: "SCH-50", qty: 3, uom: "CASE" }] });
    expect(big.status).toBe(409); expect(big.body.error).toMatch(/216 available/); // 24 of 240 are held by order fm1
    await request(app).post("/api/orders").set(as("FM_rep")).send({ clientRef: "fm3", shopId: sid, lines: [{ sku: "SCH-50", qty: 1, uom: "PALLET" }] }).expect(400);
  });
});

describe("pharma batches & FEFO", () => {
  it("rejects stock without batch/expiry; allocates earliest non-expired batch first", async () => {
    expect((await imp("PH", "stock", [["SKU", "Qty"], ["SPARA-650", 5]])).body.errors[0].error).toMatch(/batch and expiry/);
    const sid = await shopId("PH");
    // SPARA-500 sample stock: expired 50 strips (excluded), SB-0127 30 strips, SB-0627 20 boxes = 200 strips
    const tooMuch = await request(app).post("/api/orders").set(as("PH_rep")).send({ clientRef: "ph0", shopId: sid, lines: [{ sku: "SPARA-500", qty: 24, uom: "BOX" }] });
    expect(tooMuch.status).toBe(409); expect(tooMuch.body.error).toMatch(/230 available/);
    const o = (await request(app).post("/api/orders").set(as("PH_rep")).send({ clientRef: "ph1", shopId: sid, lines: [{ sku: "SPARA-500", qty: 4, uom: "BOX" }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("PH")).send({ status: "accepted" }).expect(200);
    const line = (await request(app).get("/api/orders").set(as("PH"))).body.find((x: any) => x.id === o.id).lines[0];
    expect(line.base_qty).toBe(40);
    expect(line.allocations).toEqual([{ batch_no: "SB-0127", expiry: "2027-01-31", qty: 30 }, { batch_no: "SB-0627", expiry: "2027-06-30", qty: 10 }]);
    const stock = (await request(app).get("/api/stock").set(as("PH"))).body.filter((s: any) => s.sku === "SPARA-500");
    expect(stock.map((s: any) => [s.batch_no, s.qty, s.expired])).toEqual([["SB-EXPIRED", 50, true], ["SB-0127", 0, false], ["SB-0627", 190, false]]);
  });
  it("distributor uploads own stock only", async () => {
    const r = (await imp("PH_dist", "stock", [["SKU", "Batch", "Expiry", "Qty"], ["SPARA-650", "SB-D1", "30/11/2027", 40]])).body;
    expect(r.inserted).toBe(1);
    const mine = (await request(app).get("/api/stock").set(as("PH_dist"))).body;
    expect(mine).toHaveLength(1); expect(mine[0].expiry).toBe("2027-11-30");
    await imp("PH_dist", "products", [["SKU"], ["x"]]).expect(403);
  });
});

describe("services (non-stock) and feature toggles", () => {
  it("service items need no stock even with stock tracking on; GPS optional when off; visit custom fields enforced", async () => {
    await request(app).post("/api/company/sample-data").set(as("SV")).expect(200);
    await request(app).put("/api/company/settings").set(as("SV")).send({ features: { stock: true, gps: false } }).expect(200);
    const sid = await shopId("SV");
    const o = await request(app).post("/api/orders").set(as("SV_rep")).send({ clientRef: "sv1", shopId: sid, lines: [{ sku: "SAMC-PREMIUM", qty: 1 }] }).expect(201);
    expect(Number(o.body.total)).toBe(8000);
    const v = (await request(app).post("/api/visits/checkin").set(as("SV_rep")).send({ shopId: sid }).expect(201)).body;
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("SV_rep")).send({ noOrderReason: "Shop closed", custom: { customer_rating: "5" } }).expect(400);
    const done = (await request(app).post(`/api/visits/${v.id}/checkout`).set(as("SV_rep")).send({ noOrderReason: "Shop closed", custom: { work_done: "Sample filter clean", customer_rating: "5" } }).expect(200)).body;
    expect(JSON.parse(done.custom)).toEqual({ work_done: "Sample filter clean", customer_rating: "5" });
    // GPS still required where enabled
    await request(app).post("/api/visits/checkin").set(as("PH_rep")).send({ shopId: await shopId("PH") }).expect(400);
  });
  it("service items are rejected when the services feature is off", async () => {
    const r = (await imp("FM", "products", [["Item Code", "SKU", "Type", "Billing Price"], ["SAMPLE-SVC", "SSVC", "service", 100]])).body;
    expect(r.errors[0].error).toMatch(/Services feature/);
  });
});
