// Built-in "AI": rules and simple statistics on the company's own order history. No API key and no outside calls by default.
// Optional: set AI_PROVIDER=openai-compatible with AI_API_KEY, AI_BASE_URL, AI_MODEL to have an LLM re-word the manager summary.
// The numbers and facts always come from the rules below; the LLM only rewrites the sentences.
import type { Db } from "./db.js";
import { bad, getCompany } from "./catalog.js";
import { dayKey } from "./field.js";
import { getFlow, mustSellFor } from "./flow.js";
import { MGR, type Ctx } from "./common.js";

/** A sentence the app can translate: English template `key` with {0}, {1} args, plus the filled English `text`. */
export type Line = { key: string; args: (string | number)[]; text: string; tone?: "good" | "warn" | "bad" };
const fill = (key: string, args: (string | number)[]) => key.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
const L = (key: string, args: (string | number)[] = [], tone?: Line["tone"]): Line => ({ key, args, text: fill(key, args), ...(tone ? { tone } : {}) });
const dnum = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);
const dstr = (n: number) => new Date(n * 864e5).toISOString().slice(0, 10);
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r0 = (n: number) => Math.round(n);
const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

type Hist = { id: number; shop: number; rep: number; day: number; total: number; lines: Map<number, number> };
async function history(db: Db, cid: number): Promise<Hist[]> {
  const os = (await db.query("SELECT id, shop_id, rep_id, total, created_at FROM orders WHERE company_id=$1 AND status NOT IN ('rejected','cancelled') ORDER BY created_at, id", [cid])).rows;
  const by = new Map<number, Hist>(os.map(o => [o.id, { id: o.id, shop: o.shop_id, rep: o.rep_id, day: dnum(dayKey(o.created_at)), total: Number(o.total), lines: new Map() }]));
  const ls = (await db.query("SELECT l.order_id, l.variant_id, l.base_qty, l.free FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.company_id=$1", [cid])).rows;
  for (const l of ls) { const h = by.get(l.order_id); if (h && !l.free) h.lines.set(l.variant_id, (h.lines.get(l.variant_id) ?? 0) + Number(l.base_qty)); }
  return [...by.values()];
}

