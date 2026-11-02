// Gap features (2 Nov 2026): sales hierarchy & territories, retailer account view, single product screen,
// sales returns with GST credit notes, and new-outlet approval. All data here is labelled sample.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate, type Db } from "../src/db.js";
import { today } from "../src/catalog.js";
import { txDb } from "./txdb.js";

let app: any, db: Db; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPhfDwAEjAH/3h2P6wAAAABJRU5ErkJggg==";
let n = 0;

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const code of ["GA", "GB"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code, name: `${code} (sample)`, industry: "apparel", userLimit: 20, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T.adm = await login("GA", "a@x.com"); T.admB = await login("GB", "a@x.com");
  await request(app).post("/api/territories").set(as("adm")).send({ name: "South Zone (sample)", level: "Zone" }).expect(201);
  const z = (await request(app).get("/api/territories").set(as("adm"))).body[0];
  await request(app).post("/api/territories").set(as("adm")).send({ name: "Chennai Area (sample)", level: "Area", parentId: z.id }).expect(201);
  // User upload with the new Reports To and Territory columns (managers listed before their reps).
  const r = await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password", "Reports To", "Territory"],
    ["Mgr One", "m1@x.com", "manager", "pw", "a@x.com", "South Zone (sample)"], ["Mgr Two", "m2@x.com", "manager", "pw", "", ""],
    ["Rep One", "r1@x.com", "sales_rep", "pw", "m1@x.com", "Chennai Area (sample)"], ["Rep Two", "r2@x.com", "sales_rep", "pw", "m1@x.com", ""],
    ["Rep Three", "r3@x.com", "sales_rep", "pw", "", ""], ["Dist", "d@x.com", "distributor", "pw", "", ""], ["Bad", "b@x.com", "sales_rep", "pw", "nobody@x.com", ""]]), "u.csv").expect(200);
  expect(r.body.inserted).toBe(6); expect(r.body.errors[0].error).toMatch(/reports to/);
  for (const k of ["m1", "m2", "r1", "r2", "r3", "d"]) T[k] = await login("GA", `${k}@x.com`);
  const users = (await request(app).get("/api/users").set(as("adm"))).body;
  for (const u of users) id[u.email.split("@")[0]] = u.id;
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false, retailerApp: true, leave: true }, gst: { legalName: "GA Sample Co", gstin: "33AAAAA0000A1Z9", stateCode: "33" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body;
  id.s1 = shops[0].id; id.s2 = shops[1].id; id.s3 = shops[2].id;
  await request(app).post(`/api/shops/${id.s1}/distributor`).set(as("adm")).send({ distributorId: id.d }).expect(200);
  await request(app).post("/api/beats").set(as("adm")).send({ name: "Rep One beat (sample)", repId: id.r1, shopIds: [id.s1, id.s2] }).expect(201);
  await request(app).post("/api/users").set(as("adm")).send({ email: "ret@x.com", name: "Sample Retailer", password: "pw", role: "retailer", shopId: id.s1 }).expect(201);
  T.ret = await login("GA", "ret@x.com");
});

