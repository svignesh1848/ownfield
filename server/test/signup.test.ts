import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, passwordProblem, FREE_PLAN_USER_LIMIT } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any;
const base = { companyName: "Sample Traders", companyCode: "SAMPLE1", industry: "fmcg", adminName: "Asha", email: "asha@example.com", password: "goodpass1", consent: true };
beforeAll(async () => {
  process.env.SIGNUP_RATE_MAX = "4";
  const { Pool } = newDb().adapters.createPg();
  const db = new Pool(); await migrate(db);
  app = createApp(db, "test");
});

describe("self sign-up", () => {
  it("password rule", () => {
    expect(passwordProblem("short1")).toMatch(/8/);
    expect(passwordProblem("onlyletters")).toMatch(/number/);
    expect(passwordProblem("letters123")).toBeNull();
  });
  it("creates free-plan company + admin and logs in", async () => {
    const r = await request(app).post("/api/signup").set("X-Forwarded-For", "1.1.1.1").send(base).expect(201);
    expect(r.body.user.role).toBe("company_admin");
    expect(r.body.user.companyCode).toBe("SAMPLE1");
    const u = await request(app).get("/api/company/usage").set("Authorization", `Bearer ${r.body.token}`).expect(200);
    expect(u.body.limit).toBe(FREE_PLAN_USER_LIMIT); expect(u.body.count).toBe(1);
    await request(app).post("/api/auth/login").send({ companyCode: "sample1", email: base.email, password: base.password }).expect(200);
  });
  it("rejects duplicates, bad input, and suggests codes", async () => {
    const ip = "2.2.2.2";
    expect((await request(app).post("/api/signup").set("X-Forwarded-For", ip).send({ ...base, email: "new@example.com" }).expect(409)).body.field).toBe("companyCode");
    expect((await request(app).post("/api/signup").set("X-Forwarded-For", ip).send({ ...base, companyCode: "OTHER1" }).expect(409)).body.field).toBe("email");
    expect((await request(app).post("/api/signup").set("X-Forwarded-For", ip).send({ ...base, companyCode: "a b", email: "x@example.com" }).expect(400)).body.field).toBe("companyCode");
    expect((await request(app).post("/api/signup").set("X-Forwarded-For", "3.3.3.3").send({ ...base, companyCode: "OTHER2", password: "weak" }).expect(400)).body.field).toBe("password");
    const c = await request(app).get("/api/signup/check-code?code=sample1").expect(200);
    expect(c.body.available).toBe(false); expect(c.body.suggestion).toBe("SAMPLE12");
    expect((await request(app).get("/api/signup/check-code?name=Blue%20Sky%20Ltd").expect(200)).body).toMatchObject({ code: "BLUESKYLTD", available: true });
  });
  it("rate limits per IP", async () => {
    for (let i = 0; i < 4; i++) await request(app).post("/api/signup").set("X-Forwarded-For", "9.9.9.9").send({});
    await request(app).post("/api/signup").set("X-Forwarded-For", "9.9.9.9").send({}).expect(429);
    await request(app).post("/api/signup").set("X-Forwarded-For", "8.8.8.8").send({}).expect(400);
  });
});
