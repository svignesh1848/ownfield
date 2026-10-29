import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { totpCode } from "../src/accounts.js";
import { prune } from "../src/backup.js";

process.env.LOGIN_FAIL_MAX = "3";
let app: any, db: any, owner: string, adm: string;
const login = (body: any, ip = "10.0.0.1") => request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send(body);
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const adminLogin = async () => (await login({ companyCode: "SEC", email: "admin@x.com", password: "adminpass1" })).body.token;

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
  owner = (await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw" })).body.token;
  await request(app).post("/api/platform/companies").set(H(owner)).send({ code: "SEC", name: "Sec Sample", userLimit: 9, admin: { email: "admin@x.com", name: "Admin", password: "adminpass1" } }).expect(201);
  adm = await adminLogin();
  for (const e of ["rep@x.com", "rep2@x.com", "gone@x.com"]) await request(app).post("/api/users").set(H(adm)).send({ email: e, name: e, password: "reppass12", role: "sales_rep" }).expect(201);
});

describe("security", () => {
  it("sends security headers and no CORS for foreign origins", async () => {
    const r = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(r.headers["strict-transport-security"]).toContain("max-age=");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
  it("locks an account after repeated failures, even with the right password", async () => {
    for (let i = 0; i < 3; i++) await login({ companyCode: "SEC", email: "rep2@x.com", password: "nope" }, `10.1.0.${i}`).expect(401);
    expect((await login({ companyCode: "SEC", email: "rep2@x.com", password: "reppass12" }, "10.1.1.1")).status).toBe(429);
  });
  it("revokes tokens when a user is disabled or their password changes", async () => {
    const t = (await login({ companyCode: "SEC", email: "rep@x.com", password: "reppass12" })).body.token;
    await request(app).get("/api/me").set(H(t)).expect(200);
    const id = (await request(app).get("/api/users").set(H(adm))).body.find((u: any) => u.email === "rep@x.com").id;
    await request(app).patch(`/api/users/${id}`).set(H(adm)).send({ password: "newpass123" }).expect(200);
    await request(app).get("/api/me").set(H(t)).expect(401);
    const t2 = (await login({ companyCode: "SEC", email: "rep@x.com", password: "newpass123" })).body.token;
    await request(app).patch(`/api/users/${id}`).set(H(adm)).send({ active: false }).expect(200);
    await request(app).get("/api/me").set(H(t2)).expect(401);
    await request(app).patch(`/api/users/${id}`).set(H(adm)).send({ active: true }).expect(200);
  });
  it("one-time reset code works once", async () => {
    const id = (await request(app).get("/api/users").set(H(adm))).body.find((u: any) => u.email === "rep@x.com").id;
    const { code } = (await request(app).post(`/api/users/${id}/reset-code`).set(H(adm)).expect(200)).body;
    const body = { companyCode: "SEC", email: "rep@x.com", code, password: "resetpass1" };
    await request(app).post("/api/auth/reset").send(body).expect(200);
    await request(app).post("/api/auth/reset").send(body).expect(400);
    expect((await login({ companyCode: "SEC", email: "rep@x.com", password: "resetpass1" })).body.token).toBeTruthy();
  });
  it("TOTP enrolment, enforced login and company enforcement", async () => {
    const t = (await login({ companyCode: "SEC", email: "rep@x.com", password: "resetpass1" })).body.token;
    const { secret } = (await request(app).post("/api/me/totp/setup").set(H(t)).expect(200)).body;
    await request(app).post("/api/me/totp/enable").set(H(t)).send({ code: totpCode(secret) }).expect(200);
    expect((await login({ companyCode: "SEC", email: "rep@x.com", password: "resetpass1" })).body.totpRequired).toBe(true);
    expect((await login({ companyCode: "SEC", email: "rep@x.com", password: "resetpass1", totp: totpCode(secret) })).status).toBe(200);
    await request(app).put("/api/company/security").set(H(adm)).send({ requireTotp: true, deviceBinding: true, idleMinutes: 30 }).expect(200);
    const a = await login({ companyCode: "SEC", email: "admin@x.com", password: "adminpass1" });
    expect(a.body.enrollTotp).toBe(true);
    await request(app).get("/api/users").set(H(a.body.token)).expect(403);
    await request(app).put("/api/company/security").set(H(adm)).send({ requireTotp: false, deviceBinding: true, idleMinutes: 30 }).expect(200);
  });
  it("binds a rep to one device until the admin resets it", async () => {
    const b = { companyCode: "SEC", email: "gone@x.com", password: "reppass12" };
    await login({ ...b, deviceId: "phone-A" }).expect(200);
    await login({ ...b, deviceId: "phone-B" }).expect(403);
    const id = (await request(app).get("/api/users").set(H(adm))).body.find((u: any) => u.email === "gone@x.com").id;
    await request(app).patch(`/api/users/${id}`).set(H(adm)).send({ resetDevice: true }).expect(200);
    await login({ ...b, deviceId: "phone-B" }).expect(200);
  });
  it("audit log records logins, failures, new devices and admin changes", async () => {
    await login({ companyCode: "SEC", email: "admin@x.com", password: "adminpass1" }, "10.9.9.9");
    const rows = (await request(app).get("/api/audit-log").set(H(adm)).expect(200)).body;
    const acts = rows.map((r: any) => r.action);
    for (const a of ["login.success", "login.failed", "login.locked", "login.new_device", "user.update", "user.reset_code", "company.security", "login.device_blocked"]) expect(acts).toContain(a);
  });
  it("exports data and anonymises a deleted user", async () => {
    const ex = (await request(app).get("/api/company/export").set(H(adm)).expect(200)).body;
    expect(ex.users.length).toBeGreaterThan(1); expect(ex.users[0].password_hash).toBeUndefined();
    expect((await request(app).get("/api/company/export?format=csv&table=users").set(H(adm)).expect(200)).text).toContain("email");
    const id = ex.users.find((u: any) => u.email === "gone@x.com").id;
    await request(app).delete(`/api/users/${id}`).set(H(adm)).expect(200);
    const u = (await db.query("SELECT name,email,active FROM users WHERE id=$1", [id])).rows[0];
    expect(u).toMatchObject({ name: "Deleted user", active: false }); expect(u.email).not.toContain("gone");
  });
  it("hides internal error details", async () => {
    const r = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/JSON at position|Unexpected/);
  });
  it("prunes backups to the newest 7", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bk"));
    for (let i = 1; i <= 9; i++) fs.writeFileSync(path.join(d, `db-2026-01-0${i}.sql.gz`), "x");
    expect(prune(d, 7)).toHaveLength(7); expect(fs.readdirSync(d)).not.toContain("db-2026-01-01.sql.gz");
  });
});
