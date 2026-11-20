// High/medium architect follow-ups: versioned migrations, indexes, DNS pinning, stock import,
// CSV formula safety, logout cache keys, and concurrent order clientRef idempotency.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { migrate, SCHEMA, appliedMigrations, MIGRATIONS } from "../src/db.js";
import { csvCell, toCsv, sanitizeRow } from "../src/csv.js";
import { pinUrl, pinnedLookup, checkUrl } from "../src/integrations/webhooks.js";
import { STOCK_IMPORT_MAX_ROWS } from "../src/catalog.js";
import { sessionKeysToRemove, KEEP_ON_LOGOUT } from "../../web/src/session-cache.ts";
import { txDb } from "./txdb.js";

describe("csv formula neutralization", () => {
  it("prefixes formula-like strings but leaves numbers alone", () => {
    expect(csvCell("=cmd|'/c calc'!A0")).toBe("'=cmd|'/c calc'!A0");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-SUM(A1)")).toBe("'-SUM(A1)");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\r=1+1")).toBe("'\r=1+1");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("Shop")).toBe("Shop");
  });
  it("escapes formula cells in toCsv output", () => {
    const csv = toCsv([{ name: "=1+1", qty: 3 }]);
    expect(csv).toMatch(/'=1\+1/);
    expect(csv.split("\n")[1]).not.toMatch(/^=/);
    expect(sanitizeRow({ name: "+cmd" }).name).toBe("'+cmd");
  });
});

describe("session cache keys on logout", () => {
  it("clears offline user data but keeps device id and language", () => {
    const keys = ["ff", "ff-c:/api/shops", "ff-shops", "ff-items", "ff-order-queue", "ff-open-visit", "ff-setup-hidden", "ff-device", "ff-lang", "unrelated"];
    const gone = sessionKeysToRemove(keys);
    expect(gone).toEqual(expect.arrayContaining(["ff", "ff-c:/api/shops", "ff-shops", "ff-items", "ff-order-queue", "ff-open-visit", "ff-setup-hidden"]));
    expect(gone).not.toContain("ff-device");
    expect(gone).not.toContain("ff-lang");
    expect(gone).not.toContain("unrelated");
    expect(KEEP_ON_LOGOUT.has("ff-device")).toBe(true);
  });
});

describe("DNS pin: resolve once, refuse mixed private results, no second lookup", () => {
  it("refuses when any resolved address is private", async () => {
    const lookup = (async () => [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }]) as any;
    const r = await pinUrl("https://example.com/hook", true, lookup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Private/);
  });
  it("pins only the validated addresses and the lookup helper never calls DNS", async () => {
    const lookup = (async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }]) as any;
    const r = await pinUrl("https://example.com/hook", true, lookup);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pin.addresses).toEqual(["8.8.8.8", "1.1.1.1"]);
    expect(r.pin.host).toBe("example.com");
    let called = 0;
    const fn = pinnedLookup(r.pin.addresses);
    fn("evil.example", { all: true }, (err, addrs) => { called++; expect(err).toBeNull(); expect(addrs).toEqual([{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }]); });
    fn("evil.example", {}, (err, addr, family) => { called++; expect(addr).toBe("8.8.8.8"); expect(family).toBe(4); });
    expect(called).toBe(2);
  });
  it("still allows a public IP literal", async () => {
    expect(await checkUrl("https://8.8.8.8/hook", true)).toBeNull();
  });
});

describe("versioned migrations stay compatible with an existing database", () => {
  it("stamps baseline + indexes on a DB that already has the old SCHEMA and no migrations table", async () => {
    const { Pool } = newDb().adapters.createPg(); const db = new Pool();
    for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) await db.query(stmt);
    expect(await appliedMigrations(db)).toEqual([]);
    await db.query("INSERT INTO companies (code, name) VALUES ($1, $2)", ["OLD", "Existing Co"]);
    await migrate(db);
    expect(await appliedMigrations(db)).toEqual(MIGRATIONS.map(m => m.id));
    const c = (await db.query("SELECT code FROM companies WHERE code=$1", ["OLD"])).rows[0];
    expect(c.code).toBe("OLD");
    await migrate(db); // idempotent
    expect(await appliedMigrations(db)).toEqual(MIGRATIONS.map(m => m.id));
    // pg-mem has no pg_indexes catalog; stamping 002 and a second migrate is the compatibility check.
  });
  it("creates schema_migrations and indexes on a fresh database", async () => {
    const { Pool } = newDb().adapters.createPg(); const db = new Pool();
    await migrate(db);
    expect(await appliedMigrations(db)).toEqual(["001_baseline", "002_perf_indexes"]);
  });
});

