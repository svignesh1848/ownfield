import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { today } from "../src/catalog.js";
import { fyOf } from "../src/billing.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const id: Record<string, number> = {}; const inv: Record<string, any> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const ago = (n: number) => new Date(Date.parse(today()) - n * 864e5).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
let n = 0;
const order = (extra = {}) => request(app).post("/api/orders").set(as("rep")).send({ clientRef: `c${++n}`, shopId: id.s, lines: [{ sku: "STEE-2Y-RED", qty: 10 }], ...extra });
async function invoiced(daysAgo: number) {
  const o = (await order().expect(201)).body;
  await request(app).post(`/api/orders/${o.id}/status`).set(as("adm")).send({ status: "accepted" }).expect(200);
  return (await request(app).post(`/api/orders/${o.id}/invoice`).set(as("adm")).send({ date: ago(daysAgo) }).expect(201)).body;
}
const out = async () => (await request(app).get(`/api/outstanding?shopId=${id.s}`).set(as("rep")).expect(200)).body[0];
const fy = fyOf(today());

beforeAll(async () => {
  const db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "CL", name: "CL (sample)", industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("CL", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"]]), "u.csv");
  T.rep = await login("CL", "r@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false }, gst: { legalName: "CL Sample Co", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
  id.s = (await request(app).get("/api/shops").set(as("adm"))).body[2].id;
  inv.A = await invoiced(100); inv.B = await invoiced(45); inv.C = await invoiced(0);
});

describe("collections", () => {
  it("outstanding = invoices − credit notes − payments", async () => {
    let r = await out();
    expect(r).toMatchObject({ issuer: "company", issuer_name: "CL Sample Co", outstanding: r2(inv.A.total + inv.B.total + inv.C.total) });
    const cn = (await request(app).post(`/api/invoices/${inv.B.id}/credit-note`).set(as("adm")).send({ reason: "Sample return", lines: [{ invoiceLineId: inv.B.lines[0].id, qty: 2 }] }).expect(201)).body;
    r = await out();
    expect(r.credited).toBe(cn.total); expect(r.outstanding).toBe(r2(inv.A.total + inv.B.total + inv.C.total - cn.total)); inv.cn = cn;
  });
  it("validates payments and allocates FIFO", async () => {
    await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: 100, mode: "upi" }).expect(400);
    await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: 100, mode: "barter" }).expect(400);
    await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: 100, mode: "cash", allocations: [{ invoiceId: inv.C.id, amount: 1e6 }] }).expect(400);
    const p = (await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: r2(inv.A.total + 100), mode: "cash" }).expect(201)).body;
    expect(p.number).toBe(`RCPT/${fy}/0001`);
    expect(p.allocations.map((a: any) => [a.invoice_id, a.amount])).toEqual([[inv.A.id, inv.A.total], [inv.B.id, 100]]);
    const r = await out();
    expect(r.invoices.map((i: any) => i.id)).toEqual([inv.B.id, inv.C.id]);
    expect(r.invoices[0].outstanding).toBe(r2(inv.B.total - inv.cn.total - 100));
    expect((await request(app).get(`/api/payments/${p.id}/print`).set(as("rep"))).text).toMatch(/PAYMENT RECEIPT[\s\S]*RCPT\//);
    inv.cash = p;
  });
  it("chosen-invoice cheque, bounce reversal re-opens the invoice", async () => {
    const before = await out();
    const p = (await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: 600, mode: "cheque", reference: "000123", allocations: [{ invoiceId: inv.C.id, amount: 500 }] }).expect(201)).body;
    expect(p).toMatchObject({ number: `RCPT/${fy}/0002`, unallocated: 100 });
    expect((await out()).outstanding).toBe(r2(before.outstanding - 600));
    await request(app).post(`/api/payments/${inv.cash.id}/bounce`).set(as("adm")).send({ reason: "x" }).expect(409);
    await request(app).post(`/api/payments/${p.id}/bounce`).set(as("rep")).send({ reason: "x" }).expect(403);
    await request(app).post(`/api/payments/${p.id}/bounce`).set(as("adm")).send({}).expect(400);
    const b = (await request(app).post(`/api/payments/${p.id}/bounce`).set(as("adm")).send({ reason: "Insufficient funds" }).expect(200)).body;
    expect(b.status).toBe("bounced");
    await request(app).post(`/api/payments/${p.id}/bounce`).set(as("adm")).send({ reason: "again" }).expect(409);
    expect((await out()).outstanding).toBe(before.outstanding);
    expect((await request(app).get(`/api/payments/${p.id}/print`).set(as("adm"))).text).toContain("CHEQUE BOUNCED");
  });
  it("ageing buckets with export", async () => {
    const rows = (await request(app).get("/api/reports/ageing?format=csv").set(as("adm")).expect(200)).text.split("\n");
    expect(rows[0]).toBe("outlet_code,outlet,billed_by,0-30,31-60,61-90,90+,total");
    const r = await out();
    expect(rows[1]).toContain(`,${r.invoices[1].outstanding},${r.invoices[0].outstanding},0,0,${r2(r.invoices[0].outstanding + r.invoices[1].outstanding)}`);
  });
  it("credit days / limit warn or block new orders; outlet terms override company", async () => {
    await request(app).put("/api/company/settings").set(as("adm")).send({ credit: { days: 30, limit: 0, onBreach: "block" } }).expect(200);
    expect((await order().expect(409)).body.error).toMatch(/credit hold: .*overdue beyond 30 credit days/);
    await request(app).put("/api/company/settings").set(as("adm")).send({ credit: { days: 30, limit: 0, onBreach: "warn" } }).expect(200);
    expect((await order().expect(201)).body.creditWarning[0]).toMatch(/overdue/);
    await request(app).patch(`/api/shops/${id.s}`).set(as("adm")).send({ creditDays: 60, creditLimit: 1000 }).expect(200);
    expect((await order().expect(201)).body.creditWarning).toEqual([expect.stringMatching(/exceeds credit limit ₹1,000.00/)]);
    await request(app).patch(`/api/shops/${id.s}`).set(as("adm")).send({ creditLimit: 1e7 }).expect(200);
    expect((await order().expect(201)).body.creditWarning).toBeUndefined();
    const cc = (await request(app).get(`/api/credit-check?shopId=${id.s}&amount=1`).set(as("rep"))).body;
    expect(cc).toMatchObject({ ok: true, terms: { days: 60, limit: 1e7 } });
  });
});
