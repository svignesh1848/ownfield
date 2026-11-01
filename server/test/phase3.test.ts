import { perfectScore } from "../src/audits.js";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import os from "node:os";
import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { SAMPLE_PNG } from "../src/photos.js";
import { seedDemo } from "../src/seed.js";

process.env.UPLOAD_DIR = path.join(os.tmpdir(), `ff-p3-${Date.now()}`);
let app: any, db: any; const T: Record<string, string> = {}; const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const features = (t: string, f: Record<string, boolean>) => request(app).put("/api/company/settings").set(H(t)).send({ features: f });

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const code of ["ACME", "DEMO"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code, name: code, userLimit: 20, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.a = await login("ACME", "a@x.com"); T.demo = await login("DEMO", "a@x.com");
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"],
    ["Rep One", "r1@x.com", "sales_rep", "pw"], ["Rep Two", "r2@x.com", "sales_rep", "pw"], ["Mgr", "m@x.com", "manager", "pw"], ["Dist One", "d1@x.com", "distributor", "pw"]]), "u.csv");
  await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email"], ["S1", "Sample Shop 1", "d1@x.com"]]), "s.csv");
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-2Y", "2Y", "400", "300"]]), "p.csv");
  for (const k of ["r1", "r2", "m", "d1"]) T[k] = await login("ACME", `${k}@x.com`);
  ids.s1 = (await request(app).get("/api/shops").set(H("a"))).body[0].id;
  const reps = (await request(app).get("/api/reps").set(H("a"))).body; ids.r1 = reps.find((r: any) => r.email === "r1@x.com").id;
  await features("a", { gps: false });
  ids.v1 = (await request(app).post("/api/visits/checkin").set(H("r1")).send({ shopId: ids.s1 })).body.id;
});

describe("store audits", () => {
  it("is off until the admin turns it on", async () => {
    await request(app).get("/api/audit-templates").set(H("r1")).expect(403);
    await features("a", { audits: true }).expect(200);
  });
  it("admin builds a checklist; rep answers it during a visit with a shelf photo; manager sees the report", async () => {
    await request(app).post("/api/audit-templates").set(H("r1")).send({ name: "x", questions: [{ label: "a" }] }).expect(403);
    await request(app).post("/api/audit-templates").set(H("a")).send({ name: "Bad", questions: [{ label: "a", type: "colour" }] }).expect(400);
    const t = (await request(app).post("/api/audit-templates").set(H("a")).send({ name: "Shelf check", questions: [
      { label: "Shelf clean?", type: "yes_no", required: true }, { label: "Facings", type: "number" }, { label: "Notes", type: "text" }, { label: "Shelf photo", type: "photo" }] }).expect(201)).body;
    expect(t.questions.map((q: any) => q.key)).toEqual(["shelf_clean", "facings", "notes", "shelf_photo"]);
    await request(app).post(`/api/visits/${ids.v1}/audits`).set(H("r1")).send({ templateId: t.id, answers: {} }).expect(400);
    await request(app).post(`/api/visits/${ids.v1}/audits`).set(H("r2")).send({ templateId: t.id, answers: { shelf_clean: "yes" } }).expect(404);
    const a = (await request(app).post(`/api/visits/${ids.v1}/audits`).set(H("r1")).send({ templateId: t.id, answers: { shelf_clean: "yes", facings: "6", notes: "ok" } }).expect(201)).body;
    expect(a.answers).toEqual({ shelf_clean: true, facings: 6, notes: "ok" });
    await request(app).post(`/api/audits/${a.id}/photos`).set(H("r1")).field("question", "shelf_photo").attach("photo", Buffer.from("not an image"), "x.jpg").expect(400);
    const p = (await request(app).post(`/api/audits/${a.id}/photos`).set(H("r1")).field("question", "shelf_photo").attach("photo", SAMPLE_PNG, "s.png").expect(201)).body;
    await request(app).post(`/api/audits/${a.id}/photos`).set(H("r1")).attach("photo", Buffer.alloc(2 * 1024 * 1024, 0xff), "big.jpg").expect(413);
    const r = (await request(app).get("/api/audits").set(H("m")).expect(200)).body.rows;
    expect(r[0]).toMatchObject({ rep_name: "Rep One", shop_name: "Sample Shop 1", checklist: "Shelf check", score: "1/1 yes" });
    expect(r[0].photos).toHaveLength(1);
    expect((await request(app).get(`/api/audit-photos/${p.id}`).set(H("m")).expect(200)).headers["content-type"]).toMatch(/png/);
    expect((await request(app).get("/api/audits").set(H("r2"))).body.rows).toHaveLength(0);
  });
  it("perfect store: targets on number questions roll up into an outlet score", async () => {
    expect(perfectScore([{ key: "a", label: "a", type: "yes_no" }, { key: "f", label: "f", type: "number", target: 10, weight: 2 }], { a: true, f: 5 })).toBe(67);
    await request(app).post("/api/audit-templates").set(H("a")).send({ name: "Bad", questions: [{ label: "x", type: "yes_no", target: 3 }] }).expect(400);
    const t = (await request(app).post("/api/audit-templates").set(H("a")).send({ name: "Perfect store", questions: [
      { label: "Poster up?", type: "yes_no" }, { label: "Facings count", type: "number", target: 10 }] }).expect(201)).body;
    expect(t.questions[1].target).toBe(10);
    await request(app).post(`/api/visits/${ids.v1}/audits`).set(H("r1")).send({ templateId: t.id, answers: { poster_up: "yes", facings_count: 5 } }).expect(201);
    const d = (await request(app).get("/api/audits").set(H("m")).expect(200)).body;
    expect(d.rows.find((r: any) => r.checklist === "Perfect store").perfect_score).toBe(75);
    expect(d.outlets[0]).toMatchObject({ shop_name: "Sample Shop 1", outlet_score: 88 }); // (100 + 75) / 2, both checklists that day
  });
});

