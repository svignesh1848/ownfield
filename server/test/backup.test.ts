import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { newDb } from "pg-mem";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { gzipSync } from "node:zlib";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { uploadToS3, needsCatchUp, backupStatus, contentHashFromGzip, shouldSkipBackup, settleBackup, SKIP_REASON, SKIP_MAX_AGE_MS } from "../src/backup.js";

let app: any, owner: string, adm: string, dir: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = (b: any) => request(app).post("/api/auth/login").send(b);
const env = { ...process.env };

function dumpSql(started: string, completed: string, body: string) {
  return `--\n-- PostgreSQL database dump\n--\n\n-- Started on ${started}\n\n${body}\n\n-- Completed on ${completed}\n`;
}
function writeDump(file: string, started: string, completed: string, body: string) {
  fs.writeFileSync(file, gzipSync(dumpSql(started, completed, body)));
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bkst"));
  process.env.BACKUP_DIR = dir; process.env.BACKUP_RESTORE_STATUS_FILE = path.join(dir, "restore.json");
  delete process.env.BACKUP_S3_BUCKET; delete process.env.BACKUP_PASSPHRASE;
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
      lastResult: "ok", contentHash: "abc123secretish", lastSkipAt: null,
      s3: { bucket: "test-bucket", ok: true, key: "fieldforce/db-2026-11-11.sql.gz", at: "2026-11-11T08:00:09.000Z" }, lastS3OkAt: "2026-11-11T08:00:09.000Z", lastS3OkKey: "fieldforce/db-2026-11-11.sql.gz" }));
    fs.writeFileSync(path.join(dir, "restore.json"), JSON.stringify({ at: "2026-11-11T14:00:00+05:30", key: "fieldforce/db-2026-11-11.sql.gz", s3Bytes: 1234, ok: true, tables: 60, errors: 0, error: "" }));
    const r = await request(app).get("/api/platform/backup-status").set(H(owner)).expect(200);
    expect(r.body).toMatchObject({ s3Configured: true, bucket: "test-bucket", encrypted: true, bytes: 1234, lastResult: "ok", s3Upload: { ok: true, key: "fieldforce/db-2026-11-11.sql.gz" }, restoreTest: { ok: true, tables: 60 } });
    expect(JSON.stringify(r.body)).not.toContain("very-secret-pass");
    expect(JSON.stringify(r.body)).not.toContain("abc123secretish");
    expect(r.body.contentHash).toBeUndefined();
    delete process.env.BACKUP_PASSPHRASE;
  });
  it("reports a skip without secrets or a content hash", async () => {
    process.env.BACKUP_S3_BUCKET = "test-bucket";
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ lastAttemptAt: "2026-11-12T08:00:00.000Z", lastBackupAt: "2026-11-11T08:00:05.000Z", lastSkipAt: "2026-11-12T08:00:01.000Z",
      lastResult: SKIP_REASON, file: "db-2026-11-11.sql.gz", bytes: 1234, contentHash: "do-not-leak-this-hash", lastError: null,
      s3: { bucket: "test-bucket", ok: true, key: "fieldforce/db-2026-11-11.sql.gz", at: "2026-11-11T08:00:09.000Z" }, lastS3OkAt: "2026-11-11T08:00:09.000Z", lastS3OkKey: "fieldforce/db-2026-11-11.sql.gz" }));
    const r = await request(app).get("/api/platform/backup-status").set(H(owner)).expect(200);
    expect(r.body).toMatchObject({ lastResult: "skipped (no changes)", lastSkipAt: "2026-11-12T08:00:01.000Z", lastBackupAt: "2026-11-11T08:00:05.000Z" });
    expect(JSON.stringify(r.body)).not.toContain("do-not-leak-this-hash");
  });
  it("is empty but valid before any backup", () => {
    fs.rmSync(path.join(dir, "status.json"), { force: true }); fs.rmSync(path.join(dir, "restore.json"), { force: true });
    expect(backupStatus()).toMatchObject({ lastBackupAt: null, lastSkipAt: null, lastResult: null, s3Upload: null, restoreTest: null });
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
    expect(needsCatchUp(now, { lastS3OkAt: new Date("2026-11-10T03:00:00").toISOString(), lastSkipAt: new Date("2026-11-11T08:00:00").toISOString() })).toBe(false);
    expect(needsCatchUp(now, { lastS3OkAt: new Date("2026-11-10T03:00:00").toISOString(), lastSkipAt: new Date("2026-11-10T08:00:00").toISOString(), lastAttemptAt: new Date("2026-11-10T08:00:00").toISOString() })).toBe(true);
    delete process.env.BACKUP_S3_BUCKET; expect(needsCatchUp(now, null)).toBe(false);
  });
});

