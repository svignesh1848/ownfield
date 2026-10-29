// Shared helpers for Phase 3 modules (audits, expenses, leave, incentives, retailer app).
import type { Express, Request, Response, NextFunction } from "express";
import type { Db } from "./db.js";
import { bad, getCompany } from "./catalog.js";
import type { FeatureKey } from "./templates.js";

export type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void };
export const MGR = ["company_admin", "manager"];
export const FEATURE_NAME: Record<string, string> = { audits: "Store audits", surveys: "Surveys", messaging: "WhatsApp/SMS messages", expenses: "Expenses", leave: "Leave & attendance", incentives: "Incentives", retailerApp: "Retailer app" };
/** Throw 403 unless the company has this feature switched on. */
export async function requireFeature(db: Db, cid: number, k: FeatureKey) {
  const { settings } = await getCompany(db, cid);
  if (!settings.features[k]) throw bad(`${FEATURE_NAME[k] || k} is turned off for this company`, 403);
  return settings;
}
export const monthOk = (m: unknown) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
export const dateOk = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && !isNaN(Date.parse(String(d)));
/** Small per-company key/value settings for optional modules (kept out of the validated settings blob). */
export async function kvGet<T>(db: Db, cid: number, k: string, d: T): Promise<T> {
  const r = (await db.query("SELECT v FROM company_kv WHERE company_id=$1 AND k=$2", [cid, k])).rows[0];
  if (!r) return d; try { return { ...(d as any), ...JSON.parse(r.v) }; } catch { return d; }
}
export async function kvSet(db: Db, cid: number, k: string, v: unknown) {
  const t = JSON.stringify(v);
  if ((await db.query("UPDATE company_kv SET v=$1 WHERE company_id=$2 AND k=$3 RETURNING k", [t, cid, k])).rows[0]) return;
  await db.query("INSERT INTO company_kv (company_id,k,v) VALUES ($1,$2,$3)", [cid, k, t]);
}
