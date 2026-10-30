// SPDX-License-Identifier: AGPL-3.0-only
// Scheduled report delivery. Saved reports may carry a schedule (daily/weekly/monthly at an IST hour, emails, format).
// When due, the file is generated into REPORT_OUTBOX. It is emailed ONLY when SMTP_HOST is set and the optional
// "nodemailer" package is installed; otherwise nothing is sent and the status says so. Off by default.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { parseJson } from "../catalog.js";
import { runReport } from "./engine.js";
import { ensureReportTables, toFile, companySources } from "./routes.js";

const istNow = (now = new Date()) => { const d = new Date(+now + 5.5 * 36e5); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay(), date: d.getUTCDate() }; };
/** Is this schedule due now (and not already run today, IST)? */
export function isDue(s: any, lastRunAt: unknown, now = new Date()) {
  if (!s?.enabled) return false;
  const n = istNow(now);
  if (n.hour < s.hour) return false;
  if (s.freq === "weekly" && n.weekday !== s.weekday) return false;
  if (s.freq === "monthly" && n.date !== s.day) return false;
  return !lastRunAt || istNow(new Date(lastRunAt as any)).day !== n.day;
}

async function send(to: string[], subject: string, text: string, file: { file: string; mime: string; body: Buffer }) {
  if (!process.env.SMTP_HOST) return "file saved; email not sent (SMTP not set up)";
  let nm: any; try { nm = await import(/* optional */ "nodemailer" as string); } catch { return "file saved; email not sent (install nodemailer to send email)"; }
  const t = (nm.default || nm).createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "1",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: to.join(", "), subject, text, attachments: [{ filename: file.file, content: file.body, contentType: file.mime }] });
  return `emailed to ${to.length} recipient(s)`;
}

export async function runDueReports(db: Db, now = new Date()) {
  await ensureReportTables(db);
  const dir = process.env.REPORT_OUTBOX || path.resolve(process.cwd(), "data/report-outbox");
  const list = (await db.query("SELECT r.*, c.name AS company FROM custom_reports r JOIN companies c ON c.id=r.company_id WHERE r.schedule IS NOT NULL AND r.schedule<>'null'")).rows;
  let ran = 0;
  for (const r of list) {
    const s = parseJson<any>(r.schedule, null); if (!isDue(s, r.last_run_at, now)) continue;
    let status: string;
    try {
      const f = toFile(await runReport(db, r.company_id, parseJson(r.def, {}), { sources: await companySources(db, r.company_id, r.created_by) }), r.name, s.format);
      const d = path.join(dir, String(r.company_id)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, f.file), f.body);
      status = await send(s.emails, `${r.company}: ${r.name}`, `Your scheduled OwnField report "${r.name}" is attached.`, f);
    } catch (e: any) { status = `failed: ${String(e.message).slice(0, 200)}`; }
    await db.query("UPDATE custom_reports SET last_run_at=$1, last_status=$2 WHERE id=$3", [now.toISOString(), status, r.id]); ran++;
  }
  return ran;
}
export function startReportScheduler(db: Db) {
  if (process.env.REPORT_SCHEDULES_DISABLED === "1") return;
  const tick = () => runDueReports(db).catch(e => console.error("report schedule:", e.message));
  setInterval(tick, 10 * 60_000).unref(); setTimeout(tick, 60_000).unref();
}
