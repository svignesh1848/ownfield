// Two-step sign-in end to end with encrypted secrets, admins-only requirement, and the platform audit log.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { totpCode } from "../src/accounts.js";
import { sealField, openField, encryptConnectorSecrets } from "../src/fieldcrypt.js";

process.env.DATA_ENCRYPTION_KEY = "test-only-key-not-secret";
let app: any, db: any, owner: string, adm: string;
const login = (body: any) => request(app).post("/api/auth/login").set("X-Forwarded-For", "10.3.3.3").send(body);
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
  owner = (await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw" })).body.token;
  await request(app).post("/api/platform/companies").set(H(owner)).send({ code: "TWO", name: "Two Sample", userLimit: 9, admin: { email: "admin@t.com", name: "Admin", password: "adminpass1" } }).expect(201);
  adm = (await login({ companyCode: "TWO", email: "admin@t.com", password: "adminpass1" })).body.token;
  await request(app).post("/api/users").set(H(adm)).send({ email: "rep@t.com", name: "Rep", password: "reppass12", role: "sales_rep" }).expect(201);
});

describe("two-step sign-in", () => {
  it("field encryption round-trips and is not plain text", () => {
    const s = sealField("ABC")!; expect(s.startsWith("enc1:")).toBe(true); expect(s).not.toContain("ABC"); expect(openField(s)).toBe("ABC"); expect(openField("plain")).toBe("plain");
  });
  it("works end to end and stores the secret encrypted", async () => {
    const t = (await login({ companyCode: "TWO", email: "rep@t.com", password: "reppass12" })).body.token;
    const { secret } = (await request(app).post("/api/me/totp/setup").set(H(t)).expect(200)).body;
    const row = (await db.query("SELECT totp_secret FROM users WHERE email='rep@t.com'")).rows[0];
    expect(row.totp_secret.startsWith("enc1:")).toBe(true);
    await request(app).post("/api/me/totp/enable").set(H(t)).send({ code: totpCode(secret) }).expect(200);
    expect((await login({ companyCode: "TWO", email: "rep@t.com", password: "reppass12" })).body.totpRequired).toBe(true);
    expect((await login({ companyCode: "TWO", email: "rep@t.com", password: "reppass12", totp: "000000" })).status).toBe(401);
    expect((await login({ companyCode: "TWO", email: "rep@t.com", password: "reppass12", totp: totpCode(secret) })).status).toBe(200);
  });
  it("can be required for admins only (off by default)", async () => {
    expect((await request(app).get("/api/company/security").set(H(adm))).body.requireTotpAdmins).toBe(false);
    await request(app).post("/api/users").set(H(adm)).send({ email: "rep2@t.com", name: "Rep2", password: "reppass12", role: "sales_rep" }).expect(201);
    await request(app).put("/api/company/security").set(H(adm)).send({ requireTotpAdmins: true, idleMinutes: 30 }).expect(200);
    const a = await login({ companyCode: "TWO", email: "admin@t.com", password: "adminpass1" });
    expect(a.body.enrollTotp).toBe(true);
    await request(app).get("/api/users").set(H(a.body.token)).expect(403);
    const r = await login({ companyCode: "TWO", email: "rep2@t.com", password: "reppass12" });
    expect(r.body.enrollTotp).toBeUndefined();
    await request(app).put("/api/company/security").set(H(adm)).send({ requireTotpAdmins: false, idleMinutes: 30 }).expect(200);
  });
  it("platform owner sees the audit log across companies; admins cannot", async () => {
    const rows = (await request(app).get("/api/platform/audit-log").set(H(owner)).expect(200)).body;
    const acts = rows.map((r: any) => r.action);
    for (const a of ["platform.company_create", "login.success", "login.failed", "user.create", "company.security", "user.totp_enabled"]) expect(acts).toContain(a);
    await request(app).get("/api/platform/audit-log").set(H(adm)).expect(403);
  });

  it("encrypts connector passwords on write and migrates legacy plaintext", async () => {
    await request(app).post("/api/integrations/connectors").set(H(adm)).send({ type: "custom-rest", name: "Secret box" }).expect(201);
    const c = (await request(app).post("/api/integrations/connectors").set(H(adm)).send({ type: "custom-rest", name: "ERP" }).expect(201)).body;
    await request(app).patch(`/api/integrations/connectors/${c.id}`).set(H(adm)).send({ config: { password: "plain-pass", apiKey: "plain-key" } }).expect(200);
    const row = (await db.query("SELECT config FROM connectors WHERE id=$1", [c.id])).rows[0];
    const stored = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    expect(stored.password.startsWith("enc1:")).toBe(true);
    expect(stored.apiKey.startsWith("enc1:")).toBe(true);
    expect(stored.password).not.toContain("plain-pass");
    const listed = (await request(app).get("/api/integrations/connectors").set(H(adm)).expect(200)).body.connectors.find((x: any) => x.id === c.id);
    expect(listed.config.password).toBe("******");
    // Legacy plaintext row is accepted and migrated.
    await db.query("UPDATE connectors SET config=$1 WHERE id=$2", [JSON.stringify({ password: "legacy-secret", baseUrl: "https://example.com" }), c.id]);
    const mig = await encryptConnectorSecrets(db);
    expect(mig.updated).toBeGreaterThan(0);
    const raw = (await db.query("SELECT config FROM connectors WHERE id=$1", [c.id])).rows[0].config;
    const after = typeof raw === "string" ? JSON.parse(raw) : raw;
    expect(after.password.startsWith("enc1:")).toBe(true);
    expect(openField(after.password)).toBe("legacy-secret");
    expect(after.baseUrl).toBe("https://example.com");
  });
});
