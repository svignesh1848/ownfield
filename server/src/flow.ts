// Field rules ("flow" settings) shared by several modules: no-order reasons, must-sell lists, expiry block, stock adjustment
// approval, GRN confirmation, claim approval rules, start/end day and retailer announcements. Kept in company_kv "flow".
import type { Db } from "./db.js";
import { bad } from "./catalog.js";
import { type Ctx, MGR, kvGet, kvSet } from "./common.js";

export type Flow = {
  requireNoOrderReason: boolean; noOrderReasons: string[];
  mustSell: Record<string, string[]>;            // outlet type → SKUs ("*" = every outlet)
  expiryBlockDays: number;                        // don't sell batches expiring within N days (0 = only expired are blocked)
  adjustApproval: boolean; adjustReasons: string[]; grnConfirm: boolean;
  claimLevels: { kind: string; upTo: number; role: string }[]; // first matching row decides who may approve
  damageCapPct: number;                           // damage claims per distributor per month ≤ this % of primary (company→distributor) sales; 0 = off
  dayStart: boolean; selfie: boolean;             // Start/End Day with GPS, optional selfie
  announcements: { text: string; until?: string }[];
};
export const FLOW_DEFAULT: Flow = {
  requireNoOrderReason: true, noOrderReasons: ["Shop closed", "Owner not available", "Enough stock", "Payment pending", "Price issue", "Competitor scheme", "Other"],
  mustSell: {}, expiryBlockDays: 0, adjustApproval: false, adjustReasons: ["Damaged", "Expired", "Count correction", "Theft / loss", "Sample / free issue"], grnConfirm: false,
  claimLevels: [], damageCapPct: 0, dayStart: false, selfie: false, announcements: [],
};
export const getFlow = (db: Db, cid: number) => kvGet<Flow>(db, cid, "flow", FLOW_DEFAULT);

const strList = (v: unknown, max = 30) => Array.isArray(v) ? [...new Set(v.map(x => String(x).trim()).filter(Boolean).map(x => x.slice(0, 80)))].slice(0, max) : undefined;
export function cleanFlow(b: any, cur: Flow): Flow {
  const f = { ...cur };
  if (b.requireNoOrderReason != null) f.requireNoOrderReason = !!b.requireNoOrderReason;
  if (b.noOrderReasons != null) { const l = strList(b.noOrderReasons); if (!l) throw bad("reasons must be a list"); f.noOrderReasons = l; }
  if (b.mustSell != null) { if (typeof b.mustSell !== "object") throw bad("must-sell must map outlet type to product codes"); f.mustSell = {};
    for (const [k, v] of Object.entries(b.mustSell)) { const l = strList(v, 200); if (l?.length) f.mustSell[String(k).trim().slice(0, 40) || "*"] = l; } }
  if (b.expiryBlockDays != null) { const n = Number(b.expiryBlockDays); if (!Number.isInteger(n) || n < 0 || n > 365) throw bad("expiry block must be 0–365 days"); f.expiryBlockDays = n; }
  if (b.adjustApproval != null) f.adjustApproval = !!b.adjustApproval;
  if (b.adjustReasons != null) { const l = strList(b.adjustReasons); if (!l?.length) throw bad("add at least one adjustment reason"); f.adjustReasons = l; }
  if (b.grnConfirm != null) f.grnConfirm = !!b.grnConfirm;
  if (b.claimLevels != null) { if (!Array.isArray(b.claimLevels)) throw bad("approval levels must be a list");
    f.claimLevels = b.claimLevels.map((l: any) => ({ kind: String(l.kind || "*"), upTo: Number(l.upTo), role: String(l.role) })).filter((l: any) => l.upTo >= 0);
    if (f.claimLevels.some(l => !["manager", "company_admin"].includes(l.role))) throw bad("approver must be manager or company_admin"); }
  if (b.damageCapPct != null) { const n = Number(b.damageCapPct); if (!(n >= 0 && n <= 100)) throw bad("damage cap must be 0–100%"); f.damageCapPct = n; }
  if (b.dayStart != null) f.dayStart = !!b.dayStart;
  if (b.selfie != null) f.selfie = !!b.selfie;
  if (b.announcements != null) { if (!Array.isArray(b.announcements)) throw bad("announcements must be a list");
    f.announcements = b.announcements.map((a: any) => ({ text: String(a.text || "").trim().slice(0, 300), until: a.until ? String(a.until).slice(0, 10) : undefined })).filter((a: any) => a.text).slice(0, 10); }
  return f;
}

export function registerFlowRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/flow-settings", auth(...MGR, "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await getFlow(db, cid));
  }));
  app.put("/api/flow-settings", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const f = cleanFlow(req.body || {}, await getFlow(db, cid)); await kvSet(db, cid, "flow", f); res.json(f);
  }));
}
