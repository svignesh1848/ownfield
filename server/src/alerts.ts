// Security alerts for the platform owner: many failed sign-ins, backup/restore-test failure, 5xx spike.
// Always written as an in-app notification. Email is sent only when SMTP is already set up (see mail.ts).
import type { Db } from "./db.js";
import { notify } from "./field.js";
import { HitCounter, onServerError } from "./security.js";
import { sendMailIfConfigured } from "./mail.js";
import { backupStatus } from "./backup.js";

export const FAIL_ALERT_N = Number(process.env.ALERT_LOGIN_FAIL_N || 5);
export const FAIL_ALERT_MS = Number(process.env.ALERT_LOGIN_FAIL_MS || 15 * 60_000);
export const FIVE_XX_ALERT_N = Number(process.env.ALERT_5XX_N || 10);
export const FIVE_XX_ALERT_MS = Number(process.env.ALERT_5XX_MS || 5 * 60_000);
const DEDUPE_MS = 60 * 60_000;

const ipFails = new HitCounter(Number(process.env.ALERT_LOGIN_IP_N || 10), FAIL_ALERT_MS);
const fiveXx = new HitCounter(FIVE_XX_ALERT_N, FIVE_XX_ALERT_MS);
const lastBackupAlert = new Map<string, number>();

const testsOff = () => process.env.NODE_ENV === "test" && process.env.TEST_ALERTS !== "1";

async function owner(db: Db): Promise<{ id: number; email: string } | null> {
  const r = (await db.query("SELECT id, email FROM users WHERE role='platform_owner' AND company_id IS NULL LIMIT 1")).rows[0];
  return r ? { id: Number(r.id), email: String(r.email || "") } : null;
}

async function recentlyNotified(db: Db, userId: number, template: string, note: string) {
  const since = new Date(Date.now() - DEDUPE_MS).toISOString();
  const row = (await db.query(
    "SELECT 1 FROM notifications WHERE user_id=$1 AND company_id IS NULL AND template=$2 AND COALESCE(note,'')=$3 AND created_at>=$4 LIMIT 1",
    [userId, template, note, since])).rows[0];
  return !!row;
}

/** In-app (and email if SMTP is already configured) to the platform owner. Deduped for an hour. */
export async function alertOwner(db: Db, template: string, args: unknown[], note: string, link: string | null = null) {
  const o = await owner(db); if (!o) return { notified: false, mailed: "no-owner" as const };
  if (await recentlyNotified(db, o.id, template, note)) return { notified: false, mailed: "deduped" as const };
  await notify(db, null, o.id, template, args, note, link);
  const text = `${template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""))}${note ? `\n\n${note}` : ""}`;
  const mailed = await sendMailIfConfigured(o.email, "OwnField security alert", text);
  return { notified: true, mailed };
}

/** Call after a failed sign-in. Alerts when one account or one IP hits the threshold in the window. */
export async function noteFailedLogin(db: Db, acct: string, ip: string, n: number) {
  if (testsOff()) return;
  const ipN = ipFails.hit(ip || "?");
  if (n >= FAIL_ALERT_N) await alertOwner(db, "Many failed sign-ins for {0}", [acct], `${n} failed tries from ${ip || "unknown"} in 15 minutes.`, null);
  else if (ipN >= (ipFails.max)) await alertOwner(db, "Many failed sign-ins from one network", [], `${ipN} failed tries from ${ip || "unknown"} in 15 minutes.`, null);
}

let alertDb: Db | null = null;
export function record5xxForAlerts() {
  if (testsOff() || !alertDb) return;
  const n = fiveXx.hit("all");
  if (n === FIVE_XX_ALERT_N) {
    alertOwner(alertDb, "The app had a burst of errors", [], `${n} server errors in 5 minutes.`, null).catch(e => console.error("alert:", e.message));
  }
}

/** Check backup and restore-test status files; alert once per new failure timestamp. */
export async function checkBackupAlerts(db: Db, now = Date.now()) {
  if (testsOff()) return;
  const s = backupStatus();
  const marks: { key: string; template: string; note: string }[] = [];
  if (s.lastError) marks.push({ key: `backup:${s.lastAttemptAt || s.lastError}`, template: "A database backup failed", note: String(s.lastError) });
  const r = s.restoreTest;
  if (r && r.ok === false) marks.push({ key: `restore:${r.at || r.error || "fail"}`, template: "A backup restore test failed", note: String(r.error || (r.errors && r.errors[0]) || "restore test failed") });
  if (s.photoSync && s.photoSync.ok === false && s.photoSync.error) {
    marks.push({ key: `photos:${s.photoSync.at || s.photoSync.error}`, template: "Photo backup to storage failed", note: String(s.photoSync.error) });
  }
  for (const m of marks) {
    const prev = lastBackupAlert.get(m.key) || 0;
    if (now - prev < DEDUPE_MS) continue;
    const out = await alertOwner(db, m.template, [], m.note, null);
    if (out.notified) lastBackupAlert.set(m.key, now);
  }
}

/** Start periodic backup/restore checks and hook 5xx counting. No-op in tests unless TEST_ALERTS=1. */
export function startAlerts(db: Db) {
  alertDb = db;
  onServerError.record = record5xxForAlerts;
  const tick = () => checkBackupAlerts(db).catch(e => console.error("alert check:", e.message));
  tick();
  setInterval(tick, 5 * 60_000).unref();
}

/** Test helper: reset in-memory counters. */
export function resetAlerts() {
  lastBackupAlert.clear();
  alertDb = null;
  onServerError.record = null;
}