describe("1. sales hierarchy and territories", () => {
  it("upload sets reports-to and territory; org chart shows them; loops are refused", async () => {
    const h = (await request(app).get("/api/hierarchy").set(as("adm")).expect(200)).body;
    const r1 = h.users.find((u: any) => u.id === id.r1);
    expect(r1).toMatchObject({ reports_to: id.m1, territory: "Chennai Area (sample)" });
    expect(h.territories.map((t: any) => t.name)).toContain("South Zone (sample)");
    await request(app).put(`/api/users/${id.m1}/hierarchy`).set(as("adm")).send({ reportsTo: id.r1 }).expect(400); // r1 → m1 → r1
    await request(app).put(`/api/users/${id.r1}/hierarchy`).set(as("adm")).send({ reportsTo: id.r1 }).expect(400);
    await request(app).put(`/api/users/${id.r1}/hierarchy`).set(as("m1")).send({ reportsTo: id.m2 }).expect(403);
    await request(app).put(`/api/users/${id.r1}/hierarchy`).set(as("admB")).send({ reportsTo: null }).expect(404); // other company
    await request(app).post("/api/territories").set(as("adm")).send({ name: "x", level: "Galaxy" }).expect(400);
  });
  it("a manager sees only their team; a manager without reports and the admin see everyone", async () => {
    const reps = async (t: string) => (await request(app).get("/api/reps").set(as(t)).expect(200)).body.map((r: any) => r.id).sort();
    expect(await reps("m1")).toEqual([id.r1, id.r2].sort());
    expect(await reps("m2")).toEqual([id.r1, id.r2, id.r3].sort()); // backward compatible
    expect(await reps("adm")).toEqual([id.r1, id.r2, id.r3].sort());
    const h = (await request(app).get("/api/hierarchy").set(as("m1")).expect(200)).body;
    expect(h.scoped).toBe(true); expect(h.users.map((u: any) => u.id).sort()).toEqual([id.m1, id.r1, id.r2].sort());
    // orders, dashboard, visits, exports
    await request(app).post("/api/orders").set(as("r1")).send({ clientRef: `h${++n}`, shopId: id.s1, lines: [{ sku: "STEE-2Y-RED", qty: 2 }] }).expect(201);
    await request(app).post("/api/orders").set(as("r3")).send({ clientRef: `h${++n}`, shopId: id.s3, lines: [{ sku: "STEE-2Y-RED", qty: 2 }] }).expect(201);
    const ord = async (t: string) => (await request(app).get("/api/orders").set(as(t)).expect(200)).body.map((o: any) => o.rep_id);
    expect(new Set(await ord("m1"))).toEqual(new Set([id.r1]));
    expect(new Set(await ord("m2"))).toEqual(new Set([id.r1, id.r3]));
    const dash = (await request(app).get("/api/dashboard").set(as("m1")).expect(200)).body;
    expect(dash.every((d: any) => [id.r1, id.r2].includes(d.repId))).toBe(true);
    const x = await request(app).get("/api/reports/orders?format=csv").set(as("m1")).expect(200);
    expect(x.text).toContain("Rep One"); expect(x.text).not.toContain("Rep Three");
    const cr = (await request(app).post("/api/report-builder/preview").set(as("m1")).send({ def: { source: "orders", filters: { dateRange: { preset: "this_month" } }, groupBy: ["rep"], metrics: [{ fn: "count" }], view: { type: "table" } } }).expect(200)).body;
    expect(JSON.stringify(cr)).toContain("Rep One"); expect(JSON.stringify(cr)).not.toContain("Rep Three");
    const all = (await request(app).post("/api/report-builder/preview").set(as("m2")).send({ def: { source: "orders", filters: { dateRange: { preset: "this_month" } }, groupBy: ["rep"], metrics: [{ fn: "count" }], view: { type: "table" } } }).expect(200)).body;
    expect(JSON.stringify(all)).toContain("Rep Three");
  });
  it("approvals: a manager cannot decide leave for someone outside the team", async () => {
    const d = new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10);
    const l = (await request(app).post("/api/leaves").set(as("r3")).send({ from: d, to: d, kind: "Casual", reason: "Sample" }).expect(201)).body;
    await request(app).post(`/api/leaves/${l.id}/decision`).set(as("m1")).send({ status: "approved" }).expect(404);
    expect((await request(app).get("/api/leaves").set(as("m1"))).body.map((x: any) => x.id)).not.toContain(l.id);
    await request(app).post(`/api/leaves/${l.id}/decision`).set(as("m2")).send({ status: "approved" }).expect(200);
  });
});