// ---------- 1. Smart order suggestions ----------
export type Suggestion = { sku: string; name: string; qty: number; why: Line; source: "due" | "usual" | "must" | "similar"; score: number; stock: number | null; note?: Line };
export async function smartSuggest(db: Db, cid: number, shopId: number, todayStr = dayKey(new Date()), max = 8) {
  const shop = (await db.query("SELECT id, outlet_type, city, distributor_id FROM shops WHERE id=$1 AND company_id=$2", [shopId, cid])).rows[0];
  if (!shop) throw bad("shop not found", 404);
  const vars = new Map<number, { sku: string; name: string }>((await db.query("SELECT v.id, v.sku, i.name FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 AND i.kind='goods'", [cid])).rows.map(r => [r.id, { sku: r.sku, name: r.name }]));
  const { settings } = await getCompany(db, cid);
  let stock: Map<number, number> | null = null;
  if (settings.features?.stock) {
    stock = new Map();
    const rows = (await db.query(`SELECT variant_id, COALESCE(SUM(qty),0) AS q FROM stock WHERE company_id=$1 AND ${shop.distributor_id ? "distributor_id=$2" : "distributor_id IS NULL"} AND (expiry IS NULL OR expiry>=$${shop.distributor_id ? 3 : 2}) GROUP BY variant_id`,
      shop.distributor_id ? [cid, shop.distributor_id, todayStr] : [cid, todayStr])).rows;
    for (const r of rows) stock.set(r.variant_id, Number(r.q));
  }
  const all = await history(db, cid), mine = all.filter(o => o.shop === shopId), now = dnum(todayStr);
  const out = new Map<number, Suggestion>();
  const add = (vid: number, qty: number, why: Line, source: Suggestion["source"], score: number) => {
    const v = vars.get(vid); if (!v || qty <= 0) return; const prev = out.get(vid); if (prev && prev.score >= score) return;
    out.set(vid, { sku: v.sku, name: v.name, qty: Math.ceil(qty), why, source, score, stock: stock ? stock.get(vid) ?? 0 : null });
  };
  // a) This shop's own history: usual quantity, and whether it is due by its reorder cycle.
  const recent = mine.slice(-6);
  const per = new Map<number, { days: number[]; qty: number[] }>();
  for (const o of mine) for (const [vid, q] of o.lines) { const p = per.get(vid) || { days: [], qty: [] }; p.days.push(o.day); p.qty.push(q); per.set(vid, p); }
  for (const [vid, p] of per) {
    const usual = median(p.qty.slice(-3)), last = p.days[p.days.length - 1], since = now - last;
    const gaps = p.days.slice(1).map((d, i) => d - p.days[i]).filter(g => g > 0), cycle = median(gaps);
    const inRecent = recent.filter(o => o.lines.has(vid)).length;
    if (cycle > 0 && since >= cycle * 0.8) add(vid, usual, L("Due: orders about every {0} days, last {1} days ago", [r0(cycle), since]), "due", 80 + Math.min(20, since / cycle * 5));
    else if (inRecent >= Math.max(1, Math.ceil(recent.length / 2))) add(vid, usual, L("Usually orders {0} (in {1} of last {2} orders)", [usual, inRecent, recent.length]), "usual", 50 + inRecent * 3);
  }
  // b) Must-sell for this outlet type.
  const flow = await getFlow(db, cid), skuId = new Map([...vars].map(([id, v]) => [v.sku, id]));
  // c) Similar shops: same outlet type (else same city) — what most of them buy and the typical quantity.
  const sim = (await db.query("SELECT id FROM shops WHERE company_id=$1 AND id<>$2 AND " + (shop.outlet_type ? "outlet_type=$3" : "city=$3"), [cid, shopId, shop.outlet_type || shop.city || ""])).rows.map(r => r.id);
  const simSet = new Set(sim), buyers = new Map<number, Set<number>>(), simQty = new Map<number, number[]>();
  for (const o of all) if (simSet.has(o.shop) && now - o.day <= 90) for (const [vid, q] of o.lines) {
    (buyers.get(vid) || buyers.set(vid, new Set()).get(vid)!).add(o.shop); (simQty.get(vid) || simQty.set(vid, []).get(vid)!).push(q); }
  const activeSim = new Set(all.filter(o => simSet.has(o.shop) && now - o.day <= 90).map(o => o.shop)).size;
  for (const sku of mustSellFor(flow, shop.outlet_type)) {
    const vid = skuId.get(sku); if (vid == null) continue;
    const q = per.has(vid) ? median(per.get(vid)!.qty.slice(-3)) : median(simQty.get(vid) || []) || 1;
    add(vid, q, L("Must-sell for {0} outlets", [shop.outlet_type || "all"]), "must", 90);
  }
  if (activeSim >= 2) for (const [vid, b] of buyers) {
    if (per.has(vid) || b.size / activeSim < 0.5) continue;
    add(vid, median(simQty.get(vid)!), L("Popular with similar shops ({0} of {1} buy it)", [b.size, activeSim]), "similar", 30 + 20 * b.size / activeSim);
  }
  // d) Stock: never suggest more than is available; drop items that are out of stock.
  let lines = [...out.values()];
  if (stock) lines = lines.filter(l => (l.stock ?? 0) > 0).map(l => l.qty > (l.stock ?? 0)
    ? { ...l, qty: l.stock!, note: L("Only {0} in stock", [l.stock!], "warn") } : l);
  lines.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
  return { orders: mine.length, similarShops: activeSim, lines: lines.slice(0, max) };
}

