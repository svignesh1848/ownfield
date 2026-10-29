import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const on = (features: Record<string, boolean>) => request(app).put("/api/company/settings").set(as("adm")).send({ features }).expect(200);

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "FO", name: "FO (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("FO", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"], ["Dist", "d@x.com", "distributor", "pw"]]), "u.csv");
  T.rep = await login("FO", "r@x.com"); T.dist = await login("FO", "d@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false }, gst: { legalName: "FO Sample Co", gstin: "33AAAAA0000A1Z5", stateCode: "33" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s = shops[0].id; id.s2 = shops[1].id;
  const users = (await request(app).get("/api/users").set(as("adm"))).body; id.rep = users.find((u: any) => u.email === "r@x.com").id; id.dist = users.find((u: any) => u.email === "d@x.com").id;
  T.sku = (await request(app).get("/api/catalog").set(as("adm"))).body.items?.[0]?.variants?.[0]?.sku;
});

describe("van sales", () => {
  it("is off until the feature is on", async () => {
    await request(app).get("/api/van/today").set(as("rep")).expect(403);
    await on({ vanSales: true });
  });
  it("load, sell with invoice, and reconcile at day end", async () => {
    const sku = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1")).rows[0].sku; T.sku = sku;
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v0", shopId: id.s, lines: [{ sku, qty: 1 }] }).expect(409);
    const L = (await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, lines: [{ sku, qty: 20 }] }).expect(201)).body;
    expect(L.lines[0]).toMatchObject({ sku, loaded: 20, left: 20 });
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 25 }] }).expect(409);
    const s = (await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 6 }] }).expect(201)).body;
    expect(s.order.status).toBe("fulfilled"); expect(s.invoice.number).toBeTruthy(); expect(s.van.lines[0].left).toBe(14);
    expect((await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "v1", shopId: id.s, lines: [{ sku, qty: 6 }] }).expect(200)).body.duplicate).toBe(true);
    const c = (await request(app).post("/api/van/close").set(as("rep")).send({ counts: [{ sku, qty: 13 }] }).expect(200)).body;
    expect(c.status).toBe("closed"); expect(c.lines[0]).toMatchObject({ expected: 14, counted: 13, variance: -1 }); expect(c.sales_total).toBeGreaterThan(0);
    expect((await request(app).get("/api/van/loads").set(as("adm")).expect(200)).body.length).toBe(1);
  });
});

describe("distributor inventory", () => {
  it("goods in/out per distributor with batch and age, moves ledger, auto-moves on order acceptance", async () => {
    await request(app).get("/api/inventory").set(as("dist")).expect(403);
    await on({ distInventory: true, stock: true });
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "in", lines: [{ sku: T.sku, qty: 30, batch_no: "B1" }] }).expect(201);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "out", lines: [{ sku: T.sku, qty: 99, batch_no: "B1" }] }).expect(409);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "out", lines: [{ sku: T.sku, qty: 4, batch_no: "B1" }], note: "Sample damage" }).expect(201);
    const inv = (await request(app).get("/api/inventory").set(as("dist")).expect(200)).body;
    expect(inv.rows[0]).toMatchObject({ sku: T.sku, batch_no: "B1", qty: 26, age_band: "0-30 days" });
    // an order from a shop served by this distributor deducts stock on acceptance and logs a sale move
    await await request(app).post(`/api/shops/${id.s2}/distributor`).set(as("adm")).send({ distributorId: id.dist }).expect(200);
    const o = (await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "inv1", shopId: id.s2, lines: [{ sku: T.sku, qty: 5 }] }).expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(as("dist")).send({ status: "accepted" }).expect(200);
    const moves = (await request(app).get("/api/inventory/moves").set(as("dist")).expect(200)).body;
    expect(moves.map((m: any) => [m.kind, m.qty])).toEqual([["sale", -5], ["out", -4], ["in", 30]]);
    expect((await request(app).get(`/api/inventory?distributorId=${id.dist}`).set(as("adm")).expect(200)).body.rows[0].qty).toBe(21);
  });
});