describe("5. new-outlet approval", () => {
  let pid = 0;
  it("rep adds an outlet with GPS (photo optional); it is pending; offline retry is deduped", async () => {
    await request(app).post("/api/outlets/request").set(as("r1")).send({ clientRef: "no1", name: "Sample New Shop" }).expect(400); // GPS required
    const body = { clientRef: "no2", name: "Sample New Shop (sample)", city: "Chennai", phone: "9000000099", lat: 13.05, lng: 80.25, photo: PNG };
    const a = (await request(app).post("/api/outlets/request").set(as("r1")).send(body).expect(201)).body;
    expect(a).toMatchObject({ approval_status: "pending", added_by: id.r1 });
    const b = (await request(app).post("/api/outlets/request").set(as("r1")).send(body).expect(200)).body; expect(b.id).toBe(a.id); expect(b.duplicate).toBe(true);
    pid = a.id;
    await request(app).post("/api/outlets/request").set(as("m1")).send(body).expect(403);
  });
  it("pending outlets cannot take orders (unless the company allows it)", async () => {
    const o = () => request(app).post("/api/orders").set(as("r1")).send({ clientRef: `p${++n}`, shopId: pid, lines: [{ sku: "STEE-2Y-RED", qty: 1 }] });
    await o().expect(409);
    await request(app).put("/api/outlet-rules").set(as("adm")).send({ pendingCanOrder: true }).expect(200);
    await o().expect(201);
    await request(app).put("/api/outlet-rules").set(as("adm")).send({ pendingCanOrder: false }).expect(200);
    await request(app).put("/api/outlet-rules").set(as("m1")).send({ pendingCanOrder: true }).expect(403);
  });
  it("reps see their own beats' outlets plus the ones they added (setting, default on)", async () => {
    const mine = async (t: string) => (await request(app).get("/api/shops").set(as(t)).expect(200)).body.map((s: any) => s.id);
    const r1 = await mine("r1"); expect(r1).toEqual(expect.arrayContaining([id.s1, id.s2, pid])); expect(r1).not.toContain(id.s3);
    expect(await mine("r3")).not.toContain(pid); expect(await mine("r3")).toContain(id.s3); // no beats yet: still sees approved outlets
    await request(app).put("/api/outlet-rules").set(as("adm")).send({ repOwnBeatsOnly: false }).expect(200);
    expect(await mine("r3")).toContain(id.s3);
    await request(app).put("/api/outlet-rules").set(as("adm")).send({ repOwnBeatsOnly: true }).expect(200);
  });
  it("only the rep's manager line approves or rejects with a reason; admin-created outlets are approved", async () => {
    expect((await request(app).get("/api/outlets/pending").set(as("m1")).expect(200)).body.map((s: any) => s.id)).toContain(pid);
    await request(app).post(`/api/outlets/${pid}/decision`).set(as("r1")).send({ decision: "approve" }).expect(403);
    await request(app).post(`/api/outlets/${pid}/decision`).set(as("m1")).send({ decision: "reject" }).expect(400); // reason needed
    await request(app).get(`/api/outlets/${pid}/photo`).set(as("m1")).expect(200);
    await request(app).get(`/api/outlets/${pid}/photo`).set(as("r3")).expect(404);
    await request(app).post(`/api/outlets/${pid}/decision`).set(as("admB")).send({ decision: "approve" }).expect(404);
    const ok = (await request(app).post(`/api/outlets/${pid}/decision`).set(as("m1")).send({ decision: "approve" }).expect(200)).body;
    expect(ok.approval_status).toBe("approved");
    await request(app).post(`/api/outlets/${pid}/decision`).set(as("m1")).send({ decision: "approve" }).expect(409);
    const r = (await request(app).post("/api/outlets/request").set(as("r3")).send({ clientRef: "no3", name: "Sample Other (sample)", lat: 12.9, lng: 77.5 }).expect(201)).body;
    await request(app).post(`/api/outlets/${r.id}/decision`).set(as("m1")).send({ decision: "reject", reason: "dup" }).expect(404); // r3 is not in m1's team
    expect((await request(app).post(`/api/outlets/${r.id}/decision`).set(as("adm")).send({ decision: "reject", reason: "Duplicate of an existing outlet" }).expect(200)).body.approval_status).toBe("rejected");
    expect((await request(app).get("/api/outlets/mine").set(as("r3")).expect(200)).body[0]).toMatchObject({ approval_status: "rejected", approval_reason: "Duplicate of an existing outlet" });
    const adm = (await request(app).post("/api/shops").set(as("adm")).send({ code: "ADM-1", name: "Admin Sample Shop" }).expect(201)).body;
    expect(adm.approval_status).toBe("approved");
  });
});

