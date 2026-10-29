import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import * as XLSX from "xlsx";
import { createApp, ensurePlatformOwner, usageInfo } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, owner: string;
const login = async (companyCode: string, email: string, password: string) =>
  (await request(app).post("/api/auth/login").send({ companyCode, email, password })).body.token as string;
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  const db = new Pool();
  await migrate(db);
  await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
  owner = await login("PLATFORM", "owner@example.com", "pw");
  for (const code of ["ACME", "BETA"])
    await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${owner}`)
      .send({ code, name: `${code} Sample Kidswear`, userLimit: 5, admin: { email: "admin@x.com", name: "Admin", password: "pw" } }).expect(201);
});

describe("usage maths", () => {
  it("warns at 80%", () => {
    expect(usageInfo(3, 5).warning).toBe(false);
    expect(usageInfo(4, 5).warning).toBe(true);
    expect(usageInfo(5, 5).atLimit).toBe(true);
  });
});

describe("auth & roles", () => {
  it("company-code login; wrong code fails", async () => {
    expect(await login("ACME", "admin@x.com", "pw")).toBeTruthy();
    await request(app).post("/api/auth/login").send({ companyCode: "NOPE", email: "admin@x.com", password: "pw" }).expect(401);
  });
  it("non-owner cannot manage companies", async () => {
    const t = await login("ACME", "admin@x.com", "pw");
    await request(app).get("/api/platform/companies").set("Authorization", `Bearer ${t}`).expect(403);
    await request(app).get("/api/users").expect(401);
  });
});

describe("imports, limits, tenant isolation", () => {
  it("imports products and shops via CSV and XLSX, isolated per tenant", async () => {
    const a = await login("ACME", "admin@x.com", "pw");
    const r = await request(app).post("/api/import/products").set("Authorization", `Bearer ${a}`)
      .attach("file", csv([["Style", "SKU", "Size", "HSN", "MRP", "Billing Price"],
        ["SAMPLE-TEE", "ST-01-2Y", "2Y", "6111", "499", "350"], ["SAMPLE-TEE", "ST-01-3Y", "3Y", "6111", "499", "600"]]), "p.csv");
    expect(r.body.inserted).toBe(1);
    expect(r.body.errors[0].error).toMatch(/exceed/);
    const ws = XLSX.utils.aoa_to_sheet([["Code", "Name", "City"], ["S1", "Sample Shop", "Chennai"]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Shops");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    expect((await request(app).post("/api/import/shops").set("Authorization", `Bearer ${a}`).attach("file", buf, "s.xlsx")).body.inserted).toBe(1);
    const b = await login("BETA", "admin@x.com", "pw");
    expect((await request(app).get("/api/products").set("Authorization", `Bearer ${b}`)).body).toHaveLength(0);
    expect((await request(app).get("/api/shops").set("Authorization", `Bearer ${a}`)).body).toHaveLength(1);
  });
  it("warns at 80% and blocks over limit; owner can raise limit", async () => {
    const a = await login("ACME", "admin@x.com", "pw");
    const add = (i: number) => request(app).post("/api/users").set("Authorization", `Bearer ${a}`)
      .send({ email: `rep${i}@x.com`, name: `Rep ${i}`, password: "pw", role: "sales_rep" });
    await add(1); await add(2);
    const r3 = await add(3);
    expect(r3.body.usage.warning).toBe(true);
    await add(4);
    expect((await add(5)).status).toBe(409);
    const list = (await request(app).get("/api/platform/companies").set("Authorization", `Bearer ${owner}`)).body;
    const acme = list.find((c: any) => c.code === "ACME");
    await request(app).patch(`/api/platform/companies/${acme.id}`).set("Authorization", `Bearer ${owner}`).send({ userLimit: 6 }).expect(200);
    expect((await add(5)).status).toBe(201);
  });
  it("sales rep can read products but not import", async () => {
    const r = await login("ACME", "rep1@x.com", "pw");
    await request(app).get("/api/products").set("Authorization", `Bearer ${r}`).expect(200);
    await request(app).post("/api/import/shops").set("Authorization", `Bearer ${r}`).expect(403);
  });
});