// ---------- 3. At-risk shops: order frequency dropping ----------
export async function atRiskShops(db: Db, cid: number, todayStr = dayKey(new Date()), hist?: Hist[]) {
  const all = hist ?? await history(db, cid), now = dnum(todayStr);
  const shops = (await db.query("SELECT id, name, code, city FROM shops WHERE company_id=$1", [cid])).rows;
  const out: { shopId: number; shop: string; code: string; city: string | null; lastOrder: string; daysSince: number; usualGap: number; avgValue: number; why: Line }[] = [];
  for (const s of shops) {
    const os = all.filter(o => o.shop === s.id); if (os.length < 2) continue;
    const days = [...new Set(os.map(o => o.day))].sort((a, b) => a - b); if (days.length < 2) continue;
    const gap = median(days.slice(1).map((d, i) => d - days[i])), since = now - days[days.length - 1];
    const last30 = os.filter(o => now - o.day < 30).length, prev60 = os.filter(o => now - o.day >= 30 && now - o.day < 90).length / 2;
    const avgValue = os.reduce((a, o) => a + o.total, 0) / os.length;
    let why: Line | null = null;
    if (gap > 0 && since >= Math.max(gap * 1.5, gap + 7)) why = L("No order for {0} days; usually every {1} days", [since, r0(gap)], "bad");
    else if (prev60 >= 2 && last30 <= prev60 / 2) why = L(last30 === 1 ? "Only {0} order in the last 30 days, down from about {1} a month" : "Only {0} orders in the last 30 days, down from about {1} a month", [last30, r0(prev60)], "warn");
    if (why) out.push({ shopId: s.id, shop: s.name, code: s.code, city: s.city, lastOrder: dstr(days[days.length - 1]), daysSince: since, usualGap: r0(gap), avgValue: r0(avgValue), why });
  }
  return out.sort((a, b) => b.avgValue * (b.daysSince / Math.max(1, b.usualGap)) - a.avgValue * (a.daysSince / Math.max(1, a.usualGap)));
}

