import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { guardSql } from "../src/workspace/guard.js";
import { parseAllowlist } from "../src/workspace/service.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const id: Record<string, number> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const q = (who: string, sql: string) => request(app).post("/api/data-workspace/query").set(as(who)).send({ sql });

beforeAll(async () => {
  const db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  for (const c of ["WA", "WB"]) await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: c, name: c, industry: "apparel", userLimit: 10, admin: { email: "a@x.com", name: `Admin ${c}`, password: "pw" } });
  T.a = await login("WA", "a@x.com"); T.b = await login("WB", "a@x.com");
  await request(app).post("/api/import/users").set(as("a")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.rep = await login("WA", "r@x.com"); T.mgr = await login("WA", "m@x.com");
  for (const t of ["a", "b"]) await request(app).post("/api/company/sample-data").set(as(t)).expect(200);
  id.bShop = (await request(app).get("/api/shops").set(as("b"))).body[0].id;
  const s = (await request(app).get("/api/shops").set(as("a"))).body[0].id;
  await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "w1", shopId: s, lines: [{ sku: "STEE-2Y-RED", qty: 3 }] }).expect(201);
});

describe("SQL guard", () => {
  const ok = (s: string) => guardSql(s, "ff_c1");
  it("allows plain SELECT/WITH and points tables at the company schema", () => {
    expect(ok("SELECT count(*) FROM orders o JOIN shops s ON s.id=o.shop_id")).toBe("SELECT count(*) FROM ff_c1.orders o JOIN ff_c1.shops s ON s.id=o.shop_id");
    expect(ok("with x as (select * from orders) select * from x, shops;")).toContain("ff_c1.shops");
    expect(ok("SELECT 'drop table; delete' AS t")).toContain("'drop table; delete'");
  });
  it("blocks writes, DDL, multiple statements, catalogs, other schemas, secrets and unsafe functions", () => {
    for (const s of ["DELETE FROM orders", "UPDATE orders SET total=0", "INSERT INTO orders VALUES (1)", "DROP TABLE orders", "SELECT 1; DELETE FROM orders",
      "SELECT * INTO x FROM orders", "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d", "SELECT * FROM public.orders", "SELECT * FROM ff_c2.orders",
      "SELECT * FROM pg_catalog.pg_tables", "SELECT * FROM information_schema.tables", "SELECT * FROM pg_user", "SELECT password_hash FROM api_keys", "SELECT * FROM companies",
      "SELECT pg_read_file('/etc/passwd')", "SELECT set_config('x','1',false)", "SELECT current_setting('x')", "SELECT dblink('h','q')", "SELECT pg_sleep(100)",
      "COPY orders TO '/tmp/x'", "SET ROLE postgres", "SELECT $$x$$", "SELECT * FROM orders FOR UPDATE", "SELECT lo_import('/etc/passwd')", "select 1 /* unclosed"])
      expect(() => ok(s), s).toThrow();
  });
});

