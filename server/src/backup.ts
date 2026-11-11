// Nightly gzip pg_dump, run by the app itself (so it ships with self-update; no cron needed on the server).
// Keeps the newest BACKUP_KEEP (7) files in BACKUP_DIR (default ~/backups). Optional S3 copy only if BACKUP_S3_BUCKET
// is set and the aws CLI is installed (uses the instance role; nothing is created here). Each run writes a small
// status file (no secrets) that the platform owner can read at GET /api/platform/backup-status.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const backupDir = () => process.env.BACKUP_DIR || path.join(os.homedir(), "backups");
const statusFile = () => path.join(backupDir(), "status.json");
// Written by deploy/backup-restore-test.sh (root) after it restores the newest S3 copy into a scratch database.
const restoreFile = () => process.env.BACKUP_RESTORE_STATUS_FILE || "/var/lib/fieldforce-oss-backup/restore-test.json";
export function prune(dir: string, keep: number) {
  const files = fs.readdirSync(dir).filter(f => /^db-.*\.sql\.gz(\.enc)?$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  return files.slice(-keep);
}
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeStatus = (s: any) => { try { fs.writeFileSync(statusFile(), JSON.stringify(s), { mode: 0o600 }); } catch { /* status is best effort */ } };
// One short line. aws/pg_dump errors carry no credentials (instance role, password only in env).
export const shortErr = (e: string) => e.replace(/\s+/g, " ").replace(/\b\d{12}\b/g, "<account>").trim().slice(0, 200);

/** Copy one file to s3://bucket/fieldforce/<name>. Resolves (never rejects) with ok/error. */
export function uploadToS3(file: string, bucket: string, cmd = "aws"): Promise<{ ok: boolean; key: string; error?: string }> {
  const key = `fieldforce/${path.basename(file)}`;
  return new Promise(resolve => {
    let err = "", done = false; const end = (r: { ok: boolean; key: string; error?: string }) => { if (!done) { done = true; resolve(r); } };
    const p = spawn(cmd, ["s3", "cp", "--only-show-errors", "--no-progress", file, `s3://${bucket}/${key}`], { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", d => { err += d; });
    p.on("error", (e: any) => end({ ok: false, key, error: e.code === "ENOENT" ? "aws CLI not installed" : shortErr(e.message) }));
    p.on("close", code => end(code === 0 ? { ok: true, key } : { ok: false, key, error: shortErr(err) || `aws exited ${code}` }));
  });
}

export function runBackup(url = process.env.DATABASE_URL!): Promise<string> {
  const dir = backupDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pass = process.env.BACKUP_PASSPHRASE; // set it to encrypt backups (AES-256, openssl); keep a copy of it off the server
  const file = path.join(dir, `db-${new Date().toISOString().slice(0, 10)}.sql.gz${pass ? ".enc" : ""}`);
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const sh = spawn("sh", ["-c", 'nice -n 19 pg_dump --no-owner --dbname="$DBURL" | gzip -6' + (pass ? ' | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BKPASS' : '')],
      { env: { PATH: process.env.PATH, DBURL: url, ...(pass ? { BKPASS: pass } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let err = ""; sh.stderr.on("data", d => { err += d; }); sh.stdout.pipe(out);
    sh.on("close", code => out.close(async () => {
      if (code !== 0 || err.trim()) {
        fs.rmSync(file, { force: true });
        writeStatus({ ...(readJson(statusFile()) || {}), lastAttemptAt: startedAt, lastError: shortErr(`pg_dump failed: ${err || code}`) });
        return reject(new Error(`pg_dump failed: ${err.trim() || code}`));
      }
      prune(dir, Number(process.env.BACKUP_KEEP || 7));
      const bytes = fs.statSync(file).size, bucket = process.env.BACKUP_S3_BUCKET;
      const s3 = bucket ? { bucket, ...(await uploadToS3(file, bucket)), at: new Date().toISOString() } : null;
      if (s3 && !s3.ok) console.error("backup: S3 upload failed:", s3.error);
      const prev = readJson(statusFile()) || {};
      writeStatus({ lastAttemptAt: startedAt, lastBackupAt: new Date().toISOString(), file: path.basename(file), bytes, encrypted: !!pass, lastError: null,
        s3, lastS3OkAt: s3?.ok ? s3.at : prev.lastS3OkAt ?? null, lastS3OkKey: s3?.ok ? s3.key : prev.lastS3OkKey ?? null });
      resolve(file);
    }));
  });
}

/** Read-only status for the platform owner (no secrets, no data). */
export function backupStatus() {
  const s = readJson(statusFile()), r = readJson(restoreFile());
  return {
    s3Configured: !!process.env.BACKUP_S3_BUCKET, bucket: process.env.BACKUP_S3_BUCKET || null, encrypted: !!process.env.BACKUP_PASSPHRASE,
    lastAttemptAt: s?.lastAttemptAt ?? null, lastBackupAt: s?.lastBackupAt ?? null, file: s?.file ?? null, bytes: s?.bytes ?? null, lastError: s?.lastError ?? null,
    s3Upload: s?.s3 ? { ok: !!s.s3.ok, key: s.s3.key, at: s.s3.at, error: s.s3.error ?? null } : null,
    lastS3OkAt: s?.lastS3OkAt ?? null, lastS3OkKey: s?.lastS3OkKey ?? null,
    restoreTest: r ? { at: r.at ?? null, key: r.key ?? null, s3Bytes: r.s3Bytes ?? null, ok: !!r.ok, tables: r.tables ?? null, errors: r.errors ?? null, error: r.error ?? null } : null,
  };
}

/** True when S3 is set up but nothing reached S3 today (local date) and no attempt in the last hour. */
export function needsCatchUp(now = new Date(), s = readJson(statusFile())) {
  if (!process.env.BACKUP_S3_BUCKET) return false;
  const day = (t: string | Date) => new Date(t).toLocaleDateString("en-CA");
  if (s?.lastS3OkAt && day(s.lastS3OkAt) === day(now)) return false;
  if (s?.lastAttemptAt && now.getTime() - new Date(s.lastAttemptAt).getTime() < 3600_000) return false;
  return true;
}

/** Schedule daily at BACKUP_HOUR (local time, default 2). After a deploy/restart, also run once if S3 got nothing today. */
export function scheduleBackups() {
  if (process.env.BACKUP_DISABLED === "1" || !process.env.DATABASE_URL) return;
  const run = () => runBackup().then(f => console.log("backup ok:", f)).catch(e => console.error("backup:", e.message));
  const next = () => { const n = new Date(), t = new Date(n); t.setHours(Number(process.env.BACKUP_HOUR ?? 2), 30, 0, 0); if (t <= n) t.setDate(t.getDate() + 1); return t.getTime() - n.getTime(); };
  const tick = () => setTimeout(() => { run().finally(tick); }, next()).unref();
  tick();
  if (needsCatchUp()) setTimeout(run, 120_000).unref();
}