// ---------- 2. Manager daily summary ----------
export async function dailySummary(db: Db, cid: number, todayStr = dayKey(new Date())) {
  const all = await history(db, cid), now = dnum(todayStr), yest = now - 1;
  const reps = (await db.query("SELECT id, name FROM users WHERE company_id=$1 AND role='sales_rep' AND active=TRUE", [cid])).rows;
  const repName = new Map(reps.map(r => [r.id, r.name]));
  const shopName = new Map((await db.query("SELECT id, name FROM shops WHERE company_id=$1", [cid])).rows.map(r => [r.id, r.name]));
  const visits = (await db.query("SELECT rep_id, shop_id, check_in_at FROM visits WHERE company_id=$1 AND check_in_at>=$2", [cid, new Date((yest - 1) * 864e5)])).rows.map(v => ({ ...v, day: dnum(dayKey(v.check_in_at)) }));
  const beats = (await db.query("SELECT b.rep_id, b.weekday, bs.shop_id FROM beats b JOIN beat_shops bs ON bs.beat_id=b.id WHERE b.company_id=$1 AND b.rep_id IS NOT NULL", [cid])).rows;
  const dayStats = (d: number) => {
    const os = all.filter(o => o.day === d), wd = new Date(d * 864e5).getUTCDay();
    const planned = new Set(beats.filter(b => b.weekday == null ? wd !== 0 : Number(b.weekday) === wd).map(b => `${b.rep_id}:${b.shop_id}`));
    const vs = visits.filter(v => v.day === d), done = new Set(vs.map(v => `${v.rep_id}:${v.shop_id}`));
    return { date: dstr(d), orders: os.length, value: r0(os.reduce((a, o) => a + o.total, 0)), planned: planned.size, visited: done.size, plannedDone: [...planned].filter(k => done.has(k)).length, os, vs };
  };
  const T = dayStats(now), Y = dayStats(yest);
  const prev = Array.from({ length: 7 }, (_, i) => dayStats(yest - 1 - i)), avgVal = prev.reduce((a, d) => a + d.value, 0) / 7, avgOrd = prev.reduce((a, d) => a + d.orders, 0) / 7;
  const lines: Line[] = [];
  lines.push(Y.orders ? L(Y.orders === 1 ? "Yesterday: {0} order worth {1}." : "Yesterday: {0} orders worth {1}.", [Y.orders, inr(Y.value)]) : L("Yesterday: no orders.", [], "warn"));
  if (avgVal > 0 && Y.orders) { const pct = r0((Y.value / avgVal - 1) * 100);
    if (pct >= 20) lines.push(L("That is {0}% above the 7-day average of {1}.", [pct, inr(avgVal)], "good"));
    else if (pct <= -30) lines.push(L("That is {0}% below the 7-day average of {1}.", [-pct, inr(avgVal)], "bad")); }
  lines.push(L(T.orders === 1 ? "Today so far: {0} order worth {1}." : "Today so far: {0} orders worth {1}.", [T.orders, inr(T.value)]));
  for (const [lab, d] of [["Yesterday", Y], ["Today", T]] as const) if (d.planned) lines.push(L(lab === "Today" ? "Visits today: {0} of {1} planned outlets done." : "Visits yesterday: {0} of {1} planned outlets done.", [d.plannedDone, d.planned], d.plannedDone / d.planned < 0.6 && lab === "Yesterday" ? "warn" : undefined));
  // Top / bottom reps over the last 7 days (incl. today) by order value.
  const wk = all.filter(o => o.day > now - 7), byRep = reps.map(r => ({ id: r.id, name: r.name, value: wk.filter(o => o.rep === r.id).reduce((a, o) => a + o.total, 0), orders: wk.filter(o => o.rep === r.id).length })).sort((a, b) => b.value - a.value);
  if (byRep.length && byRep[0].value > 0) lines.push(L(byRep[0].orders === 1 ? "Top rep this week: {0} with {1} from {2} order." : "Top rep this week: {0} with {1} from {2} orders.", [byRep[0].name, inr(byRep[0].value), byRep[0].orders], "good"));
  if (byRep.length > 1) { const lo = byRep[byRep.length - 1]; lines.push(lo.value > 0 ? L("Lowest this week: {0} with {1}.", [lo.name, inr(lo.value)], "warn") : L("{0} has no orders this week.", [lo.name], "warn")); }
  // Reps who visited yesterday but took no orders.
  for (const r of reps) { const v = Y.vs.filter(x => x.rep_id === r.id).length; if (v >= 3 && !Y.os.some(o => o.rep === r.id)) lines.push(L("{0} made {1} visits yesterday but took no orders.", [r.name, v], "warn")); }
  // Anomalies: an order far bigger than the shop's usual.
  for (const o of [...Y.os, ...T.os]) { const past = all.filter(p => p.shop === o.shop && p.day < o.day); if (past.length < 3) continue;
    const avg = past.reduce((a, p) => a + p.total, 0) / past.length; if (o.total > avg * 3 && o.total - avg > 1000) lines.push(L("Unusual: {0} ordered {1}, about {2}x their usual {3}.", [shopName.get(o.shop) || "", inr(o.total), r0(o.total / avg), inr(avg)], "warn")); }
  // Shops not ordering lately.
  const risk = await atRiskShops(db, cid, todayStr, all);
  if (risk.length) lines.push(L(risk.length === 1 ? "{0} shop has not ordered as often as usual: {1}." : "{0} shops have not ordered as often as usual, e.g. {1}.", [risk.length, risk.slice(0, 3).map(r => r.shop).join(", ")], "warn"));
  // Low-stock risk: fast-moving SKUs (last 30 days) with less than 7 days of cover in company + distributor stock.
  const { settings } = await getCompany(db, cid); const low: { sku: string; qty: number; days: number }[] = [];
  if (settings.features?.stock) {
    const st = new Map((await db.query("SELECT variant_id, COALESCE(SUM(qty),0) AS q FROM stock WHERE company_id=$1 GROUP BY variant_id", [cid])).rows.map(r => [r.variant_id, Number(r.q)]));
    const sold = new Map<number, number>(); for (const o of all) if (now - o.day < 30) for (const [vid, q] of o.lines) sold.set(vid, (sold.get(vid) ?? 0) + q);
    const sku = new Map((await db.query("SELECT id, sku FROM variants WHERE company_id=$1", [cid])).rows.map(r => [r.id, r.sku]));
    for (const [vid, q] of sold) { const rate = q / 30, have = st.get(vid) ?? 0, days = rate > 0 ? have / rate : 999; if (days < 7) low.push({ sku: sku.get(vid) || "", qty: have, days: Math.floor(days) }); }
    low.sort((a, b) => a.days - b.days);
    if (low.length) lines.push(L("Low stock risk: {0} may run out within a week.", [low.slice(0, 4).map(l => `${l.sku} (${l.qty} left)`).join(", ")], "bad"));
  }
  if (avgOrd >= 1 && !T.orders && Y.orders === 0) lines.push(L("No orders yesterday or today, though the team usually gets about {0} a day.", [r0(avgOrd)], "bad"));
  const strip = ({ os, vs, ...d }: any) => d;
  return { date: todayStr, today: strip(T), yesterday: strip(Y), avg7: { orders: Math.round(avgOrd * 10) / 10, value: r0(avgVal) }, reps: byRep.map(r => ({ ...r, value: r0(r.value) })),
    atRisk: risk.slice(0, 10), lowStock: low.slice(0, 10), lines, provider: aiProvider().name };
}

