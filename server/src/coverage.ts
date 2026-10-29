// Coverage reports: total vs productive calls, beat adherence and missed outlets, per rep and day.
// Planned calls come from beat plans: a beat with a weekday (0 = Sunday … 6 = Saturday) plans its outlets on that weekday;
// a beat without a weekday plans them every working day (Monday–Saturday). A call is productive when the rep took an order
// at that outlet the same day.
import { bad } from "./catalog.js";
import { dayKey } from "./field.js";
import { type Ctx, MGR, requireFeature, dateOk } from "./common.js";

export function registerCoverageRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/coverage", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "coverage");
    const to = String(req.query.to || dayKey(new Date())), from = String(req.query.from || to);
    if (!dateOk(from) || !dateOk(to) || from > to) throw bad("pick a valid date range");
    const days: string[] = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(+d + 864e5)) days.push(d.toISOString().slice(0, 10));
    if (days.length > 31) throw bad("pick at most 31 days");
    const repFilter = req.query.repId ? Number(req.query.repId) : null;
    const reps = (await db.query(`SELECT id, name FROM users WHERE company_id=$1 AND role='sales_rep' AND active=TRUE ${repFilter ? "AND id=$2" : ""} ORDER BY name`, repFilter ? [cid, repFilter] : [cid])).rows;
    const beats = (await db.query("SELECT b.id, b.rep_id, b.weekday, bs.shop_id, s.name AS shop_name FROM beats b JOIN beat_shops bs ON bs.beat_id=b.id JOIN shops s ON s.id=bs.shop_id WHERE b.company_id=$1", [cid])).rows;
    const lo = new Date(Date.parse(from + "T00:00:00+05:30")).toISOString(), hi = new Date(Date.parse(to + "T00:00:00+05:30") + 864e5).toISOString();
    const visits = (await db.query("SELECT rep_id, shop_id, check_in_at, no_order_reason FROM visits WHERE company_id=$1 AND check_in_at>=$2 AND check_in_at<$3", [cid, lo, hi])).rows;
    const orders = (await db.query("SELECT rep_id, shop_id, created_at FROM orders WHERE company_id=$1 AND created_at>=$2 AND created_at<$3 AND status<>'rejected'", [cid, lo, hi])).rows;
    const leave = (await db.query("SELECT rep_id, from_date, to_date FROM leaves WHERE company_id=$1 AND status='approved' AND from_date<=$3 AND to_date>=$2", [cid, from, to])).rows;
    const out = reps.map(r => {
      let planned = 0, visitedPlanned = 0, calls = 0, productive = 0, unplanned = 0; const missed: any[] = []; const reasons: Record<string, number> = {};
      for (const day of days) {
        if (leave.some(l => l.rep_id === r.id && l.from_date <= day && l.to_date >= day)) continue;
        const wd = new Date(day + "T00:00:00Z").getUTCDay();
        const plan = new Map<number, string>();
        for (const b of beats) if (b.rep_id === r.id && (b.weekday == null ? wd !== 0 : Number(b.weekday) === wd)) plan.set(b.shop_id, b.shop_name);
        const seen = new Set(visits.filter(v => v.rep_id === r.id && dayKey(v.check_in_at) === day).map(v => v.shop_id));
        const sold = new Set<number>(orders.filter(o => o.rep_id === r.id && dayKey(o.created_at) === day).map(o => o.shop_id));
        planned += plan.size; calls += seen.size;
        // A visit that ended with a no-order reason is non-productive even if an order came in another way that day.
        const dv = visits.filter(v => v.rep_id === r.id && dayKey(v.check_in_at) === day);
        for (const sid of [...sold]) if (dv.some(v => v.shop_id === sid && v.no_order_reason) && !dv.some(v => v.shop_id === sid && !v.no_order_reason)) sold.delete(sid);
        for (const v of dv) if (!sold.has(v.shop_id)) { const k = v.no_order_reason || "No reason given"; reasons[k] = (reasons[k] || 0) + 1; }
        for (const sid of seen) { if (sold.has(sid)) productive++; if (!plan.has(sid)) unplanned++; else visitedPlanned++; }
        for (const [sid, name] of plan) if (!seen.has(sid)) missed.push({ day, shop_id: sid, shop_name: name });
      }
      const pct = (a: number, b: number) => b ? Math.round((a / b) * 100) : null;
      return { rep_id: r.id, rep_name: r.name, planned_calls: planned, total_calls: calls, productive_calls: productive, non_productive_calls: calls - productive, no_order_reasons: reasons, productivity_pct: pct(productive, calls),
        beat_adherence_pct: pct(visitedPlanned, planned), unplanned_calls: unplanned, missed_outlets: missed };
    });
    res.json({ from, to, reps: out });
  }));
}