describe("3. single product add / edit", () => {
  let itemId = 0;
  it("adds a product with sizes, MRP, price, GST/HSN, images and active, with the upload's checks", async () => {
    const body = { code: "SAMPLE-STYLE-9", name: "Sample Frock (sample)", category: "Girls", hsn: "6104", images: ["https://example.com/frock.jpg"], active: true,
      variants: [{ sku: "SF9-2Y", attrs: { size: "2Y", colour: "Pink" }, mrp: 599, billing_price: 420, barcode: "8900000099901" }, { sku: "SF9-3Y", attrs: { size: "3Y", colour: "Pink" }, mrp: 649, billing_price: 455 }] };
    await request(app).post("/api/products/item").set(as("m1")).send(body).expect(403);
    await request(app).post("/api/products/item").set(as("adm")).send({ ...body, variants: [{ ...body.variants[0], billing_price: 700 }] }).expect(400); // price > MRP
    await request(app).post("/api/products/item").set(as("adm")).send({ ...body, hsn: "61" }).expect(400);
    await request(app).post("/api/products/item").set(as("adm")).send({ ...body, images: ["javascript:alert(1)"] }).expect(400);
    await request(app).post("/api/products/item").set(as("adm")).send({ ...body, variants: [body.variants[0], body.variants[0]] }).expect(400);
    const r = (await request(app).post("/api/products/item").set(as("adm")).send(body).expect(201)).body;
    expect(r).toHaveLength(2); expect(r[0]).toMatchObject({ item_code: "SAMPLE-STYLE-9", hsn: "6104", images: ["https://example.com/frock.jpg"], mrp: 599, billing_price: 420 });
    itemId = r[0].item_id;
    await request(app).post("/api/products/item").set(as("adm")).send(body).expect(409);
  });
  it("edits: change price, drop a size (deactivated, hidden from reps), keep code", async () => {
    const r = (await request(app).put(`/api/products/item/${itemId}`).set(as("adm")).send({ code: "SAMPLE-STYLE-9", name: "Sample Frock v2 (sample)", hsn: "6104",
      variants: [{ sku: "SF9-2Y", attrs: { size: "2Y", colour: "Pink" }, mrp: 599, billing_price: 399 }] }).expect(200)).body;
    expect(r.find((v: any) => v.sku === "SF9-2Y")).toMatchObject({ billing_price: 399, item_name: "Sample Frock v2 (sample)", active: true });
    expect(r.find((v: any) => v.sku === "SF9-3Y").active).toBe(false);
    const repSees = (await request(app).get("/api/products").set(as("r1"))).body.map((v: any) => v.sku);
    expect(repSees).toContain("SF9-2Y"); expect(repSees).not.toContain("SF9-3Y");
    await request(app).put(`/api/products/item/${itemId}`).set(as("adm")).send({ code: "OTHER", name: "x", variants: [{ sku: "SF9-2Y", mrp: 1, billing_price: 1 }] }).expect(400);
    await request(app).put(`/api/products/item/${itemId}`).set(as("admB")).send({ code: "SAMPLE-STYLE-9", name: "x", variants: [{ sku: "Z", mrp: 1, billing_price: 1 }] }).expect(404);
  });
  it("the product upload accepts the same Images and Active columns", async () => {
    const r = await request(app).post("/api/import/products").set(as("adm")).attach("file", csv([["Item Code", "Item Name", "SKU", "Size", "MRP", "Billing Price", "HSN", "Images", "Active"],
      ["SAMPLE-UP-1", "Sample Upload Tee (sample)", "SUT-1", "2Y", 300, 200, "6109", "https://example.com/a.jpg", "No"]]), "p.csv").expect(200);
    expect(r.body.errors).toEqual([]);
    const v = (await request(app).get("/api/products").set(as("adm"))).body.find((x: any) => x.sku === "SUT-1");
    expect(v).toMatchObject({ active: false, images: ["https://example.com/a.jpg"] });
  });
});