// ---------- Optional LLM wording ----------
export function aiProvider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "openai-compatible" && process.env.AI_BASE_URL && process.env.AI_MODEL) return { name: "openai-compatible", base: process.env.AI_BASE_URL.replace(/\/+$/, ""), model: process.env.AI_MODEL, key: process.env.AI_API_KEY || "" };
  return { name: "built-in" as string, base: "", model: "", key: "" };
}
const wordCache = new Map<string, { at: number; text: string | null }>();
/** Ask the configured LLM to turn the fact lines into a short paragraph. Returns null if not configured or on any error. */
export async function llmWording(facts: string[], fetcher: typeof fetch = fetch): Promise<string | null> {
  const p = aiProvider(); if (p.name === "built-in" || !facts.length) return null;
  const k = facts.join("\n"), hit = wordCache.get(k); if (hit && Date.now() - hit.at < 30 * 60_000) return hit.text;
  let text: string | null = null;
  try {
    const r = await fetcher(`${p.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) },
      body: JSON.stringify({ model: p.model, temperature: 0.2, max_tokens: 250, messages: [
        { role: "system", content: "You write a short daily sales briefing for a field-sales manager. Use only the facts given. Plain, simple sentences. No new numbers. Max 5 sentences." },
        { role: "user", content: k }] }) });
    if (r.ok) { const j: any = await r.json(); text = String(j?.choices?.[0]?.message?.content || "").trim().slice(0, 1500) || null; }
  } catch { text = null; }
  wordCache.set(k, { at: Date.now(), text }); return text;
}

export function registerAiRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/ai/status", auth(...MGR, "sales_rep"), wrap(async (_req, res) => { const p = aiProvider(); res.json({ provider: p.name, model: p.model || null }); }));
  app.post("/api/ai/suggest", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json(await smartSuggest(db, cid, Number(req.body?.shopId)));
  }));
  app.get("/api/ai/summary", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await dailySummary(db, cid);
    res.json({ ...s, aiText: req.query.ai === "0" ? null : await llmWording(s.lines.map(l => l.text)) });
  }));
  app.get("/api/ai/at-risk", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.json(await atRiskShops(db, cid));
  }));
}
