import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, db: any; const T: Record<string, string> = {}; const ids: Record<string, number> = {};
const H = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
let n = 0;
const place = async (qty = 4, shop = "s1") => (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: `f${++n}`, shopId: ids[shop], lines: [{ variantId: ids.v, qty }] }).expect(201)).body;
const get = async (id: number, who = "a") => (await request(app).get("/api/orders").set(H(who))).body.find((o: any) => o.id === id);

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "ACME", name: "ACME", userLimit: 20, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.a = await login("ACME", "a@x.com");
  await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep One", "r1@x.com", "sales_rep", "pw"], ["Dist One", "d1@x.com", "distributor", "pw"], ["Mgr", "m1@x.com", "manager", "pw"]]), "u.csv");
  await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email", "Outlet Type"], ["S1", "Shop 1", "d1@x.com", ""], ["S2", "Shop 2", "d1@x.com", "Wholesale"]]), "s.csv");
  await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-2Y", "2Y", "400", "300"]]), "p.csv");
  for (const k of ["r1", "d1", "m1"]) T[k] = await login("ACME", `${k}@x.com`);
  const shops = (await request(app).get("/api/shops").set(H("a"))).body; ids.s1 = shops.find((s: any) => s.code === "S1").id; ids.s2 = shops.find((s: any) => s.code === "S2").id;
  ids.v = (await db.query("SELECT id FROM variants WHERE sku='T-2Y'")).rows[0].id;
});

describe("order life cycle", () => {
  it("accept → dispatch → partial delivery: history, notifications, totals", async () => {
    const o = await place(4);
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "dispatched" }).expect(200);
    const lid = (await get(o.id)).lines[0].id;
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "fulfilled", lines: [{ id: lid, qty: 9 }] }).expect(400);
    const d = (await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "fulfilled", lines: [{ id: lid, qty: 3 }], reason: "short stock" }).expect(200)).body;
    expect(d.partial).toBe(true); expect(Number(d.total)).toBe(900);
    const g = await get(o.id);
    expect(g.lines[0].qty).toBe(3); expect(g.lines[0].ordered_qty).toBe(4); expect(g.partial).toBe(true);
    expect(g.history.map((h: any) => h.status)).toEqual(["placed", "accepted", "dispatched", "partly_delivered"]);
    const notes = (await request(app).get("/api/notifications").set(H("r1"))).body;
    expect(notes.map((x: any) => x.args[2])).toEqual(["partly delivered", "dispatched", "accepted"]);
    expect((await request(app).get("/api/notifications").set(H("d1"))).body[0].template).toBe("New order #{0} from {1}");
    await request(app).post("/api/notifications/read").set(H("r1")).expect(200);
    expect((await request(app).get("/api/notifications").set(H("r1"))).body.every((x: any) => x.read_at)).toBe(true);
  });
  it("edit while new reprices; not after acceptance; only own", async () => {
    const o = await place(1);
    const e = (await request(app).put(`/api/orders/${o.id}`).set(H("r1")).send({ lines: [{ variantId: ids.v, qty: 2 }] }).expect(200)).body;
    expect(Number(e.total)).toBe(600);
    await request(app).put(`/api/orders/${o.id}`).set(H("d1")).send({ lines: [{ variantId: ids.v, qty: 2 }] }).expect(403);
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(200);
    await request(app).put(`/api/orders/${o.id}`).set(H("r1")).send({ lines: [{ variantId: ids.v, qty: 5 }] }).expect(409);
    expect((await get(o.id)).history.map((h: any) => h.status)).toEqual(["placed", "edited", "accepted"]);
  });
  it("channel price list applies by outlet type", async () => {
    const r = (await request(app).post("/api/import/prices").set(H("a")).attach("file", csv([["SKU", "Outlet Type", "Price"], ["T-2Y", "wholesale", "250"], ["NOPE", "x", "1"]]), "c.csv")).body;
    expect(r.inserted).toBe(1); expect(r.errors).toHaveLength(1);
    expect(Number((await place(2, "s2")).total)).toBe(500);
    expect(Number((await place(2, "s1")).total)).toBe(600);
  });
  it("two-level approval above an amount; distributor sees it only after final approval", async () => {
    await request(app).put("/api/company/settings").set(H("a")).send({ approval: { levels: 2, above: 1000 } }).expect(200);
    expect((await place(1)).status).toBe("placed");
    const o = await place(5);
    expect(o.status).toBe("pending_approval");
    expect(await get(o.id, "d1")).toBeUndefined();
    await request(app).post(`/api/orders/${o.id}/status`).set(H("d1")).send({ status: "accepted" }).expect(404);
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(H("m1")).send({}).expect(200)).body.status).toBe("pending_approval");
    await request(app).post(`/api/orders/${o.id}/approve`).set(H("m1")).send({}).expect(409);
    expect((await request(app).post(`/api/orders/${o.id}/approve`).set(H("a")).send({}).expect(200)).body.status).toBe("placed");
    expect((await get(o.id, "d1")).status).toBe("placed");
    const p = await place(5);
    const rj = (await request(app).post(`/api/orders/${p.id}/approve`).set(H("m1")).send({ decision: "reject", reason: "too big" }).expect(200)).body;
    expect(rj.status).toBe("rejected"); expect(rj.status_reason).toBe("too big");
    await request(app).put("/api/company/settings").set(H("a")).send({ approval: { levels: 9 } }).expect(400);
    await request(app).put("/api/company/settings").set(H("a")).send({ approval: { levels: 0, above: 0 } }).expect(200);
  });
});
