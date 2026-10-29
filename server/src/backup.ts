// Nightly gzip pg_dump, run by the app itself (so it ships with self-update; no cron needed on the server).
// Keeps the newest BACKUP_KEEP (7) files in BACKUP_DIR (default ~/backups). Optional S3 copy only if BACKUP_S3_BUCKET
// is set and the aws CLI is installed (uses the instance role; nothing is created here).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const backupDir = () => process.env.BACKUP_DIR || path.join(os.homedir(), "backups");
export function prune(dir: string, keep: number) {
  const files = fs.readdirSync(dir).filter(f => /^db-.*\.sql\.gz$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
  return files.slice(-keep);
}
export function runBackup(url = process.env.DATABASE_URL!): Promise<string> {
  const dir = backupDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `db-${new Date().toISOString().slice(0, 10)}.sql.gz`);
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    const sh = spawn("sh", ["-c", 'nice -n 19 pg_dump --no-owner --dbname="$DBURL" | gzip -6'], { env: { PATH: process.env.PATH, DBURL: url }, stdio: ["ignore", "pipe", "pipe"] });
    let err = ""; sh.stderr.on("data", d => { err += d; }); sh.stdout.pipe(out);
    sh.on("close", code => out.close(() => {
      if (code !== 0 || err.trim()) { fs.rmSync(file, { force: true }); return reject(new Error(`pg_dump failed: ${err.trim() || code}`)); }
      prune(dir, Number(process.env.BACKUP_KEEP || 7));
      const bucket = process.env.BACKUP_S3_BUCKET;
      if (bucket) spawn("aws", ["s3", "cp", "--only-show-errors", file, `s3://${bucket}/fieldforce/${path.basename(file)}`], { stdio: "inherit" })
        .on("error", e => console.error("backup: S3 upload skipped:", e.message));
      resolve(file);
    }));
  });
}
/** Schedule daily at BACKUP_HOUR (local time, default 2). */
export function scheduleBackups() {
  if (process.env.BACKUP_DISABLED === "1" || !process.env.DATABASE_URL) return;
  const next = () => { const n = new Date(), t = new Date(n); t.setHours(Number(process.env.BACKUP_HOUR ?? 2), 30, 0, 0); if (t <= n) t.setDate(t.getDate() + 1); return t.getTime() - n.getTime(); };
  const tick = () => setTimeout(() => { runBackup().then(f => console.log("backup ok:", f)).catch(e => console.error("backup:", e.message)).finally(tick); }, next()).unref();
  tick();
}