describe("unchanged-backup skip", () => {
  it("hashes two dumps the same when only the timestamp lines differ", async () => {
    const a = path.join(dir, "a.sql.gz"), b = path.join(dir, "b.sql.gz"), c = path.join(dir, "c.sql.gz");
    writeDump(a, "2026-11-11 02:30:00 IST", "2026-11-11 02:30:04 IST", "COPY public.shops FROM stdin;\n1\tBaby shop\n\\.");
    writeDump(b, "2026-11-12 02:30:00 IST", "2026-11-12 02:30:03 IST", "COPY public.shops FROM stdin;\n1\tBaby shop\n\\.");
    writeDump(c, "2026-11-12 02:30:00 IST", "2026-11-12 02:30:03 IST", "COPY public.shops FROM stdin;\n1\tOther shop\n\\.");
    const ha = await contentHashFromGzip(a), hb = await contentHashFromGzip(b), hc = await contentHashFromGzip(c);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips only when the hash matches, the last copy is under 7 days old, and S3 (if set) already has it", () => {
    const now = new Date("2026-11-11T10:00:00Z");
    const recent = "2026-11-09T02:30:00.000Z";
    const stale = new Date(now.getTime() - SKIP_MAX_AGE_MS).toISOString();
    const base = { contentHash: "aaa", lastHash: "aaa", lastBackupAt: recent, lastS3OkAt: recent, lastS3Ok: true, now };
    expect(shouldSkipBackup({ ...base, s3Configured: false })).toBe(true);
    expect(shouldSkipBackup({ ...base, lastHash: "bbb", s3Configured: false })).toBe(false);
    expect(shouldSkipBackup({ ...base, lastHash: undefined, s3Configured: false })).toBe(false);
    expect(shouldSkipBackup({ ...base, lastBackupAt: stale, s3Configured: false })).toBe(false);
    expect(shouldSkipBackup({ ...base, lastBackupAt: null, s3Configured: false })).toBe(false);
    expect(shouldSkipBackup({ ...base, s3Configured: true })).toBe(true);
    expect(shouldSkipBackup({ ...base, s3Configured: true, lastS3OkAt: null })).toBe(false);
    expect(shouldSkipBackup({ ...base, s3Configured: true, lastS3Ok: false })).toBe(false);
  });

  it("saves the first dump, skips an identical later dump, and keeps a weekly safety-net copy", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "bkskip"));
    const prevDir = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = work;
    delete process.env.BACKUP_S3_BUCKET; delete process.env.BACKUP_PASSPHRASE;
    try {
      const tmp1 = path.join(work, ".tmp-1.sql.gz");
      writeDump(tmp1, "2026-11-11 02:30:00 IST", "2026-11-11 02:30:04 IST", "COPY public.shops FROM stdin;\n1\tBaby shop\n\\.");
      const kept = await settleBackup(tmp1, "2026-11-11T02:30:00.000Z", path.join(work, "db-2026-11-11.sql.gz"));
      expect(kept).toBe(path.join(work, "db-2026-11-11.sql.gz"));
      expect(fs.existsSync(kept)).toBe(true);
      expect(fs.existsSync(tmp1)).toBe(false);
      const status1 = JSON.parse(fs.readFileSync(path.join(work, "status.json"), "utf8"));
      expect(status1.lastResult).toBe("ok");
      expect(status1.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const bytes = status1.bytes;

      const tmp2 = path.join(work, ".tmp-2.sql.gz");
      writeDump(tmp2, "2026-11-12 02:30:00 IST", "2026-11-12 02:30:03 IST", "COPY public.shops FROM stdin;\n1\tBaby shop\n\\.");
      expect(await settleBackup(tmp2, "2026-11-12T02:30:00.000Z", path.join(work, "db-2026-11-12.sql.gz"))).toBe(SKIP_REASON);
      expect(fs.existsSync(tmp2)).toBe(false);
      expect(fs.existsSync(path.join(work, "db-2026-11-12.sql.gz"))).toBe(false);
      expect(fs.readdirSync(work).filter(f => /^db-.*\.sql\.gz$/.test(f))).toEqual(["db-2026-11-11.sql.gz"]);
      const status2 = JSON.parse(fs.readFileSync(path.join(work, "status.json"), "utf8"));
      expect(status2.lastResult).toBe(SKIP_REASON);
      expect(status2.lastSkipAt).toBeTruthy();
      expect(status2.lastBackupAt).toBe(status1.lastBackupAt);
      expect(status2.file).toBe("db-2026-11-11.sql.gz");
      expect(status2.bytes).toBe(bytes);
      expect(status2.contentHash).toBe(status1.contentHash);
      expect(status2.lastError).toBe(null);

      status2.lastBackupAt = new Date(Date.now() - SKIP_MAX_AGE_MS - 1000).toISOString();
      fs.writeFileSync(path.join(work, "status.json"), JSON.stringify(status2));
      const tmp3 = path.join(work, ".tmp-3.sql.gz");
      writeDump(tmp3, "2026-11-18 02:30:00 IST", "2026-11-18 02:30:03 IST", "COPY public.shops FROM stdin;\n1\tBaby shop\n\\.");
      const safety = await settleBackup(tmp3, "2026-11-18T02:30:00.000Z", path.join(work, "db-2026-11-18.sql.gz"));
      expect(safety).toBe(path.join(work, "db-2026-11-18.sql.gz"));
      expect(fs.existsSync(safety)).toBe(true);
      const status3 = JSON.parse(fs.readFileSync(path.join(work, "status.json"), "utf8"));
      expect(status3.lastResult).toBe("ok");
      expect(status3.file).toBe("db-2026-11-18.sql.gz");
    } finally {
      process.env.BACKUP_DIR = prevDir;
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not skip when S3 is configured but the last saved copy never uploaded", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "bkskips3"));
    const prevDir = process.env.BACKUP_DIR, prevBucket = process.env.BACKUP_S3_BUCKET;
    process.env.BACKUP_DIR = work;
    delete process.env.BACKUP_S3_BUCKET; delete process.env.BACKUP_PASSPHRASE;
    try {
      const tmp1 = path.join(work, ".tmp-1.sql.gz");
      writeDump(tmp1, "2026-11-11 02:30:00 IST", "2026-11-11 02:30:04 IST", "COPY public.orders FROM stdin;\n1\t100\n\\.");
      await settleBackup(tmp1, "2026-11-11T02:30:00.000Z", path.join(work, "db-2026-11-11.sql.gz"));
      const status = JSON.parse(fs.readFileSync(path.join(work, "status.json"), "utf8"));
      status.s3 = { bucket: "b", ok: false, key: "fieldforce/db-2026-11-11.sql.gz", at: "2026-11-11T02:30:08.000Z", error: "aws exited 1" };
      fs.writeFileSync(path.join(work, "status.json"), JSON.stringify(status));
      process.env.BACKUP_S3_BUCKET = "b";
      const tmp2 = path.join(work, ".tmp-2.sql.gz");
      writeDump(tmp2, "2026-11-12 02:30:00 IST", "2026-11-12 02:30:03 IST", "COPY public.orders FROM stdin;\n1\t100\n\\.");
      const again = await settleBackup(tmp2, "2026-11-12T02:30:00.000Z", path.join(work, "db-2026-11-12.sql.gz"));
      // Upload will fail (no real aws / test bucket) but the copy must still be kept, not skipped.
      expect(again).toBe(path.join(work, "db-2026-11-12.sql.gz"));
      expect(fs.existsSync(again)).toBe(true);
      const status2 = JSON.parse(fs.readFileSync(path.join(work, "status.json"), "utf8"));
      expect(status2.lastResult).toBe("ok");
      expect(status2.s3.ok).toBe(false);
    } finally {
      process.env.BACKUP_DIR = prevDir;
      if (prevBucket === undefined) delete process.env.BACKUP_S3_BUCKET; else process.env.BACKUP_S3_BUCKET = prevBucket;
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
