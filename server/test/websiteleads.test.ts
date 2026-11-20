import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";

let app: any, db: any;
const lead = { kind: "demo", name: "Test Person", company: "Test Co", email: "test@example.com", phone: "+91 90000 00000", size: "11-50", industry: "Other", message: "hi" };
beforeAll(async () => {
  process.env.WEBSITE_LEAD_RATE_MAX = "3";
  delete process.env.LEAD_NOTIFY_EMAIL;
  delete process.env.SMTP_HOST;
  const { Pool } = newDb().adapters.createPg();
  db = new Pool(); await migrate(db);
  await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
});

describe("website leads", () => {
  it("stores a valid lead sent as text/plain JSON, with CORS for the website, and only the platform owner can list", async () => {
    const r = await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.1").set("Origin", "https://www.ownfield.in").set("Content-Type", "text/plain").send(JSON.stringify(lead)).expect(201);
    expect(r.headers["access-control-allow-origin"]).toBe("https://www.ownfield.in");
    const rows = (await db.query("SELECT * FROM website_leads")).rows; expect(rows.length).toBe(1); expect(rows[0].company).toBe("Test Co");
    const notes = (await db.query("SELECT template, args, note FROM notifications WHERE company_id IS NULL")).rows;
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n: any) => String(n.template).includes("website lead"))).toBe(true);
    await request(app).get("/api/platform/leads").expect(401);
  });
  it("accepts the simplified 3-field payload (name, email or phone contact, team size) without company or industry", async () => {
    const emailLead = { name: "Asha", contact: "asha@example.com", size: "1-10", message: "pilot" };
    await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.11").set("Content-Type", "text/plain").send(JSON.stringify(emailLead)).expect(201);
    const phoneLead = { kind: "trial", name: "Ravi Kumar", contact: "+91 98765 43210", size: "51-200" };
    await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.12").set("Content-Type", "text/plain").send(JSON.stringify(phoneLead)).expect(201);
    const rows = (await db.query("SELECT name,email,phone,company,industry,team_size FROM website_leads WHERE name IN ('Asha','Ravi Kumar') ORDER BY name")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].email).toBe("asha@example.com"); expect(rows[0].phone).toBe(""); expect(rows[0].company).toBe("");
    expect(rows[1].phone).toBe("+91 98765 43210"); expect(rows[1].email).toBe(""); expect(rows[1].team_size).toBe("51-200");
  });
  it("validates fields and rejects honeypot", async () => {
    const ip = "9.9.9.2";
    expect((await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send({ ...lead, email: "bad" }).expect(400)).body.field).toBe("email");
    expect((await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send({ name: "Jo", contact: "not-a-contact", size: "1-10" }).expect(400)).body.field).toBe("contact");
    expect((await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send({ ...lead, kind: "x" }).expect(400)).body.field).toBe("kind");
    await request(app).post("/api/public/website-leads").set("X-Forwarded-For", "9.9.9.3").send({ ...lead, website: "spam" }).expect(400);
  });
  it("rate limits per IP", async () => {
    const ip = "9.9.9.4";
    for (let i = 0; i < 3; i++) await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send(lead).expect(201);
    const r = await request(app).post("/api/public/website-leads").set("X-Forwarded-For", ip).send(lead).expect(429);
    expect(String(r.body.error)).not.toMatch(/@/);
  });
});
