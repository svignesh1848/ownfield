import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { resolveRange, validateDef, runReport } from "../src/reports/engine.js";
import { SOURCES } from "../src/reports/sources.js";
import { TEMPLATES, templateDef } from "../src/reports/templates.js";
import { isDue, runDueReports } from "../src/reports/schedule.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
const order = (who: string, shopId: number, qty = 10) => request(app).post("/api/orders").set(as(who)).send({ clientRef: `r${++n}`, shopId, lines: [{ sku: "STEE-2Y-RED", qty }] }).expect(201);
const sales = { source: "orders", filters: { dateRange: { preset: "this_month" } }, groupBy: ["rep"], metrics: [{ fn: "sum", field: "value" }, { fn: "count" }], view: { type: "bar" } };

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const c of ["RA", "RB"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: c, name: c, industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("RA", "a@x.com"); T.bAdm = await login("RB", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep One", "r1@x.com", "sales_rep", "pw"], ["Rep Two", "r2@x.com", "sales_rep", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.r1 = await login("RA", "r1@x.com"); T.r2 = await login("RA", "r2@x.com"); T.mgr = await login("RA", "m@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s1 = shops[0].id; id.s2 = shops[1].id;
  await order("r1", id.s1); await order("r1", id.s2, 20); await order("r2", id.s1, 5);
});