describe("4. sales returns and 2. retailer account", () => {
  let inv: any;
  it("rep books a return against an invoice; over-return is refused; offline retry deduped", async () => {
    const o = (await request(app).post("/api/orders").set(as("r1")).send({ clientRef: `rv${++n}`, shopId: id.s1, lines: [{ sku: "STEE-2Y-RED", qty: 10 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
    inv = (await request(app).post(`/api/orders/${o.id}/invoice`).set(as("adm")).send({}).expect(201)).body;
    const line = inv.lines[0];
    const base = { shopId: id.s1, invoiceId: inv.id, reason: "Damaged", photo: PNG };
    await request(app).post("/api/returns").set(as("r1")).send({ ...base, clientRef: "rt0", lines: [{ invoiceLineId: line.id, qty: 11, condition: "damaged" }] }).expect(409);
    await request(app).post("/api/returns").set(as("d")).send({ ...base, clientRef: "rtx", lines: [{ invoiceLineId: line.id, qty: 1 }] }).expect(403);
    const r = (await request(app).post("/api/returns").set(as("r1")).send({ ...base, clientRef: "rt1", lines: [{ invoiceLineId: line.id, qty: 3, condition: "saleable" }, { invoiceLineId: line.id, qty: 2, condition: "damaged" }] }).expect(201)).body;
    expect(r).toMatchObject({ status: "pending", distributor_id: id.d, invoice_number: inv.number, has_photo: true });
    expect((await request(app).post("/api/returns").set(as("r1")).send({ ...base, clientRef: "rt1", lines: [] }).expect(200)).body.id).toBe(r.id);
    // pending qty counts: only 5 more returnable
    await request(app).post("/api/returns").set(as("r1")).send({ ...base, clientRef: "rt2", lines: [{ invoiceLineId: line.id, qty: 6 }] }).expect(409);
    id.ret = r.id;
  });
  it("distributor partly approves: GST credit note linked to the invoice, outstanding drops, damaged kept apart", async () => {
    const before = (await request(app).get("/api/retailer/account").set(as("ret")).expect(200)).body.credit.outstanding;
    const r = (await request(app).get("/api/returns").set(as("d")).expect(200)).body.find((x: any) => x.id === id.ret);
    await request(app).post(`/api/returns/${id.ret}/decision`).set(as("r1")).send({ decision: "approve" }).expect(403);
    await request(app).post(`/api/returns/${id.ret}/decision`).set(as("d")).send({ decision: "reject" }).expect(400); // reason needed
    await request(app).post(`/api/returns/${id.ret}/decision`).set(as("admB")).send({ decision: "approve" }).expect(404);
    const sale = r.lines.find((l: any) => l.condition === "saleable"), dam = r.lines.find((l: any) => l.condition === "damaged");
    const d = (await request(app).post(`/api/returns/${id.ret}/decision`).set(as("d")).send({ decision: "approve", lines: [{ id: sale.id, approvedQty: 2 }, { id: dam.id, approvedQty: 2 }] }).expect(200)).body;
    expect(d.status).toBe("partial"); expect(d.credit_note.number).toMatch(/CN/);
    const cn = (await request(app).get(`/api/invoices/${d.credit_note.id}`).set(as("adm")).expect(200)).body;
    expect(cn).toMatchObject({ kind: "credit_note", ref_invoice_id: inv.id });
    expect(cn.lines.reduce((a: number, l: any) => a + l.base_qty, 0)).toBe(4);
    expect(cn.total).toBeCloseTo(Math.round(inv.total * 4 / 10), 0);
    const after = (await request(app).get("/api/retailer/account").set(as("ret")).expect(200)).body;
    expect(after.credit.outstanding).toBeCloseTo(before - cn.total, 2);
    expect(after.returns[0]).toMatchObject({ id: id.ret, status: "partial", credit_note: cn.number });
    expect((await request(app).get("/api/returns/damaged").set(as("d")).expect(200)).body[0]).toMatchObject({ qty: 2 });
    await request(app).post(`/api/returns/${id.ret}/decision`).set(as("d")).send({ decision: "approve" }).expect(409);
    const rep = await request(app).get("/api/reports/returns?format=csv").set(as("adm")).expect(200);
    expect(rep.text).toContain(cn.number);
  });
  it("a return without an invoice: credit note on account, saleable stock back to the distributor", async () => {
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { stock: true } }).expect(200);
    const v = (await request(app).get("/api/products").set(as("adm"))).body.find((x: any) => x.sku === "STEE-2Y-RED");
    const r = (await request(app).post("/api/returns").set(as("r1")).send({ clientRef: "rt9", shopId: id.s1, reason: "Not selling", lines: [{ variantId: v.id, qty: 4, condition: "saleable" }] }).expect(201)).body;
    const before = (await request(app).get("/api/retailer/account").set(as("ret"))).body.credit.outstanding;
    const d = (await request(app).post(`/api/returns/${r.id}/decision`).set(as("d")).send({ decision: "approve" }).expect(200)).body;
    expect(d.status).toBe("approved");
    const st = (await request(app).get("/api/stock").set(as("d")).expect(200)).body.find((x: any) => x.sku === "STEE-2Y-RED");
    expect(Number(st.qty)).toBe(4);
    const after = (await request(app).get("/api/retailer/account").set(as("ret"))).body.credit.outstanding;
    expect(after).toBeCloseTo(before - d.credit_note.total, 2);
    // reject path + manager team scope on the returns list
    const x = (await request(app).post("/api/returns").set(as("r3")).send({ clientRef: "rt10", shopId: id.s3, reason: "Other", lines: [{ variantId: v.id, qty: 1 }] }).expect(201)).body;
    expect((await request(app).get("/api/returns").set(as("m1"))).body.map((y: any) => y.id)).not.toContain(x.id);
    expect((await request(app).post(`/api/returns/${x.id}/decision`).set(as("adm")).send({ decision: "reject", note: "Sample: not ours" }).expect(200)).body.status).toBe("rejected");
  });
  it("retailer account: statement with running balance and date filter, ageing, credit, invoice print; only own outlet", async () => {
    await request(app).patch(`/api/shops/${id.s1}`).set(as("adm")).send({ creditLimit: 50000, creditDays: 30 }).expect(200);
    const a = (await request(app).get("/api/retailer/account").set(as("ret")).expect(200)).body;
    expect(a.shop.id).toBe(id.s1);
    expect(a.credit).toMatchObject({ limit: 50000, days: 30 }); expect(a.credit.available).toBeCloseTo(50000 - a.credit.outstanding, 2);
    expect(a.ageing["0-30"]).toBeGreaterThan(0);
    const L = a.statement.lines; expect(L.length).toBeGreaterThanOrEqual(3);
    let bal = a.statement.opening; for (const l of L) { bal = Math.round((bal + l.debit - l.credit) * 100) / 100; expect(l.balance).toBeCloseTo(bal, 2); }
    expect(a.statement.closing).toBeCloseTo(a.credit.outstanding, 2);
    const t = today(), future = `${Number(t.slice(0, 4)) + 1}${t.slice(4)}`;
    const f = (await request(app).get(`/api/retailer/account?from=${future}&to=${future}`).set(as("ret")).expect(200)).body;
    expect(f.statement.lines).toEqual([]); expect(f.statement.opening).toBeCloseTo(a.statement.closing, 2);
    await request(app).get(`/api/retailer/account?from=${t}&to=2000-01-01`).set(as("ret")).expect(400);
    const doc = a.documents.find((d: any) => d.kind === "invoice");
    const p = await request(app).get(`/api/retailer/invoices/${doc.id}/print`).set(as("ret")).expect(200);
    expect(p.text).toContain("TAX INVOICE");
    await request(app).get("/api/retailer/account").set(as("r1")).expect(403);
    const other = (await request(app).post("/api/orders").set(as("r3")).send({ clientRef: `ot${++n}`, shopId: id.s3, lines: [{ sku: "STEE-2Y-RED", qty: 1 }] })).body;
    if (other.id) {
      await request(app).post(`/api/orders/${other.id}/status`).set(as("adm")).send({ status: "accepted" });
      const oi = (await request(app).post(`/api/orders/${other.id}/invoice`).set(as("adm")).send({})).body;
      if (oi.id) await request(app).get(`/api/retailer/invoices/${oi.id}/print`).set(as("ret")).expect(404);
    }
  });
});
