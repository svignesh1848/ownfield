import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { uploadToS3, needsCatchUp, backupStatus } from "../src/backup.js";

let app: any, owner: string, adm: string, dir: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = (b: any) => request(app).post("/api/auth/login").send(b);
const env = { ...process.env };

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bkst"));
  process.env.BACKUP_DIR = dir; process.env.BACKUP_RESTORE_STATUS_FILE = path.join(dir, "restore.json");
  const { Pool } = newDb().adapters.createPg(); const db = new Pool();
  await migrate(db); await ensurePlatformOwner(db, "owner@example.com", "pw");
  app = createApp(db, "test");
  owner = (await login({ companyCode: "PLATFORM", email: "owner@example.com", password: "pw" })).body.token;
  await request(app).post("/api/platform/companies").set(H(owner)).send({ code: "BKP", name: "Bk Sample", userLimit: 5, admin: { email: "a@bk.com", name: "A", password: "adminpass1" } }).expect(201);
  adm = (await login({ companyCode: "BKP", email: "a@bk.com", password: "adminpass1" })).body.token;
});
afterAll(() => { process.env = env; fs.rmSync(dir, { recursive: true, force: true }); });

describe("backup status", () => {
  it("is platform-owner only", async () => {
    await request(app).get("/api/platform/backup-status").expect(401);
    await request(app).get("/api/platform/backup-status").set(H(adm)).expect(403);
  });
  it("reports last run, S3 upload and restore test without secrets", async () => {
    process.env.BACKUP_S3_BUCKET = "test-bucket"; process.env.BACKUP_PASSPHRASE = "very-secret-pass";
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ lastAttemptAt: "2026-11-11T08:00:00.000Z", lastBackupAt: "2026-11-11T08:00:05.000Z", file: "db-2026-11-11.sql.gz", bytes: 1234,
      s3: { bucket: "test-bucket", ok: true, key: "fieldforce/db-2026-11-11.sql.gz", at: "2026-11-11T08:00:09.000Z" }, lastS3OkAt: "2026-11-11T08:00:09.000Z", lastS3OkKey: "fieldforce/db-2026-11-11.sql.gz" }));
    fs.writeFileSync(path.join(dir, "restore.json"), JSON.stringify({ at: "2026-11-11T14:00:00+05:30", key: "fieldforce/db-2026-11-11.sql.gz", s3Bytes: 1234, ok: true, tables: 60, errors: 0, error: "" }));
    const r = await request(app).get("/api/platform/backup-status").set(H(owner)).expect(200);
    expect(r.body).toMatchObject({ s3Configured: true, bucket: "test-bucket", encrypted: true, bytes: 1234, s3Upload: { ok: true, key: "fieldforce/db-2026-11-11.sql.gz" }, restoreTest: { ok: true, tables: 60 } });
    expect(JSON.stringify(r.body)).not.toContain("very-secret-pass");
    delete process.env.BACKUP_PASSPHRASE;
  });
  it("is empty but valid before any backup", () => {
    fs.rmSync(path.join(dir, "status.json")); fs.rmSync(path.join(dir, "restore.json"));
    expect(backupStatus()).toMatchObject({ lastBackupAt: null, s3Upload: null, restoreTest: null });
  });
});

describe("S3 upload + catch-up", () => {
  it("reports ok, failure and a missing aws CLI", async () => {
    const f = path.join(dir, "db-2026-11-11.sql.gz"); fs.writeFileSync(f, "x");
    expect(await uploadToS3(f, "b", "true")).toEqual({ ok: true, key: "fieldforce/db-2026-11-11.sql.gz" });
    expect((await uploadToS3(f, "b", "false")).ok).toBe(false);
    expect(await uploadToS3(f, "b", "no-such-aws-cli-xyz")).toMatchObject({ ok: false, error: "aws CLI not installed" });
  });
  it("runs once after a deploy only when S3 got nothing today", () => {
    process.env.BACKUP_S3_BUCKET = "b";
    const now = new Date("2026-11-11T10:00:00");
    expect(needsCatchUp(now, null)).toBe(true);
    expect(needsCatchUp(now, { lastS3OkAt: new Date("2026-11-11T03:00:00").toISOString() })).toBe(false);
    expect(needsCatchUp(now, { lastS3OkAt: new Date("2026-11-10T03:00:00").toISOString(), lastAttemptAt: new Date("2026-11-11T09:30:00").toISOString() })).toBe(false);
    expect(needsCatchUp(now, { lastS3OkAt: new Date("2026-11-10T03:00:00").toISOString(), lastAttemptAt: new Date("2026-11-11T07:00:00").toISOString() })).toBe(true);
    delete process.env.BACKUP_S3_BUCKET; expect(needsCatchUp(now, null)).toBe(false);
  });
});
