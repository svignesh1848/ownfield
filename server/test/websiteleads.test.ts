import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, db: any;
const lead = { kind: "demo", name: "Test Person", company: "Test Co", email: "test@example.com", phone: "+91 90000 00000", size: "11-50", industry: "Other", message: "hi" };
beforeAll(async () => {
  process.env.WEBSITE_LEAD_RATE_MAX = "3";
  const { Pool } = newDb().adapters.createPg();
  db = new Pool(); await migrate(db);
  app = createApp(db, "test");
});

describe("website leads", () => {
  it("stores a valid lead sent as text/plain JSON, with CORS for the website, and only the platform owner can list", async () => {
    const r = await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.1").set("Origin", "https://www.ownfield.in").set("Content-Type", "text/plain").send(JSON.stringify(lead)).expect(201);
    expect(r.headers["access-control-allow-origin"]).toBe("https://www.ownfield.in");
    const rows = (await db.query("SELECT * FROM website_leads")).rows; expect(rows.length).toBe(1); expect(rows[0].company).toBe("Test Co");
    await request(app).get("/api/platform/leads").expect(401);
  });
  it("validates fields and rejects honeypot", async () => {
    const ip = "9.9.9.2";
    expect((await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send({ ...lead, email: "bad" }).expect(400)).body.field).toBe("email");
    expect((await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send({ ...lead, kind: "x" }).expect(400)).body.field).toBe("kind");
    await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.3").send({ ...lead, website: "spam" }).expect(400);
  });
  it("rate limits per IP", async () => {
    const ip = "9.9.9.4";
    for (let i = 0; i < 3; i++) await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send(lead).expect(201);
    await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send(lead).expect(429);
  });
});