describe("stock import and concurrent order idempotency", () => {
  let app: any; const T: Record<string, string> = {}; const I: Record<string, number> = {};
  const H = (k: string) => ({ Authorization: `Bearer ${T[k]}` });
  const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
  const login = async (e: string) => (await request(app).post("/api/auth/login").send({ companyCode: "HD2", email: e, password: "goodpass1" }).expect(200)).body.token;
  const qty = async () => Number((await request(app).get("/api/stock").set(H("d1"))).body.find((s: any) => s.sku === "T-2Y").qty);

  beforeAll(async () => {
    const db = txDb(); await migrate(db); app = createApp(db, "t");
    T.a = (await request(app).post("/api/signup").send({ companyName: "H2 Co", companyCode: "HD2", industry: "fmcg", adminName: "Ann", email: "a@x.com", password: "goodpass1", consent: true }).expect(201)).body.token;
    await request(app).put("/api/company/settings").set(H("a")).send({ features: { distInventory: true } }).expect(200);
    await request(app).post("/api/import/products").set(H("a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price"], ["TEE", "T-2Y", "2Y", "400", "300"], ["TEE", "T-3Y", "3Y", "400", "300"]]), "p.csv").expect(200);
    await request(app).post("/api/import/users").set(H("a")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r1@x.com", "sales_rep", "goodpass1"], ["Dist", "d1@x.com", "distributor", "goodpass1"]]), "u.csv").expect(200);
    T.r1 = await login("r1@x.com"); T.d1 = await login("d1@x.com");
    await request(app).post("/api/import/shops").set(H("a")).attach("file", csv([["Code", "Name", "Distributor Email"], ["S1", "Shop 1", "d1@x.com"]]), "s.csv").expect(200);
    I.s1 = (await request(app).get("/api/shops").set(H("a"))).body[0].id;
    await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv([["SKU", "Qty"], ["T-2Y", "100"], ["T-3Y", "20"]]), "st.csv").expect(200);
  });

  it("is all-or-nothing: a bad row rolls back earlier rows in the same file", async () => {
    const before = await qty();
    const r = await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv([["SKU", "Qty"], ["T-2Y", "50"], ["NOPE", "1"]]), "st.csv");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No rows were changed/);
    expect(await qty()).toBe(before);
  });

  it("rejects a file over the row cap with a clear message", async () => {
    const rows = [["SKU", "Qty"], ...Array.from({ length: STOCK_IMPORT_MAX_ROWS + 1 }, (_, i) => ["T-2Y", "1"])];
    const r = await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv(rows), "big.csv");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(new RegExp(String(STOCK_IMPORT_MAX_ROWS)));
    expect(r.body.error).toMatch(/Split the file/i);
  });

  it("treats imported qty as on-hand and never drops below reserved units", async () => {
    const o = (await request(app).post("/api/orders").set(H("r1")).send({ clientRef: "hold-1", shopId: I.s1, lines: [{ sku: "T-2Y", qty: 10 }] }).expect(201)).body;
    expect(o.status).toBeTruthy();
    const afterHold = await qty();
    expect(afterHold).toBe(90);
    const ok = await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv([["SKU", "Qty"], ["T-2Y", "100"]]), "st.csv").expect(200);
    expect(ok.body.updated).toBe(1);
    expect(await qty()).toBe(90); // 100 on-hand minus 10 reserved
    const bad = await request(app).post("/api/import/stock").set(H("d1")).attach("file", csv([["SKU", "Qty"], ["T-2Y", "5"]]), "st.csv");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/reserved on open orders/);
    expect(await qty()).toBe(90);
  });

  it("returns the existing order (200) when the same clientRef is submitted again", async () => {
    const body = { clientRef: "race-1", shopId: I.s1, lines: [{ sku: "T-3Y", qty: 1 }] };
    const created = (await request(app).post("/api/orders").set(H("r1")).send(body).expect(201)).body;
    const again = await request(app).post("/api/orders").set(H("r1")).send(body).expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(created.id);
  });
});