describe("data workspace", () => {
  it("is limited to admins and data analysts", async () => {
    await q("mgr", "SELECT 1 AS x").expect(403); await q("rep", "SELECT 1 AS x").expect(403);
    const mgrId = (await request(app).get("/api/users").set(as("a"))).body.find((u: any) => u.email === "m@x.com").id;
    await request(app).put("/api/data-workspace/analysts").set(as("mgr")).send({ userIds: [mgrId] }).expect(403);
    expect((await request(app).put("/api/data-workspace/analysts").set(as("a")).send({ userIds: [mgrId, 99999] }).expect(200)).body).toEqual([mgrId]);
    expect((await q("mgr", "SELECT 1 AS x").expect(200)).body.rows).toEqual([{ x: 1 }]);
  });
  it("schema browser lists allowed tables without secrets", async () => {
    const s = (await request(app).get("/api/data-workspace/schema").set(as("a")).expect(200)).body;
    const users = s.tables.find((t: any) => t.name === "users");
    expect(users.columns.map((c: any) => c.name)).not.toContain("password_hash");
    expect(s.tables.map((t: any) => t.name)).not.toContain("api_keys");
  });
  it("company A cannot see company B (isolation)", async () => {
    const a = (await q("a", "SELECT name FROM users").expect(200)).body.rows.map((r: any) => r.name);
    expect(a).toContain("Admin WA"); expect(a).not.toContain("Admin WB");
    expect((await q("a", `SELECT id FROM shops WHERE id=${id.bShop}`).expect(200)).body.rows).toEqual([]);
    const ao = (await q("a", "SELECT count(*) AS n FROM orders").expect(200)).body.rows[0].n, bo = (await q("b", "SELECT count(*) AS n FROM orders").expect(200)).body.rows[0].n;
    expect(Number(ao)).toBe(1); expect(Number(bo)).toBe(0);
    await q("a", "SELECT * FROM ff_c2.users").expect(400);
    await q("a", "SELECT * FROM public.users").expect(400);
    const lines = (await q("b", "SELECT count(*) AS n FROM order_lines").expect(200)).body.rows[0].n; expect(Number(lines)).toBe(0);
  });
  it("blocks writes and leaves data untouched", async () => {
    await q("a", "DELETE FROM orders").expect(400);
    await q("a", "SELECT 1 AS x; UPDATE orders SET total=0").expect(400);
    expect(Number((await q("a", "SELECT count(*) AS n FROM orders WHERE total > 0").expect(200)).body.rows[0].n)).toBe(1);
  });
  it("logs every query, including refused ones", async () => {
    const h = (await request(app).get("/api/data-workspace/history").set(as("a")).expect(200)).body;
    expect(h.some((r: any) => r.action === "workspace.sql_refused" && /DELETE/.test(r.detail))).toBe(true);
    expect(h.some((r: any) => r.action === "workspace.sql")).toBe(true);
  });
  it("saved SQL datasets work as report-builder sources (and stay company scoped)", async () => {
    const d = (await request(app).post("/api/data-workspace/datasets").set(as("a")).send({ name: "Orders by status", sql: "SELECT status, count(*) AS orders, sum(total) AS value FROM orders GROUP BY status" }).expect(201)).body;
    expect(d.columns.map((c: any) => c.key)).toEqual(["status", "orders", "value"]);
    const cat = (await request(app).get("/api/report-builder/catalog").set(as("a")).expect(200)).body;
    expect(cat.sources.map((x: any) => x.key)).toContain(`ds:${d.id}`);
    const def = { source: `ds:${d.id}`, groupBy: ["status"], metrics: [{ fn: "sum", field: "value" }], view: { type: "pie" } };
    const r = (await request(app).post("/api/report-builder/preview").set(as("a")).send({ def }).expect(200)).body;
    expect(r.rows[0].status).toBe("placed");
    const saved = (await request(app).post("/api/custom-reports").set(as("a")).send({ name: "SQL pie", def }).expect(201)).body;
    await request(app).get(`/api/custom-reports/${saved.id}/export?format=csv`).set(as("a")).expect(200);
    await request(app).post("/api/report-builder/preview").set(as("b")).send({ def }).expect(400); // B can't use A's dataset
    await request(app).post("/api/data-workspace/datasets").set(as("a")).send({ name: "bad", sql: "DELETE FROM orders" }).expect(400);
  });
  it("BI access is off by default and needs a database that allows roles", async () => {
    expect((await request(app).get("/api/data-workspace/bi-access").set(as("a")).expect(200)).body.enabled).toBe(false);
    await request(app).put("/api/data-workspace/bi-access").set(as("a")).send({ enabled: true }).expect(409);
    await request(app).put("/api/data-workspace/bi-access").set(as("mgr")).send({ enabled: true }).expect(403);
  });
  it("BI allow-list: admin only, single IPs or small networks, never everyone; server not exposed by default", async () => {
    expect(parseAllowlist("203.0.113.5, 198.51.100.0/24 2001:db8::1")).toEqual(["203.0.113.5/32", "198.51.100.0/24", "2001:db8::1/128"]);
    for (const bad of ["0.0.0.0/0", "10.0.0.0/8", "::/0", "300.1.1.1", "127.0.0.1", "example.com", "2001:db8::/32"]) expect(() => parseAllowlist(bad), bad).toThrow();
    await request(app).put("/api/data-workspace/bi-allowlist").set(as("a")).send({ ips: "0.0.0.0/0" }).expect(400);
    await request(app).put("/api/data-workspace/bi-allowlist").set(as("mgr")).send({ ips: "203.0.113.5" }).expect(403);
    expect((await request(app).put("/api/data-workspace/bi-allowlist").set(as("a")).send({ ips: "203.0.113.5" }).expect(200)).body.allowlist).toEqual(["203.0.113.5/32"]);
    const st = (await request(app).get("/api/data-workspace/bi-access").set(as("a")).expect(200)).body;
    expect(st.allowlist).toEqual(["203.0.113.5/32"]); expect(st.server.exposed).toBe(false); expect(st.enabled).toBe(false);
    expect((await request(app).get("/api/data-workspace/bi-access").set(as("b")).expect(200)).body.allowlist).toEqual([]);
  });
});