describe("claims", () => {
  it("submit, approve a lower amount, settle as claim credit note and take damaged stock out", async () => {
    await request(app).post("/api/claims").set(as("dist")).send({ kind: "damage", description: "x", amount: 10 }).expect(403);
    await on({ claims: true });
    await request(app).post("/api/claims").set(as("dist")).send({ kind: "nope", description: "x", amount: 10 }).expect(400);
    const c = (await request(app).post("/api/claims").set(as("dist")).send({ kind: "damage", description: "Sample: damaged in transit", lines: [{ sku: T.sku, qty: 2, batch_no: "B1" }] }).expect(201)).body;
    expect(c.amount).toBeGreaterThan(0); expect(c.status).toBe("submitted");
    await request(app).post(`/api/claims/${c.id}/settle`).set(as("adm")).expect(409);
    await request(app).post(`/api/claims/${c.id}/decide`).set(as("adm")).send({ approve: true, amount: c.amount * 2 }).expect(400);
    const a = (await request(app).post(`/api/claims/${c.id}/decide`).set(as("adm")).send({ approve: true, amount: 1 }).expect(200)).body;
    expect(a).toMatchObject({ status: "approved", approved_amount: 1 });
    const st = (await request(app).post(`/api/claims/${c.id}/settle`).set(as("adm")).expect(200)).body;
    expect(st.credit_note_no).toMatch(/^CCN\//);
    expect((await request(app).get(`/api/claims/${c.id}/print`).set(as("dist")).expect(200)).text).toContain("CLAIM CREDIT NOTE");
    expect((await request(app).get(`/api/inventory?distributorId=${id.dist}`).set(as("adm"))).body.rows[0].qty).toBe(19);
    const r = (await request(app).post("/api/claims").set(as("dist")).send({ kind: "scheme", description: "Sample scheme payout", amount: 50 }).expect(201)).body;
    await request(app).post(`/api/claims/${r.id}/decide`).set(as("adm")).send({ approve: false }).expect(400);
    expect((await request(app).post(`/api/claims/${r.id}/decide`).set(as("adm")).send({ approve: false, reason: "Not eligible" }).expect(200)).body.status).toBe("rejected");
  });
});

describe("barcodes", () => {
  it("barcode column on products, unique per company, scan lookup, usable in van loads and stock moves", async () => {
    const csvP = csv([["Item Code", "Item Name", "SKU", "MRP", "Billing Price", "Barcode"], ["SAMPLE-BC", "Sample barcode item", "SAMPLE-BC-1", 50, 40, "8900000000017"], ["SAMPLE-BC", "Sample barcode item", "SAMPLE-BC-2", 50, 40, "8900000000017"]]);
    const r = (await request(app).post("/api/import/products").set(as("adm")).attach("file", csvP, "p.csv").expect(200)).body;
    expect(r.inserted).toBe(1); expect(r.errors[0].error).toContain("already used");
    expect((await request(app).get("/api/products/scan/8900000000017").set(as("rep")).expect(200)).body.sku).toBe("SAMPLE-BC-1");
    await request(app).get("/api/products/scan/000").set(as("rep")).expect(404);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "in", lines: [{ sku: "8900000000017", qty: 3 }] }).expect(201);
    expect((await request(app).get("/api/inventory").set(as("dist"))).body.rows.find((x: any) => x.sku === "SAMPLE-BC-1").qty).toBe(3);
  });
});

describe("leads", () => {
  it("capture, follow up, and convert into an outlet", async () => {
    await on({ leads: true });
    const l = (await request(app).post("/api/leads").set(as("rep")).send({ name: "Sample Prospect Store", kind: "outlet", city: "Salem", phone: "9000000099", next_follow_up: "2026-01-01" }).expect(201)).body;
    expect(l.assigned_to).toBe(id.rep);
    expect((await request(app).get("/api/leads?due=1").set(as("rep")).expect(200)).body.length).toBe(1);
    await request(app).post(`/api/leads/${l.id}/followups`).set(as("rep")).send({ note: "Sample: met owner, wants price list", next_date: "2099-01-01" }).expect(201);
    expect((await request(app).get("/api/leads").set(as("adm"))).body[0].status).toBe("contacted");
    await request(app).patch(`/api/leads/${l.id}`).set(as("rep")).send({ status: "converted" }).expect(400);
    const c = (await request(app).post(`/api/leads/${l.id}/convert`).set(as("rep")).send({}).expect(201)).body;
    expect(c.shop.code).toBe(`LEAD-${l.id}`);
    expect((await request(app).get("/api/shops").set(as("adm"))).body.some((s: any) => s.code === `LEAD-${l.id}`)).toBe(true);
    await request(app).post(`/api/leads/${l.id}/convert`).set(as("rep")).send({}).expect(409);
  });
});