describe("expenses", () => {
  it("rep claims with receipt; manager approves/rejects; monthly report", async () => {
    await request(app).post("/api/expenses").set(H("r1")).field("amount", "100").field("category", "Travel").attach("receipt", SAMPLE_PNG, "r.png").expect(403);
    await features("a", { expenses: true }).expect(200);
    await request(app).post("/api/expenses").set(H("r1")).field("amount", "100").field("category", "Travel").expect(400);
    await request(app).post("/api/expenses").set(H("r1")).field("amount", "0").field("category", "Travel").attach("receipt", SAMPLE_PNG, "r.png").expect(400);
    await request(app).post("/api/expenses").set(H("r1")).field("amount", "10").field("category", "Party").attach("receipt", SAMPLE_PNG, "r.png").expect(400);
    const e1 = (await request(app).post("/api/expenses").set(H("r1")).field("amount", "240.5").field("category", "travel").field("note", "bus").attach("receipt", SAMPLE_PNG, "r.png").expect(201)).body;
    const e2 = (await request(app).post("/api/expenses").set(H("r1")).field("amount", "99").field("category", "Food").attach("receipt", SAMPLE_PNG, "r.png").expect(201)).body;
    expect(e1).toMatchObject({ category: "Travel", status: "pending" });
    await request(app).post(`/api/expenses/${e1.id}/decision`).set(H("r1")).send({ status: "approved" }).expect(403);
    await request(app).post(`/api/expenses/${e2.id}/decision`).set(H("m")).send({ status: "rejected" }).expect(400);
    await request(app).post(`/api/expenses/${e1.id}/decision`).set(H("m")).send({ status: "approved" }).expect(200);
    await request(app).post(`/api/expenses/${e2.id}/decision`).set(H("m")).send({ status: "rejected", reason: "No bill" }).expect(200);
    await request(app).post(`/api/expenses/${e1.id}/decision`).set(H("m")).send({ status: "rejected", reason: "x" }).expect(404);
    expect((await request(app).get(`/api/expenses/${e1.id}/receipt`).set(H("r2"))).status).toBe(404);
    await request(app).get(`/api/expenses/${e1.id}/receipt`).set(H("m")).expect(200);
    const r = (await request(app).get("/api/expenses/report").set(H("m")).expect(200)).body;
    expect(r.reps).toEqual([{ repId: ids.r1, rep: "Rep One", approved: 240.5, pending: 0, rejected: 99, byCategory: { Travel: 240.5 } }]);
    expect((await request(app).get("/api/expenses").set(H("r2"))).body).toHaveLength(0);
  });
});

