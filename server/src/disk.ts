// Low-disk check + temp cleanup. Small servers (e.g. 8 GB) fill up quietly; this warns admins and logs
// when free space drops below DISK_ALERT_PCT (default 15%). Cleanup only touches OwnField's own temp folder
// (TEMP_DIR, default <os tmp>/ownfield) — never user photos, uploads, backups or the database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadDir } from "./storage.js";

export const tempDir = () => process.env.TEMP_DIR || path.join(os.tmpdir(), "ownfield");
export const alertPct = () => Number(process.env.DISK_ALERT_PCT || 15);

export function diskStatus(at = fs.existsSync(uploadDir()) ? uploadDir() : process.cwd()) {
  try {
    const s = fs.statfsSync(at), total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    const freePct = total ? Math.round((free / total) * 1000) / 10 : 100;
    return { totalBytes: total, freeBytes: free, freePct, alertPct: alertPct(), low: freePct < alertPct() };
  } catch { return null; }
}

/** Delete files older than maxAgeMs from the temp folder only. Returns how many were removed. */
export function cleanTemp(maxAgeMs = 24 * 3600_000, dir = tempDir()) {
  if (!fs.existsSync(dir)) return 0;
  const up = path.resolve(uploadDir()), root = path.resolve(dir);
  if (root === "/" || up.startsWith(root) || root.startsWith(up)) return 0; // never touch the photo folder
  let n = 0; const cut = Date.now() - maxAgeMs;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    try { if (e.isFile() && fs.statSync(f).mtimeMs < cut) { fs.rmSync(f); n++; } } catch { /* in use */ }
  }
  return n;
}

export function startDiskWatch(everyMs = 3600_000) {
  const tick = () => {
    const n = cleanTemp(); if (n) console.log(`temp cleanup: removed ${n} old file(s) from ${tempDir()}`);
    const d = diskStatus();
    if (d?.low) console.warn(`LOW DISK: only ${d.freePct}% free (${Math.round(d.freeBytes / 1e6)} MB). Alert below ${d.alertPct}%. Free space or move photos to S3 (PHOTO_STORAGE=s3).`);
  };
  tick(); return setInterval(tick, everyMs).unref();
}