describe("location trail and geofence", () => {
  it("keeps useful pings in working hours, sums distance, and enforces the check-in radius", async () => {
    await on({ tracking: true, gps: true });
    await request(app).put("/api/track/settings").set(as("adm")).send({ start: "00:00", end: "23:59", radiusM: 100 }).expect(200);
    const t0 = Date.now() - 600_000, at = (m: number) => new Date(t0 + m * 60_000).toISOString();
    const r = (await request(app).post("/api/track/pings").set(as("rep")).send({ points: [
      { at: at(0), lat: 13.0827, lng: 80.2707, acc: 10 }, { at: at(1), lat: 13.08271, lng: 80.27071, acc: 10 }, // < 25 m: dropped
      { at: at(2), lat: 13.0917, lng: 80.2707, acc: 10 }, { at: at(3), lat: 13.2, lng: 80.3, acc: 900 }] }).expect(200)).body; // poor accuracy: dropped
    expect(r).toMatchObject({ received: 4, kept: 2 });
    const tr = (await request(app).get(`/api/track?repId=${id.rep}`).set(as("adm")).expect(200)).body;
    expect(tr.points.length).toBe(2); expect(tr.distance_km).toBeGreaterThan(0.9); expect(tr.distance_km).toBeLessThan(1.1);
    // first check-in pins the outlet; a later one far away is refused
    const v = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s2, lat: 13.0827, lng: 80.2707 }).expect(201)).body;
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Shop closed", lat: 13.0827, lng: 80.2707 }).expect(200);
    const far = await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s2, lat: 13.0927, lng: 80.2707 }).expect(409);
    expect(far.body.error).toContain("Check in within 100 m");
    await request(app).put(`/api/shops/${id.s2}/geofence`).set(as("adm")).send({ lat: 13.0827, lng: 80.2707, radiusM: 2000 }).expect(200);
    const ok = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s2, lat: 13.0927, lng: 80.2707 }).expect(201)).body;
    await request(app).post(`/api/visits/${ok.id}/checkout`).set(as("rep")).send({ noOrderReason: "Shop closed", lat: 13.0927, lng: 80.2707 }).expect(200);
  });
});

describe("coverage report", () => {
  it("planned vs total vs productive calls, beat adherence and missed outlets", async () => {
    await on({ coverage: true });
    const shops = (await request(app).get("/api/shops").set(as("adm"))).body.filter((x: any) => !String(x.code).startsWith("LEAD-")).slice(0, 3);
    const bt = await request(app).post("/api/beats").set(as("adm")).send({ name: "Sample daily beat", repId: id.rep, shopIds: shops.map((x: any) => x.id) }); expect(bt.body.error ?? "").toBe(""); expect(bt.status).toBe(201);
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const r = (await request(app).get(`/api/coverage?from=${day}&to=${day}&repId=${id.rep}`).set(as("adm")).expect(200)).body.reps[0];
    const sunday = new Date(day + "T00:00:00Z").getUTCDay() === 0;
    expect(r.planned_calls).toBe(sunday ? 0 : 3);
    expect(r.total_calls).toBeGreaterThanOrEqual(1);       // the geofence test visited one outlet today
    expect(r.non_productive_calls).toBeGreaterThanOrEqual(1);  // those visits ended with a no-order reason (orders earlier in the day don't count)
    if (!sunday) { expect(r.missed_outlets.length).toBe(3 - (r.total_calls - r.unplanned_calls)); expect(r.beat_adherence_pct).toBeLessThan(100); }
    await request(app).get("/api/coverage?from=2026-01-01&to=2026-03-01").set(as("adm")).expect(400);
  });
});

describe("offline sync", () => {
  it("accepts a whole visit captured offline and dedupes retries of visits and payments by clientRef", async () => {
    const tin = new Date(Date.now() - 3600_000).toISOString(), tout = new Date(Date.now() - 3000_000).toISOString();
    const v = (await request(app).post("/api/visits/offline").set(as("rep")).send({ clientRef: "off-v1", shopId: id.s, checkInAt: tin, checkOutAt: tout }).expect(201)).body;
    expect(v.check_out_at).toBeTruthy();
    expect((await request(app).post("/api/visits/offline").set(as("rep")).send({ clientRef: "off-v1", shopId: id.s, checkInAt: tin, checkOutAt: tout }).expect(200)).body.duplicate).toBe(true);
    await request(app).post("/api/visits/offline").set(as("rep")).send({ clientRef: "off-v2", shopId: id.s, checkInAt: "2020-01-01T00:00:00Z" }).expect(400);
    await on({ invoicing: true });
    const p1 = await request(app).post("/api/payments").set(as("rep")).send({ clientRef: "off-p1", shopId: id.s, amount: 10, mode: "cash" });
    if (p1.status === 201) {
      const p2 = (await request(app).post("/api/payments").set(as("rep")).send({ clientRef: "off-p1", shopId: id.s, amount: 10, mode: "cash" }).expect(200)).body;
      expect(p2.duplicate).toBe(true); expect(p2.id).toBe(p1.body.id);
    } else expect(p1.status).toBe(400); // nothing outstanding to collect against is also fine
  });
});

