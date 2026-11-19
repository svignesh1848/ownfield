process.env.TEST_ALERTS = "1";
process.env.DATA_ENCRYPTION_KEY = "test-only-key-not-secret";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { alertOwner, noteFailedLogin, checkBackupAlerts, resetAlerts, FAIL_ALERT_N } from "../src/alerts.js";

let app: any, db: any, owner: string;
const login = (body: any) => request(app).post("/api/auth/login").set("X-Forwarded-For", "10.6.6.6").send(body);
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const env = { ...process.env };
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts"));
  process.env.BACKUP_DIR = dir;
  process.env.BACKUP_RESTORE_STATUS_FILE = path.join(dir, "restore.json");
  delete process.env.SMTP_HOST;
  const { Pool } = newDb().adapters.createPg(); db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
  owner = (await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw" })).body.token;
});
afterAll(() => { process.env = env; resetAlerts(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("platform owner alerts", () => {
  it("writes an in-app notification and does not email when SMTP is not set", async () => {
    const r = await alertOwner(db, "A database backup failed", [], "disk full", null);
    expect(r.notified).toBe(true);
    expect(r.mailed).toBe("no-smtp");
    const list = (await request(app).get("/api/platform/notifications").set(H(owner)).expect(200)).body;
    expect(list[0].template).toBe("A database backup failed");
    expect(list[0].note).toBe("disk full");
    const again = await alertOwner(db, "A database backup failed", [], "disk full", null);
    expect(again.notified).toBe(false);
    expect(again.mailed).toBe("deduped");
  });

  it("alerts after repeated failed sign-ins for one account", async () => {
    for (let i = 0; i < FAIL_ALERT_N - 1; i++) await noteFailedLogin(db, "DEMO|a@x.com", "10.9.9.9", i + 1);
    const before = (await request(app).get("/api/platform/notifications").set(H(owner)).expect(200)).body.length;
    await noteFailedLogin(db, "DEMO|a@x.com", "10.9.9.9", FAIL_ALERT_N);
    const list = (await request(app).get("/api/platform/notifications").set(H(owner)).expect(200)).body;
    expect(list.length).toBeGreaterThan(before);
    expect(list.some((n: any) => n.template === "Many failed sign-ins for {0}")).toBe(true);
  });

  it("alerts on a failed restore test once", async () => {
    fs.writeFileSync(path.join(dir, "restore.json"), JSON.stringify({ at: "2026-11-19T10:00:00.000Z", ok: false, error: "table count was 2", tables: 2 }));
    await checkBackupAlerts(db);
    const list = (await request(app).get("/api/platform/notifications").set(H(owner)).expect(200)).body;
    expect(list.some((n: any) => n.template === "A backup restore test failed")).toBe(true);
    await checkBackupAlerts(db);
    const again = (await request(app).get("/api/platform/notifications").set(H(owner)).expect(200)).body
      .filter((n: any) => n.template === "A backup restore test failed");
    expect(again.length).toBe(1);
  });

  it("company users cannot read platform alerts", async () => {
    await request(app).post("/api/platform/companies").set(H(owner)).send({ code: "ALR", name: "Alert Co", userLimit: 5, admin: { email: "a@alr.com", name: "A", password: "adminpass1" } }).expect(201);
    const adm = (await login({ companyCode: "ALR", email: "a@alr.com", password: "adminpass1" })).body.token;
    await request(app).get("/api/platform/notifications").set(H(adm)).expect(403);
  });
});
