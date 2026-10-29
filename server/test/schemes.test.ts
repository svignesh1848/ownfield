import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const scheme = (b: any, code = 201) => request(app).post("/api/schemes").set(as("adm")).send(b).expect(code);

beforeAll(async () => {
  const db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "SC", name: "SC (sample)", industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("SC", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["D1", "d1@x.com", "distributor", "pw"], ["D2", "d2@x.com", "distributor", "pw"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.d1 = await login("SC", "d1@x.com"); T.d2 = await login("SC", "d2@x.com"); T.rep = await login("SC", "r@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ gst: { legalName: "SC (sample)", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
  const ds = (await request(app).get("/api/distributors").set(as("adm"))).body; id.d1 = ds.find((d: any) => d.email === "d1@x.com").id;
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s1 = shops[0].id; id.s3 = shops[2].id;
  await request(app).post(`/api/shops/${id.s1}/distributor`).set(as("adm")).send({ distributorId: id.d1 });
  id.romper = (await request(app).get("/api/items").set(as("adm"))).body.find((i: any) => i.code === "SAMPLE-ROMPER").id;
});

describe("schemes", () => {
  it("validates and creates every scheme type with scopes", async () => {
    await scheme({ name: "x", type: "mystery" }, 400);
    await scheme({ name: "x", type: "slab", slabs: [] }, 400);
    await scheme({ name: "x", type: "bxgy", buy: 0, get: 1 }, 400);
    await scheme({ name: "x", type: "percent", discountPct: 5, startsOn: "2026-05-01", endsOn: "2026-04-01" }, 400);
    await scheme({ name: "Sample Tops 5%", type: "percent", discountPct: 5, category: "Tops", minQty: 6 });
    await scheme({ name: "Sample Tops slab", type: "slab", basis: "qty", category: "tops", slabs: [{ min: 24, pct: 12 }, { min: 12, pct: 8 }] });
    await scheme({ name: "Sample D1 ₹30 off", type: "flat", amount: 30, category: "Tops", distributorId: id.d1 });
    await scheme({ name: "Sample Romper 10+1", type: "bxgy", buy: 10, get: 1, itemId: id.romper });
    await scheme({ name: "Sample expired 50%", type: "percent", discountPct: 50, endsOn: "2020-01-31" });
    await scheme({ name: "Sample value slab", type: "slab", basis: "value", itemId: id.romper, slabs: [{ min: 100000, pct: 20 }] });
    const list = (await request(app).get("/api/schemes").set(as("d2"))).body;
    expect(list.map((s: any) => s.name)).not.toContain("Sample D1 ₹30 off");
    expect(list.find((s: any) => s.type === "bxgy").rule).toBe("Buy 10 get 1 free");
    expect(list.find((s: any) => s.name === "Sample expired 50%").live).toBe(false);
  });
  const cart = { lines: [{ sku: "STEE-2Y-RED", qty: 12 }, { sku: "SROM-0-3M", qty: 20 }] };
  let oid = 0;
  it("preview and order apply the best scheme per line plus free goods", async () => {
    const p = (await request(app).post("/api/orders/preview").set(as("rep")).send({ shopId: id.s3, ...cart }).expect(200)).body;
    expect(p).toMatchObject({ gross: 3360 + 8400 + 840, savings: 268.8 + 840, total: 11491.2 });
    expect(p.lines.map((l: any) => [l.scheme, l.free, l.amount])).toEqual([["Sample Tops slab", false, 3091.2], [null, false, 8400], ["Sample Romper 10+1", true, 0]]);
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "c1", shopId: id.s3, ...cart }).expect(201)).body;
    oid = o.id; expect(Number(o.total)).toBe(11491.2); expect(Number(o.savings)).toBe(1108.8);
    const d1 = (await request(app).post("/api/orders/preview").set(as("rep")).send({ shopId: id.s1, lines: [{ sku: "STEE-2Y-RED", qty: 6 }] })).body;
    expect(d1.lines[0]).toMatchObject({ scheme: "Sample D1 ₹30 off", amount: 1500, saving: 180 });
    await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "c2", shopId: id.s1, lines: [{ sku: "STEE-2Y-RED", qty: 6 }] }).expect(201);
  });
  it("invoices carry scheme pricing and free goods at zero", async () => {
    await request(app).post(`/api/orders/${oid}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
    const inv = (await request(app).post(`/api/orders/${oid}/invoice`).set(as("adm")).send({}).expect(201)).body;
    expect(inv.taxable).toBe(11491.2);
    expect(inv.lines[2]).toMatchObject({ taxable: 0, base_qty: 2 }); expect(inv.lines[2].description).toContain("FREE under scheme: Sample Romper 10+1");
    expect(inv.lines[0].description).toContain("scheme: Sample Tops slab");
  });
  it("scheme cost report and toggle", async () => {
    const r = (await request(app).get("/api/reports/schemes?format=csv").set(as("adm")).expect(200)).text;
    expect(r).toContain("Sample Tops slab"); expect(r).toMatch(/Sample Romper 10\+1.*,1,0,2,840,840/); expect(r).toMatch(/Sample D1 ₹30 off.*,1,180,0,0,180/);
    const sid = (await request(app).get("/api/schemes").set(as("adm"))).body.find((s: any) => s.name === "Sample Romper 10+1").id;
    await request(app).post(`/api/schemes/${sid}/active`).set(as("adm")).send({ active: false }).expect(200);
    const p = (await request(app).post("/api/orders/preview").set(as("rep")).send({ shopId: id.s3, ...cart })).body;
    expect(p.lines).toHaveLength(2);
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false } }).expect(200);
    expect((await request(app).post("/api/orders/preview").set(as("rep")).send({ shopId: id.s3, ...cart })).body.savings).toBe(0);
  });
});
