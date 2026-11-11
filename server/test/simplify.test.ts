// Simpler flows: one person can finish each step, blocked steps say who to ask (and remind them), and admins add users from the Users screen.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, db: any; const T: Record<string, string> = {}; const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const login = async (c: string, e: string, p = "pw") => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: p })).body.token;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
const place = (who: string, shop: string, qty = 1) => request(app).post("/api/orders").set(H(who)).send({ clientRef: `sx${++n}`, shopId: ids[shop], lines: [{ variantId: ids.v, qty }] });
const notes = async (who: string) => (await request(app).get("/api/notifications").set(H(who))).body as any[];

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "SIMP", name: "Sample Co", userLimit: 30, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.a = await login("SIMP", "a@x.com");
  // Two teams: m1 → r1, m2 → r2. d1 is a distributor.
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password", "Reports To"],
    ["Sample Mgr 1", "m1@x.com", "manager", "pw", ""], ["Sample Mgr 2", "m2@x.com", "manager", "pw", ""],
    ["Sample Rep 1", "r1@x.com", "sales_rep", "pw", "m1@x.com"], ["Sample Rep 2", "r2@x.com", "sales_rep", "pw", "m2@x.com"], ["Sample Dist", "d1@x.com", "distributor", "pw", ""]]), "u.csv").expect(200);
  await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email"], ["SD", "Sample Dist Shop", "d1@x.com"], ["SC", "Sample Company Shop", ""]]), "s.csv").expect(200);
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-1", "M", "400", "300"]]), "p.csv").expect(200);
  for (const k of ["m1", "m2", "r1", "r2", "d1"]) T[k] = await login("SIMP", `${k}@x.com`);
  const shops = (await request(app).get("/api/shops").set(H("a"))).body;
  ids.sd = shops.find((s: any) => s.code === "SD").id; ids.sc = shops.find((s: any) => s.code === "SC").id;
  ids.v = (await db.query("SELECT id FROM variants WHERE sku='T-1'")).rows[0].id;
});

describe("company-direct orders: the rep's manager can finish them", () => {
  it("manager accepts, sends out and delivers a company-direct order from their team", async () => {
    const o = (await place("r1", "sc").expect(201)).body;
    for (const st of ["accepted", "dispatched", "fulfilled"]) expect((await request(app).post(`/api/orders/${o.id}/status`).set(H("m1")).send({ status: st }).expect(200)).body.status).toBe(st);
  });
  it("manager can reject one; a manager of another team cannot touch it", async () => {
    const o = (await place("r1", "sc").expect(201)).body;
    await request(app).post(`/api/orders/${o.id}/status`).set(H("m2")).send({ status: "accepted" }).expect(404);
    expect((await request(app).post(`/api/orders/${o.id}/status`).set(H("m1")).send({ status: "rejected", reason: "sample" }).expect(200)).body.status).toBe("rejected");
  });
  it("distributor orders stay with the distributor (manager gets a clear 403)", async () => {
    const o = (await place("r1", "sd").expect(201)).body;
    const r = await request(app).post(`/api/orders/${o.id}/status`).set(H("m1")).send({ status: "accepted" }).expect(403);
    expect(r.body.error).toMatch(/distributor/);
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
  });
});

describe("order approval notices go only to people who can approve", () => {
  it("admin and the rep's own manager are told; the other team's manager is not", async () => {
    await request(app).put("/api/company/settings").set(H("a")).send({ approval: { levels: 1, above: 0 } }).expect(200);
    const o = (await place("r1", "sd").expect(201)).body; expect(o.status).toBe("pending_approval");
    const has = async (who: string) => (await notes(who)).some(x => x.template === "Order #{0} at {1} needs your approval" && x.args[0] === o.id);
    expect(await has("a")).toBe(true); expect(await has("m1")).toBe(true); expect(await has("m2")).toBe(false);
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(H("m1")).send({}).expect(200)).body.status).toBe("placed"); // one approval is enough
    await request(app).put("/api/company/settings").set(H("a")).send({ approval: { levels: 0, above: 0 } }).expect(200);
  });
});

describe("new outlet waiting for approval", () => {
  it("a blocked order says the manager was reminded, and reminds them only once", async () => {
    const s = (await request(app).post("/api/outlets/request").set(H("r1")).send({ clientRef: "sn1", name: "Sample New Outlet", lat: 13.08, lng: 80.27 }).expect(201)).body;
    ids.pend = s.id;
    const count = async () => (await notes("m1")).filter(x => x.template === "New outlet {0} needs your approval" && x.args[0] === "Sample New Outlet").length;
    expect(await count()).toBe(1); // the first notice when the rep added it
    await db.query("UPDATE notifications SET created_at=NOW() - INTERVAL '7 hours' WHERE template='New outlet {0} needs your approval'");
    const r = await place("r1", "pend").expect(409);
    expect(r.body.error).toMatch(/reminded your manager/);
    expect(await count()).toBe(2);
    await place("r1", "pend").expect(409);
    expect(await count()).toBe(2); // no spam on retries
    expect((await notes("m2")).some(x => x.template === "New outlet {0} needs your approval")).toBe(false);
    await request(app).post(`/api/outlets/${s.id}/decision`).set(H("m1")).send({ decision: "approve" }).expect(200);
    await place("r1", "pend").expect(201);
  });
});

describe("admin adds a single user from the Users screen", () => {
  it("without a password: a one-time link is returned and the user sets their own password", async () => {
    const r = (await request(app).post("/api/users").set(H("a")).send({ name: "Sample New Rep", email: "new@x.com", role: "sales_rep", reportsTo: String((await db.query("SELECT id FROM users WHERE email='m1@x.com'")).rows[0].id) }).expect(201)).body;
    expect(r.user.email).toBe("new@x.com"); expect(r.setup.code).toMatch(/^[0-9A-F]{12}$/); expect(r.setup.link).toContain("reset=");
    expect(r.user.reports_to).toBeTruthy();
    await request(app).post("/api/auth/reset").send({ companyCode: "SIMP", email: "new@x.com", code: r.setup.code, password: "Sample1234" }).expect(200);
    expect(await login("SIMP", "new@x.com", "Sample1234")).toBeTruthy();
    const log = (await request(app).get("/api/audit-log").set(H("a"))).body;
    expect(JSON.stringify(log)).toContain("user.create");
  });
  it("only admins can add users; duplicates are refused", async () => {
    await request(app).post("/api/users").set(H("m1")).send({ name: "X", email: "x2@x.com", role: "sales_rep" }).expect(403);
    const d = await request(app).post("/api/users").set(H("a")).send({ name: "Dup", email: "new@x.com", role: "sales_rep" });
    expect(d.status).toBeGreaterThanOrEqual(400); expect(d.status).toBeLessThan(500);
  });
});