describe("leave & attendance", () => {
  it("rep applies, manager approves, beat shows on-leave and check-in is blocked; attendance counts days", async () => {
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    await request(app).post("/api/leaves").set(H("r1")).send({ from: d }).expect(403);
    await features("a", { leave: true }).expect(200);
    await request(app).post(`/api/visits/${ids.v1}/checkout`).set(H("r1")).send({ noOrderReason: "Shop closed" }).expect(200);
    await request(app).post("/api/beats").set(H("a")).send({ name: "Sample beat", repId: ids.r1, shopIds: [ids.s1] }).expect(201);
    await request(app).post("/api/leaves").set(H("r1")).send({ from: "2026-05-10", to: "2026-05-09" }).expect(400);
    const l = (await request(app).post("/api/leaves").set(H("r1")).send({ from: d, to: d, kind: "sick", reason: "Fever" }).expect(201)).body;
    await request(app).post("/api/leaves").set(H("r1")).send({ from: d }).expect(409);
    await request(app).post(`/api/leaves/${l.id}/decision`).set(H("r1")).send({ status: "approved" }).expect(403);
    expect((await request(app).get("/api/beats").set(H("r1"))).body[0].onLeaveToday).toBeUndefined();
    await request(app).post(`/api/leaves/${l.id}/decision`).set(H("m")).send({ status: "approved" }).expect(200);
    expect((await request(app).get("/api/beats").set(H("r1"))).body[0].onLeaveToday).toBe(true);
    await request(app).post("/api/visits/checkin").set(H("r1")).send({ shopId: ids.s1 }).expect(409);
    const a = (await request(app).get(`/api/attendance?month=${d.slice(0, 7)}`).set(H("m")).expect(200)).body.reps;
    expect(a.find((r: any) => r.rep === "Rep One")).toMatchObject({ present: 1, leave: 1, leaveDays: [d] });
    expect((await request(app).get("/api/leaves").set(H("r2"))).body).toHaveLength(0);
  });
});

describe("incentives", () => {
  it("admin sets % slabs on a target; rep sees the highest slab earned", async () => {
    await request(app).get("/api/incentives").set(H("r1")).expect(403);
    await features("a", { incentives: true }).expect(200);
    const month = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
    await request(app).put("/api/targets").set(H("a")).send({ repId: ids.r1, month, metric: "visits", target: 1 }).expect(200);
    await request(app).post("/api/incentive-rules").set(H("m")).send({ name: "x", metric: "visits", slabs: [{ minPct: 50, amount: 1 }] }).expect(403);
    await request(app).post("/api/incentive-rules").set(H("a")).send({ name: "Bad", metric: "visits", slabs: [{ minPct: 0, amount: 1 }] }).expect(400);
    const r = (await request(app).post("/api/incentive-rules").set(H("a")).send({ name: "Visit bonus", metric: "visits", slabs: [{ minPct: 150, amount: 900 }, { minPct: 80, amount: 300 }, { minPct: 100, amount: 500 }] }).expect(201)).body;
    expect(r.slabs.map((x: any) => x.minPct)).toEqual([80, 100, 150]);
    const mine = (await request(app).get("/api/incentives").set(H("r1")).expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ rep: "Rep One", total: 500, lines: [{ rule: "Visit bonus", pct: 100, earned: 500, next: { minPct: 150, amount: 900 } }] });
    const all = (await request(app).get("/api/incentives").set(H("m"))).body;
    expect(all.find((x: any) => x.rep === "Rep Two").total).toBe(0);
    await request(app).post(`/api/incentive-rules/${r.id}/active`).set(H("a")).send({ active: false }).expect(200);
    expect((await request(app).get("/api/incentives").set(H("r1"))).body[0].total).toBe(0);
  });
});