describe("report engine", () => {
  it("resolves date presets (IST, inclusive)", () => {
    expect(resolveRange({ preset: "this_month" }, "2026-10-30")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
    expect(resolveRange({ preset: "last_month" }, "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveRange({ preset: "last_week" }, "2026-10-30")).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(resolveRange({ preset: "this_fy" }, "2026-02-10")).toEqual({ from: "2025-04-01", to: "2026-02-10" });
    expect(resolveRange({ preset: "last_quarter" }, "2026-01-05")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(() => resolveRange({ preset: "custom", from: "2026-02-01", to: "2026-01-01" })).toThrow(/on or before/);
  });
  it("rejects anything outside the whitelist", () => {
    expect(() => validateDef({ source: "users; DROP TABLE x" })).toThrow(/Unknown data source/);
    expect(() => validateDef({ source: "orders", columns: ["password_hash"] })).toThrow(/Unknown column/);
    expect(() => validateDef({ source: "orders", metrics: [{ fn: "sum", field: "rep" }] })).toThrow(/number field/);
    expect(() => validateDef({ source: "orders", metrics: [{ fn: "exec" }] })).toThrow(/Unknown metric/);
    expect(() => validateDef({ source: "orders", filters: { product: [1] } })).toThrow(/can't be filtered/);
    expect(() => validateDef({ source: "orders", filters: { rep: ["1 OR 1=1"] } })).toThrow(/Bad sales rep id/);
    expect(() => validateDef({ source: "stock", compare: "prev", metrics: [{ fn: "count" }] })).toThrow(/no dates/);
    expect(() => validateDef({ source: "orders", groupBy: ["a", "b", "c", "d"] })).toThrow(/Too many/);
  });
  it("every source has fixed company-scoped SQL and every template validates", () => {
    for (const [k, s] of Object.entries(SOURCES)) if (s.sql) expect(s.sql, k).toMatch(/company_id=\$1/);
    for (const t of TEMPLATES) expect(() => validateDef(templateDef(t)), t.key).not.toThrow();
  });
  it("schedules are due once per day at the hour", () => {
    const s = { enabled: true, freq: "daily", hour: 8 };
    expect(isDue(s, null, new Date("2026-10-30T01:00:00Z"))).toBe(false); // 06:30 IST
    expect(isDue(s, null, new Date("2026-10-30T03:00:00Z"))).toBe(true);
    expect(isDue(s, "2026-10-30T03:00:00Z", new Date("2026-10-30T05:00:00Z"))).toBe(false);
    expect(isDue({ ...s, freq: "weekly", weekday: 1 }, null, new Date("2026-10-30T05:00:00Z"))).toBe(false);
  });
});

describe("custom reports API", () => {
  it("previews sales by rep with live data, company scoped", async () => {
    const r = (await request(app).post("/api/report-builder/preview").set(as("mgr")).send({ def: sales }).expect(200)).body;
    expect(r.columns.map((c: any) => c.key)).toEqual(["rep", "sum_value", "count"]);
    const one = r.rows.find((x: any) => x.rep === "Rep One"); expect(one.count).toBe(2);
    expect(r.rows.find((x: any) => x.rep === "Rep Two").count).toBe(1);
    expect(r.rows[0].sum_value).toBeGreaterThanOrEqual(r.rows[1].sum_value);
    const b = (await request(app).post("/api/report-builder/preview").set(as("bAdm")).send({ def: sales }).expect(200)).body;
    expect(b.rows).toEqual([]);
  });
  it("filters by rep and outlet, conditions, raw columns, KPI and product lines", async () => {
    const reps = (await request(app).get("/api/users").set(as("adm"))).body; id.r1 = reps.find((u: any) => u.email === "r1@x.com").id;
    let r = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { ...sales, filters: { ...sales.filters, rep: [id.r1], shop: [id.s2] } } }).expect(200)).body;
    expect(r.rows).toHaveLength(1); expect(r.rows[0].count).toBe(1);
    r = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { source: "order_lines", columns: ["rep", "product", "qty"], conditions: [{ field: "qty", op: "gte", value: 10 }], sort: { by: "qty", dir: "asc" } } }).expect(200)).body;
    expect(r.rows.map((x: any) => x.rep)).toEqual(["Rep One", "Rep One"]); expect(r.rows[0].qty).toBeLessThanOrEqual(r.rows[1].qty);
    r = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { source: "orders", metrics: [{ fn: "count" }, { fn: "distinct", field: "outlet" }], view: { type: "kpi" } } }).expect(200)).body;
    expect(r.rows).toEqual([{ count: 3, distinct_outlet: 2 }]);
    r = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { source: "orders", groupBy: ["_month"], metrics: [{ fn: "count" }] } }).expect(200)).body;
    expect(r.rows[0]._month).toMatch(/^\d{4}-\d{2}$/);
  });
  it("compares with the previous period and last year", async () => {
    for (const compare of ["prev", "yoy"]) {
      const r = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { ...sales, compare } }).expect(200)).body;
      expect(r.columns.map((c: any) => c.key)).toContain("sum_value__prev");
      expect(r.compareRange.to < r.range.from).toBe(true);
      const one = r.rows.find((x: any) => x.rep === "Rep One"); expect(one.count__prev).toBe(0); expect(one.count__chg).toBeNull();
    }
  });
  it("sales reps can't build; shared reports show reps only their own rows", async () => {
    await request(app).post("/api/report-builder/preview").set(as("r1")).send({ def: sales }).expect(403);
    await request(app).post("/api/custom-reports").set(as("r1")).send({ name: "x", def: sales }).expect(403);
    const priv = (await request(app).post("/api/custom-reports").set(as("mgr")).send({ name: "Private", def: sales }).expect(201)).body;
    await request(app).get(`/api/custom-reports/${priv.id}/run`).set(as("r1")).expect(404);
    const shared = (await request(app).post("/api/custom-reports").set(as("mgr")).send({ name: "Team sales", def: sales, roles: ["sales_rep", "bogus"], pinned: true }).expect(201)).body;
    expect(shared.roles).toEqual(["sales_rep"]);
    const r = (await request(app).get(`/api/custom-reports/${shared.id}/run`).set(as("r1")).expect(200)).body;
    expect(r.rows.map((x: any) => x.rep)).toEqual(["Rep One"]);
    expect((await request(app).get("/api/custom-reports").set(as("r1"))).body.map((x: any) => x.name)).toEqual(["Team sales"]);
    const pins = (await request(app).get("/api/custom-reports/pinned").set(as("r2"))).body;
    expect(pins[0].result.rows.map((x: any) => x.rep)).toEqual(["Rep Two"]);
    await request(app).get(`/api/custom-reports/${shared.id}`).set(as("bAdm")).expect(404); // other company
    await request(app).delete(`/api/custom-reports/${shared.id}`).set(as("bAdm")).expect(404);
    id.shared = shared.id;
  });
  it("exports CSV and Excel", async () => {
    const c = await request(app).get(`/api/custom-reports/${id.shared}/export?format=csv`).set(as("adm")).expect(200);
    expect(c.headers["content-type"]).toMatch(/csv/); expect(c.text).toMatch(/Placed by,Total order value,Count/);
    const x = await request(app).post("/api/report-builder/export?format=xlsx").set(as("adm")).send({ def: sales, name: "Sales" }).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", d => b.push(d)); res.on("end", () => cb(null, Buffer.concat(b))); }).expect(200);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });
  it("copies every template and runs it", async () => {
    const cat = (await request(app).get("/api/report-builder/catalog").set(as("mgr")).expect(200)).body;
    expect(cat.templates.length).toBeGreaterThanOrEqual(7); expect(cat.sources.map((s: any) => s.key)).toEqual(expect.arrayContaining(["orders", "order_lines", "visits", "attendance", "collections", "returns", "stock", "shops", "reps"]));
    for (const t of cat.templates) {
      const r = (await request(app).post(`/api/custom-reports/from-template/${t.key}`).set(as("mgr")).expect(201)).body;
      expect(r.templateKey).toBe(t.key);
      await request(app).get(`/api/custom-reports/${r.id}/run`).set(as("mgr")).expect(200);
    }
    const risk = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: templateDef(TEMPLATES.find(t => t.key === "at_risk_shops")!) }).expect(200)).body;
    expect(risk.rows.length).toBeGreaterThan(0); expect(risk.rows.every((x: any) => x.outlet)).toBe(true);
  });
  it("edits, pins, exports and imports definitions as JSON", async () => {
    await request(app).put(`/api/custom-reports/${id.shared}`).set(as("mgr")).send({ name: "", def: sales }).expect(400);
    const u = (await request(app).put(`/api/custom-reports/${id.shared}`).set(as("mgr")).send({ name: "Team sales v2", def: { ...sales, view: { type: "pie" } }, roles: [] }).expect(200)).body;
    expect(u.def.view.type).toBe("pie");
    expect((await request(app).patch(`/api/custom-reports/${id.shared}/pin`).set(as("mgr")).send({ pinned: false }).expect(200)).body.pinned).toBe(false);
    const j = (await request(app).get("/api/custom-reports/export").set(as("adm")).expect(200)).body;
    expect(j.format).toBe("ownfield-reports");
    const imp = (await request(app).post("/api/custom-reports/import").set(as("bAdm")).send(j).expect(201)).body;
    expect(imp.length).toBe(j.reports.length);
    await request(app).post("/api/custom-reports/import").set(as("bAdm")).send({ reports: [{ name: "bad", def: { source: "secrets" } }] }).expect(400);
  });
  it("scheduled delivery saves a file and sends nothing without SMTP", async () => {
    await request(app).put(`/api/custom-reports/${id.shared}`).set(as("mgr")).send({ name: "S", def: sales, schedule: { enabled: true, emails: "not-an-email" } }).expect(400);
    process.env.REPORT_OUTBOX = (await import("node:os")).tmpdir() + "/ff-outbox-test"; delete process.env.SMTP_HOST;
    await request(app).put(`/api/custom-reports/${id.shared}`).set(as("mgr")).send({ name: "S", def: sales, schedule: { enabled: true, freq: "daily", hour: 0, emails: ["boss@x.com"], format: "csv" } }).expect(200);
    expect(await runDueReports(db)).toBe(1);
    const r = (await request(app).get(`/api/custom-reports/${id.shared}`).set(as("mgr"))).body;
    expect(r.lastStatus).toMatch(/email not sent/);
    expect(await runDueReports(db)).toBe(0);
  });
  it("runs the other sources", async () => {
    for (const source of ["visits", "attendance", "collections", "returns", "invoices", "stock", "outstanding", "beat_plan", "reps"]) {
      const r = await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { source, metrics: [{ fn: "count" }] } });
      expect(r.status, `${source}: ${JSON.stringify(r.body)}`).toBe(200);
    }
  });
});