describe("surveys", () => {
  it("is off until enabled, builds a form, validates answers, dedupes offline retries and reports competitor prices", async () => {
    await request(app).get("/api/surveys/forms").set(as("rep")).expect(403);
    await on({ surveys: true });
    await request(app).post("/api/surveys/forms").set(as("rep")).send({ name: "x", questions: [{ label: "a" }] }).expect(403);
    await request(app).post("/api/surveys/forms").set(as("adm")).send({ name: "x", questions: [{ label: "c", type: "select" }] }).expect(400);
    const f = (await request(app).post("/api/surveys/forms").set(as("adm")).send({ name: "Sample price check", questions: [
      { label: "Rival 1L price", type: "price", brand: "Sample Rival", required: true }, { label: "Shelf", type: "select", options: "eye level,bottom" }, { label: "Promo running", type: "yesno" }] }).expect(201)).body;
    expect(f.questions.map((q: any) => q.key)).toEqual(["rival_1l_price", "shelf", "promo_running"]);
    await request(app).post("/api/surveys/responses").set(as("rep")).send({ formId: f.id, answers: { shelf: "eye level" } }).expect(400);
    await request(app).post("/api/surveys/responses").set(as("rep")).send({ formId: f.id, answers: { rival_1l_price: 50, shelf: "top" } }).expect(400);
    const r = await request(app).post("/api/surveys/responses").set(as("rep")).send({ formId: f.id, shopId: id.s, clientRef: "sv1", answers: { rival_1l_price: "52.5", shelf: "eye level", promo_running: "yes" } }).expect(201);
    expect(r.body.answers).toEqual({ rival_1l_price: 52.5, shelf: "eye level", promo_running: true });
    expect((await request(app).post("/api/surveys/responses").set(as("rep")).send({ formId: f.id, clientRef: "sv1", answers: { rival_1l_price: 1 } }).expect(200)).body.duplicate).toBe(true);
    await request(app).post("/api/surveys/responses").set(as("rep")).send({ formId: f.id, shopId: id.s, answers: { rival_1l_price: 47.5 } }).expect(201);
    const rep = (await request(app).get("/api/surveys/competitor-prices").set(as("adm")).expect(200)).body;
    expect(rep[0]).toMatchObject({ brand: "Sample Rival", reports: 2, outlets: 1, min: 47.5, max: 52.5, avg: 50 });
    await request(app).get("/api/surveys/competitor-prices").set(as("rep")).expect(403);
    expect((await request(app).get("/api/surveys/responses").set(as("rep")).expect(200)).body).toHaveLength(2);
  });
});

describe("messaging", () => {
  it("is mock by default (logged, never sent), sends only through an admin-configured provider, and masks its key", async () => {
    const { drainMessages } = await import("../src/messaging.js");
    await request(app).get("/api/messages/log").set(as("adm")).expect(403);
    await on({ messaging: true });
    await db.query("UPDATE shops SET phone='9876500001' WHERE id=$1", [id.s]);
    const calls: any[] = []; const fakeFetch: any = async (u: string, o: any) => { calls.push({ u, o }); return { ok: true, status: 200 }; };
    await request(app).post("/api/payments").set(as("rep")).send({ shopId: id.s, amount: 5, mode: "cash", clientRef: "msg-p1" });
    await request(app).post("/api/messages/reminders").set(as("adm")).send({}).expect(201);
    await drainMessages(db, { fetchImpl: fakeFetch });
    let log = (await request(app).get("/api/messages/log").set(as("adm")).expect(200)).body;
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((m: any) => ["mock", "skipped"].includes(m.status))).toBe(true);
    expect(log.find((m: any) => m.status === "mock").to_phone).toBe("919876500001");
    expect(calls).toHaveLength(0); // nothing leaves the server in mock mode
    await request(app).put("/api/messages/settings").set(as("adm")).send({ provider: "http", http: { url: "http://10.0.0.1/send" } }).expect(400);
    const prev = process.env.WEBHOOK_ALLOW_PRIVATE; process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    try {
      const st = (await request(app).put("/api/messages/settings").set(as("adm")).send({ provider: "http", http: { url: "https://sms.example.com/send", authValue: "sk_sample" } }).expect(200)).body;
      expect(st.http.authValue).toBe("******");
      await request(app).post("/api/messages/test").set(as("adm")).send({ to: "98765 00002" }).expect(201);
      await drainMessages(db, { fetchImpl: fakeFetch });
      expect(calls).toHaveLength(1); expect(calls[0].o.headers.Authorization).toBe("sk_sample");
      expect(JSON.parse(calls[0].o.body)).toMatchObject({ to: "919876500002", channel: "whatsapp" });
    } finally { if (prev == null) delete process.env.WEBHOOK_ALLOW_PRIVATE; else process.env.WEBHOOK_ALLOW_PRIVATE = prev; await request(app).put("/api/messages/settings").set(as("adm")).send({ provider: "mock" }).expect(200); }
    await request(app).get("/api/messages/settings").set(as("rep")).expect(403);
  });
});