describe("retailer app", () => {
  it("retailer login linked to an outlet: catalog, orders to its distributor, own history only", async () => {
    await request(app).post("/api/users").set(H("a")).send({ email: "shop@x.com", name: "Shop Owner", password: "pw", role: "retailer" }).expect(400);
    await request(app).post("/api/users").set(H("a")).send({ email: "shop@x.com", name: "Shop Owner", password: "pw", role: "retailer", shopId: ids.s1 }).expect(201);
    expect((await request(app).post("/api/auth/login").send({ companyCode: "ACME", email: "shop@x.com", password: "pw" })).status).toBe(403);
    await features("a", { retailerApp: true }).expect(200);
    T.shop = await login("ACME", "shop@x.com");
    expect((await request(app).get("/api/retailer/me").set(H("shop")).expect(200)).body).toMatchObject({ name: "Sample Shop 1", distributor_name: "Dist One" });
    expect((await request(app).get("/api/items").set(H("shop")).expect(200)).body.length).toBeGreaterThan(0);
    expect((await request(app).get("/api/shops").set(H("shop"))).body.map((x: any) => x.id)).toEqual([ids.s1]);
    const o = (await request(app).post("/api/orders").set(H("shop")).send({ clientRef: "ret-1", shopId: 999, lines: [{ sku: "T-2Y", qty: 2 }] }).expect(201)).body;
    expect(o.shop_id).toBe(ids.s1); expect(Number(o.total)).toBe(600);
    const inbox = (await request(app).get("/api/orders").set(H("d1"))).body;
    expect(inbox.find((x: any) => x.client_ref === "ret-1")).toMatchObject({ placed_by_role: "retailer", rep_name: "Shop Owner" });
    expect((await request(app).get("/api/orders").set(H("shop"))).body.map((x: any) => x.client_ref)).toEqual(["ret-1"]);
    await request(app).get("/api/dashboard").set(H("shop")).expect(403);
    await request(app).get("/api/expenses").set(H("shop")).expect(403);
    expect((await request(app).get("/api/dashboard").set(H("m"))).body.every((r: any) => r.rep !== "Shop Owner")).toBe(true);
  });
});

describe("DEMO sample data", () => {
  it("seeds labelled sample data idempotently", async () => {
    await request(app).post("/api/company/sample-data").set(H("demo")).expect(200);
    await request(app).post("/api/users").set(H("demo")).send({ email: "rep@example.com", name: "Sample Rep", role: "sales_rep", password: "Passw0rd!" });
    await seedDemo(db); await seedDemo(db);
    const t = (await request(app).get("/api/audit-templates").set(H("demo")).expect(200)).body;
    expect(t).toHaveLength(1); expect(t[0].name).toMatch(/sample/);
    const st = (await request(app).get("/api/company/settings").set(H("demo"))).body.settings.features;
    expect([st.audits, st.expenses, st.leave, st.incentives, st.retailerApp]).toEqual([true, true, true, true, true]);
    expect((await request(app).get("/api/incentive-rules").set(H("demo"))).body[0].name).toMatch(/sample/);
    expect([st.vanSales, st.claims, st.leads, st.tracking, st.surveys, st.messaging]).toEqual([true, true, true, true, true, true]);
    const sv = (await request(app).get("/api/surveys/forms").set(H("demo")).expect(200)).body; expect(sv).toHaveLength(1); expect(sv[0].name).toMatch(/sample/);
    expect((await request(app).get("/api/leads").set(H("demo")).expect(200)).body.every((l: any) => /Sample/.test(l.name))).toBe(true);
    expect((await request(app).get("/api/messages/log").set(H("demo")).expect(200)).body.every((m: any) => m.status === "mock")).toBe(true);
    const hist = (await db.query("SELECT client_ref FROM orders WHERE client_ref LIKE 'sample-hist-%'")).rows.map((r: any) => r.client_ref);
    expect(hist.length).toBeGreaterThan(5); expect(new Set(hist).size).toBe(hist.length); // order history for the AI features, not duplicated
    const sum = (await request(app).get("/api/ai/summary").set(H("demo")).expect(200)).body; expect(sum.lines.length).toBeGreaterThan(2);
  });
});
