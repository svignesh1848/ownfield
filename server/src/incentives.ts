// Phase 3.4: incentives — admin sets simple rules: "if a rep reaches X% of their <metric> target, they earn ₹Y".
// The highest slab reached counts (slabs don't add up). Reps see their earnings for the month on their home screen.
import type { Db } from "./db.js";
import { bad, today } from "./catalog.js";
import { achievement, METRICS } from "./insights.js";
import { type Ctx, MGR, requireFeature, monthOk } from "./common.js";

type Slab = { minPct: number; amount: number };
export function cleanSlabs(input: unknown): Slab[] {
  if (!Array.isArray(input) || !input.length || input.length > 10) throw bad("add 1 to 10 slabs");
  const out = input.map((x: any) => ({ minPct: Number(x?.minPct), amount: Math.round(Number(x?.amount) * 100) / 100 }));
  for (const x of out) if (!(x.minPct > 0 && x.minPct <= 1000) || !(x.amount >= 0)) throw bad("each slab needs a % above 0 and an amount of ₹0 or more");
  if (new Set(out.map(x => x.minPct)).size !== out.length) throw bad("each slab needs a different %");
  return out.sort((a, b) => a.minPct - b.minPct);
}
export const slabEarned = (slabs: Slab[], pct: number | null) => pct == null ? 0 : slabs.filter(x => pct >= x.minPct).reduce((a, x) => Math.max(a, x.amount), 0);

export async function earnings(db: Db, cid: number, month: string, repId?: number) {
  const rules = (await db.query("SELECT * FROM incentive_rules WHERE company_id=$1 AND active=TRUE ORDER BY id", [cid])).rows.map(r => ({ ...r, slabs: JSON.parse(r.slabs) as Slab[] }));
  const ach = await achievement(db, cid, month, repId);
  return ach.map(a => {
    const lines = rules.map(r => {
      const m = a.metrics.find(x => x.metric === r.metric)!; const earned = slabEarned(r.slabs, m.pct);
      const next = m.pct == null ? null : r.slabs.find((x: Slab) => x.minPct > m.pct!) ?? null;
      return { ruleId: r.id, rule: r.name, metric: r.metric, target: m.target, actual: m.actual, pct: m.pct, earned, next };
    });
    return { repId: a.repId, rep: a.rep, month, total: Math.round(lines.reduce((s, l) => s + l.earned, 0) * 100) / 100, lines };
  });
}

export function registerIncentiveRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/incentive-rules", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "incentives");
    res.json((await db.query("SELECT * FROM incentive_rules WHERE company_id=$1 ORDER BY id", [cid])).rows.map(r => ({ ...r, slabs: JSON.parse(r.slabs) })));
  }));
  app.post("/api/incentive-rules", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "incentives");
    const b = req.body || {}; const name = String(b.name || "").trim().slice(0, 80); if (!name) throw bad("give the rule a name");
    const metric = String(b.metric || "value"); if (!(METRICS as readonly string[]).includes(metric)) throw bad(`target type must be ${METRICS.join("/")}`);
    const r = (await db.query("INSERT INTO incentive_rules (company_id,name,metric,slabs) VALUES ($1,$2,$3,$4) RETURNING *", [cid, name, metric, JSON.stringify(cleanSlabs(b.slabs))])).rows[0];
    res.status(201).json({ ...r, slabs: JSON.parse(r.slabs) });
  }));
  app.post("/api/incentive-rules/:id/active", auth("company_admin"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = await db.query("UPDATE incentive_rules SET active=$1 WHERE id=$2 AND company_id=$3 RETURNING id,active", [!!req.body?.active, Number(req.params.id), cid]);
    if (!r.rows[0]) throw bad("rule not found", 404); res.json(r.rows[0]);
  }));
  app.get("/api/incentives", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "incentives");
    const month = monthOk(req.query.month) ? String(req.query.month) : today().slice(0, 7);
    res.json(await earnings(db, cid, month, req.user.role === "sales_rep" ? req.user.uid : undefined));
  }));
}
