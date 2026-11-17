// Platform owner is required to set up two-step sign-in, but can sign in and reach the setup routes.
process.env.TEST_REQUIRE_OWNER_TOTP = "1";
process.env.DATA_ENCRYPTION_KEY = "test-only-key-not-secret";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { totpCode } from "../src/accounts.js";

let app: any;
const login = (body: any) => request(app).post("/api/auth/login").set("X-Forwarded-For", "10.5.5.5").send(body);
const H = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg(); const db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
});

describe("platform owner two-step", () => {
  it("lets them sign in and set it up, then requires it and blocks turning it off", async () => {
    const first = await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw" });
    expect(first.status).toBe(200);
    expect(first.body.enrollTotp).toBe(true);
    const denied = await request(app).get("/api/platform/companies").set(H(first.body.token));
    expect(denied.status).toBe(403);
    expect(denied.body.enrollTotp).toBe(true);
    await request(app).get("/api/me").set(H(first.body.token)).expect(200);
    const { secret } = (await request(app).post("/api/me/totp/setup").set(H(first.body.token)).expect(200)).body;
    await request(app).post("/api/me/totp/enable").set(H(first.body.token)).send({ code: totpCode(secret) }).expect(200);
    const again = await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw", totp: totpCode(secret) });
    expect(again.status).toBe(200);
    expect(again.body.enrollTotp).toBeUndefined();
    await request(app).get("/api/platform/companies").set(H(again.body.token)).expect(200);
    const off = await request(app).post("/api/me/totp/disable").set(H(again.body.token)).send({ code: totpCode(secret) });
    expect(off.status).toBe(403);
  });
});
