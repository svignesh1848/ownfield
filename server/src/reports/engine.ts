// SPDX-License-Identifier: AGPL-3.0-only
// Report engine: validates a JSON report definition against the whitelisted sources, loads company-scoped rows with
// fixed SQL + bound parameters, then filters, groups, aggregates, compares and sorts in code. No user text ever
// reaches SQL except as a bound parameter.
import { withTx, type Db } from "../db.js";
import { bad } from "../catalog.js";
import { dayKey } from "../field.js";
import { SOURCES, DIMS, type Dim, type Range, type Where, type Source } from "./sources.js";

export const MAX_ROWS = Number(process.env.REPORT_MAX_ROWS || 50000);   // rows loaded per run
export const MAX_OUT = 5000;                                             // rows returned per run (export too)
export const TIMEOUT_MS = Number(process.env.REPORT_TIMEOUT_MS || 20000);
export const FNS = ["count", "sum", "avg", "min", "max", "distinct"] as const;
export const OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "notempty"] as const;
export const VIEWS = ["table", "bar", "line", "pie", "kpi"] as const;
export const BUCKETS: Record<string, string> = { _day: "Day", _week: "Week (starting Monday)", _month: "Month" };
export const PRESETS: Record<string, string> = { today: "Today", yesterday: "Yesterday", last_7: "Last 7 days", last_30: "Last 30 days", this_week: "This week", last_week: "Last week",
  this_month: "This month", last_month: "Last month", this_quarter: "This quarter", last_quarter: "Last quarter", this_fy: "This financial year", last_fy: "Last financial year", this_year: "This year", custom: "Custom dates" };

export type Metric = { fn: (typeof FNS)[number]; field?: string; label?: string };
export type Cond = { field: string; op: (typeof OPS)[number]; value?: unknown };
export type ReportDef = {
  version: 1; source: string; columns: string[];
  filters: { dateRange?: { preset: string; from?: string; to?: string } } & Partial<Record<Dim, (string | number)[]>>;
  conditions: Cond[]; groupBy: string[]; metrics: Metric[]; sort?: { by: string; dir: "asc" | "desc" }; limit?: number;
  view: { type: (typeof VIEWS)[number] }; compare: "none" | "prev" | "yoy";
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const D = (s: string) => new Date(s + "T00:00:00Z");
const addDays = (s: string, n: number) => iso(new Date(+D(s) + n * 864e5));
const addYears = (s: string, n: number) => { const d = D(s); d.setUTCFullYear(d.getUTCFullYear() + n); return iso(d); };
const days = (a: string, b: string) => Math.round((+D(b) - +D(a)) / 864e5) + 1;
const dateOk = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(+D(s));

/** Resolve a preset to an inclusive IST date range. `now` is a YYYY-MM-DD "today". */
export function resolveRange(r: { preset: string; from?: string; to?: string } | undefined, now = dayKey(new Date())): { from: string; to: string } {
  const p = r?.preset || "this_month", t = D(now), y = t.getUTCFullYear(), m = t.getUTCMonth();
  const mon = (d: Date) => addDays(iso(d), -((d.getUTCDay() + 6) % 7));
  const q = Math.floor(m / 3), fy = m >= 3 ? y : y - 1;
  const ym = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm, 1)));
  const endOf = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm + 1, 0)));
  switch (p) {
    case "today": return { from: now, to: now };
    case "yesterday": return { from: addDays(now, -1), to: addDays(now, -1) };
    case "last_7": return { from: addDays(now, -6), to: now };
    case "last_30": return { from: addDays(now, -29), to: now };
    case "this_week": return { from: mon(t), to: now };
    case "last_week": { const s = addDays(mon(t), -7); return { from: s, to: addDays(s, 6) }; }
    case "this_month": return { from: ym(y, m), to: now };
    case "last_month": return { from: ym(y, m - 1), to: endOf(y, m - 1) };
    case "this_quarter": return { from: ym(y, q * 3), to: now };
    case "last_quarter": return { from: ym(y, q * 3 - 3), to: endOf(y, q * 3 - 1) };
    case "this_fy": return { from: `${fy}-04-01`, to: now };
    case "last_fy": return { from: `${fy - 1}-04-01`, to: `${fy}-03-31` };
    case "this_year": return { from: `${y}-01-01`, to: now };
    case "custom": {
      if (!dateOk(r?.from) || !dateOk(r?.to)) throw bad("Pick a start and end date");
      if (r!.from! > r!.to!) throw bad("Start date must be on or before end date");
      return { from: r!.from!, to: r!.to! };
    }
    default: throw bad(`Unknown date range "${p}"`);
  }
}
const toRange = (from: string, to: string): Range => ({ from, to, lo: new Date(Date.parse(from + "T00:00:00+05:30")).toISOString(), hi: new Date(Date.parse(to + "T00:00:00+05:30") + 864e5).toISOString() });

const str = (v: unknown, max = 200) => String(v ?? "").slice(0, max);
/** Check a definition against the whitelist and return a clean copy (unknown keys dropped). Throws 400 with a plain message. */
export function validateDef(input: any, SRC: Record<string, Source> = SOURCES): ReportDef {
  if (!input || typeof input !== "object") throw bad("Report definition is missing");
  const src = SRC[String(input.source)]; if (!src) throw bad(`Unknown data source "${str(input.source, 40)}"`);
  const field = (k: unknown, what: string) => { const s = String(k); if (!src.fields[s]) throw bad(`Unknown ${what} "${str(k, 40)}" for ${src.label}`); return s; };
  const arr = (v: unknown, max: number, what: string) => { if (v == null) return []; if (!Array.isArray(v)) throw bad(`${what} must be a list`); if (v.length > max) throw bad(`Too many ${what} (max ${max})`); return v; };
  const columns = arr(input.columns, 40, "columns").map(c => field(c, "column"));
  const groupBy = arr(input.groupBy, 3, "group-by fields").map(g => { const s = String(g); if (BUCKETS[s]) { if (!src.dateField) throw bad(`${src.label} has no date to group by`); return s; } return field(s, "group-by field"); });
  const metrics: Metric[] = arr(input.metrics, 10, "metrics").map((m: any) => {
    const fn = String(m?.fn) as Metric["fn"]; if (!FNS.includes(fn)) throw bad(`Unknown metric "${str(m?.fn, 20)}"`);
    if (fn === "count") return { fn, ...(m.label ? { label: str(m.label, 60) } : {}) };
    const fk = field(m.field, "metric field"); const t = src.fields[fk].type;
    if (fn !== "distinct" && !["number", "money"].includes(t)) throw bad(`${fn} needs a number field`);
    return { fn, field: fk, ...(m.label ? { label: str(m.label, 60) } : {}) };
  });
  const conditions: Cond[] = arr(input.conditions, 10, "conditions").map((c: any) => {
    const op = String(c?.op) as Cond["op"]; if (!OPS.includes(op)) throw bad(`Unknown condition "${str(c?.op, 20)}"`);
    return { field: field(c.field, "condition field"), op, value: c.value == null ? undefined : typeof c.value === "number" ? c.value : str(c.value) };
  });
  const filters: ReportDef["filters"] = {};
  const fi = input.filters || {};
  if (fi.dateRange) { filters.dateRange = { preset: str(fi.dateRange.preset || "this_month", 20) }; if (fi.dateRange.preset === "custom") Object.assign(filters.dateRange, { from: str(fi.dateRange.from, 10), to: str(fi.dateRange.to, 10) }); resolveRange(filters.dateRange); }
  for (const d of Object.keys(DIMS) as Dim[]) if (fi[d] != null && !(Array.isArray(fi[d]) && !fi[d].length)) {
    if (!src.dims[d]) throw bad(`${src.label} can't be filtered by ${DIMS[d].toLowerCase()}`);
    const vals = arr(fi[d], 200, `${DIMS[d]} values`);
    filters[d] = d === "area" || d === "category" ? vals.map(v => str(v, 100)) : vals.map(v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad(`Bad ${DIMS[d].toLowerCase()} id`); return n; });
  }
  const outKeys = new Set([...groupBy, ...metrics.map(metricKey), ...columns]);
  let sort: ReportDef["sort"]; if (input.sort?.by) { const by = String(input.sort.by); if (!outKeys.has(by) && !src.fields[by]) throw bad(`Can't sort by "${str(by, 40)}"`); sort = { by, dir: input.sort.dir === "asc" ? "asc" : "desc" }; }
  const view = { type: (VIEWS.includes(input.view?.type) ? input.view.type : "table") as ReportDef["view"]["type"] };
  const compare = ["prev", "yoy"].includes(input.compare) ? input.compare : "none";
  if (compare !== "none" && !src.dateField) throw bad(`${src.label} has no dates to compare`);
  if (compare !== "none" && !metrics.length) throw bad("Add at least one metric to compare periods");
  const limit = input.limit == null ? undefined : Math.max(1, Math.min(MAX_OUT, Number(input.limit) || MAX_OUT));
  return { version: 1, source: String(input.source), columns, filters, conditions, groupBy, metrics, ...(sort ? { sort } : {}), ...(limit ? { limit } : {}), view, compare };
}
export const metricKey = (m: Metric) => m.fn === "count" ? "count" : `${m.fn}_${m.field}`;
const FN_LABEL: Record<string, string> = { count: "Count", sum: "Total", avg: "Average", min: "Lowest", max: "Highest", distinct: "Distinct" };
export const metricLabel = (src: Source, m: Metric) => m.label || (m.fn === "count" ? "Count" : `${FN_LABEL[m.fn]} ${src.fields[m.field!].label.toLowerCase()}`);

function buildWhere(src: Source, f: ReportDef["filters"], start: number): Where {
  const parts: string[] = [], args: unknown[] = [], checks: [string, unknown[]][] = [];
  for (const d of Object.keys(DIMS) as Dim[]) {
    const vals = f[d]; const c = src.dims[d]; if (!vals?.length || !c) continue;
    const ps = vals.map(v => { args.push(v); return `$${start + args.length - 1}`; }).join(",");
    parts.push(c.includes("?") ? c.replace("?", ps) : `${c} IN (${ps})`); checks.push([c, vals]);
  }
  return { sql: parts.map(p => ` AND ${p}`).join(""), args, checks };
}

async function load(db: Db, cid: number, src: Source, f: ReportDef["filters"], range: Range | null) {
  if (src.maxDays && range && days(range.from, range.to) > src.maxDays) throw bad(`Pick at most ${src.maxDays} days for this report`);
  return withTx(db, async tx => {
    try { await tx.query(`SET LOCAL statement_timeout = ${Math.floor(TIMEOUT_MS)}`); } catch { /* not supported by the test database */ }
    let rows: any[];
    if (src.load) rows = await src.load(tx, cid, range, buildWhere(src, f, 2));
    else {
      const head = src.dateKind ? [cid, src.dateKind === "ts" ? range!.lo : range!.from, src.dateKind === "ts" ? range!.hi : range!.to] : [cid];
      const w = buildWhere(src, f, head.length + 1);
      rows = (await tx.query(`${src.sql}${w.sql} LIMIT ${MAX_ROWS + 1}`, [...head, ...w.args])).rows;
    }
    if (rows.length > MAX_ROWS) throw bad(`Too much data (over ${MAX_ROWS} rows). Narrow the dates or add a filter.`, 413);
    if (src.enrich) await src.enrich(tx, cid, rows, range);
    return rows;
  });
}

const num = (v: unknown) => v == null || v === "" ? null : Number(v);
function condOk(v: unknown, c: Cond) {
  const s = String(v ?? "").toLowerCase(), cv = String(c.value ?? "").toLowerCase(), n = Number(v), cn = Number(c.value);
  switch (c.op) {
    case "eq": return typeof v === "boolean" ? String(v) === cv || (cv === "yes") === v : s === cv;
    case "neq": return s !== cv; case "contains": return s.includes(cv);
    case "gt": return n > cn; case "gte": return n >= cn; case "lt": return n < cn; case "lte": return n <= cn;
    case "empty": return v == null || v === ""; case "notempty": return !(v == null || v === "");
  }
}
const weekOf = (d: string) => addDays(d, -((D(d).getUTCDay() + 6) % 7));
const bucket = (k: string, d: string) => !d ? "" : k === "_month" ? d.slice(0, 7) : k === "_week" ? weekOf(d) : d;

/** Project rows to field values, apply conditions, then group+aggregate (or return raw columns). shiftDate moves dates (for comparisons). */
function shape(src: Source, def: ReportDef, raw: any[], range: Range | null, shiftDate?: (d: string) => string) {
  const need = new Set<string>([...def.columns, ...def.groupBy.filter(g => !BUCKETS[g]), ...def.metrics.filter(m => m.field).map(m => m.field!), ...def.conditions.map(c => c.field)]);
  if (src.dateField) need.add(src.dateField);
  let rows = raw.map(r => { const o: Record<string, unknown> = {}; for (const k of need) o[k] = src.fields[k].get(r); return o; });
  if (range && src.dateField && src.dateKind) rows = rows.filter(r => { const d = String(r[src.dateField!] || ""); return d >= range.from && d <= range.to; });
  rows = rows.filter(r => def.conditions.every(c => condOk(r[c.field], c)));
  if (shiftDate && src.dateField) for (const r of rows) r[src.dateField] = shiftDate(String(r[src.dateField]));
  if (!def.metrics.length) return rows.map(r => Object.fromEntries((def.columns.length ? def.columns : Object.keys(src.fields).filter(k => need.has(k))).map(k => [k, r[k]])));
  const groups = new Map<string, { key: Record<string, unknown>; rows: Record<string, unknown>[] }>();
  for (const r of rows) {
    const key: Record<string, unknown> = {}; for (const g of def.groupBy) key[g] = BUCKETS[g] ? bucket(g, String(r[src.dateField!] || "")) : r[g];
    const ks = JSON.stringify(def.groupBy.map(g => key[g])); if (!groups.has(ks)) groups.set(ks, { key, rows: [] }); groups.get(ks)!.rows.push(r);
  }
  if (!def.groupBy.length && !groups.size) groups.set("[]", { key: {}, rows: [] });
  return [...groups.values()].map(g => { const o: Record<string, unknown> = { ...g.key };
    for (const m of def.metrics) o[metricKey(m)] = agg(m, g.rows); return o; });
}
function agg(m: Metric, rows: Record<string, unknown>[]) {
  if (m.fn === "count") return rows.length;
  const vs = rows.map(r => r[m.field!]);
  if (m.fn === "distinct") return new Set(vs.filter(v => v != null && v !== "").map(String)).size;
  const ns = vs.map(num).filter((v): v is number => v != null && !isNaN(v));
  if (m.fn === "sum") return Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;
  if (!ns.length) return null;
  if (m.fn === "avg") return Math.round(ns.reduce((a, b) => a + b, 0) / ns.length * 100) / 100;
  return m.fn === "min" ? Math.min(...ns) : Math.max(...ns);
}

export type RunResult = { columns: { key: string; label: string; type: string }[]; rows: Record<string, unknown>[]; total: number; truncated: boolean;
  range: { from: string; to: string } | null; compareRange: { from: string; to: string } | null; view: string; source: string };

/** Run a report. `force` adds dim filters the caller can't remove (e.g. a sales rep sees only their own rows). */
export async function runReport(db: Db, cid: number, input: any, opts: { force?: Partial<Record<Dim, number[]>>; now?: string; limit?: number; sources?: Record<string, Source> } = {}): Promise<RunResult> {
  const SRC = opts.sources || SOURCES; const def = validateDef(input, SRC); const src = SRC[def.source];
  const soft = !!(opts.force as any)?.soft;
  for (const [d, v] of Object.entries(opts.force || {}) as [Dim, number[]][]) { if ((d as string) === "soft") continue; if (!src.dims[d]) { if (soft) continue; throw bad("You can't see this report", 403); }
    const cur = def.filters[d] as number[] | undefined; def.filters[d] = soft && Array.isArray(cur) && cur.length ? cur.filter(x => v.includes(Number(x))) : v; if (soft && !(def.filters[d] as number[]).length) def.filters[d] = [0]; }
  const r0 = src.dateField || src.usesRange ? resolveRange(def.filters.dateRange, opts.now) : null;
  const range = r0 ? toRange(r0.from, r0.to) : null;
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    let rows = shape(src, def, await load(db, cid, src, def.filters, range), range);
    let compareRange: RunResult["compareRange"] = null;
    if (def.compare !== "none" && range) {
      const len = days(range.from, range.to);
      const [pf, pt] = def.compare === "prev" ? [addDays(range.from, -len), addDays(range.from, -1)] : [addYears(range.from, -1), addYears(range.to, -1)];
      const pr = toRange(pf, pt); compareRange = { from: pf, to: pt };
      const shift = (d: string) => def.compare === "prev" ? addDays(d, len) : addYears(d, 1);
      const prev = shape(src, def, await load(db, cid, src, def.filters, pr), pr, shift);
      const pm = new Map(prev.map(p => [JSON.stringify(def.groupBy.map(g => p[g])), p]));
      const seen = new Set<string>();
      for (const r of rows) { const k = JSON.stringify(def.groupBy.map(g => r[g])); seen.add(k); addCmp(def, r, pm.get(k)); }
      for (const [k, p] of pm) if (!seen.has(k)) { const r: Record<string, unknown> = Object.fromEntries(def.groupBy.map(g => [g, p[g]])); for (const m of def.metrics) r[metricKey(m)] = m.fn === "count" || m.fn === "sum" || m.fn === "distinct" ? 0 : null; addCmp(def, r, p); rows.push(r); }
    }
    const sortBy = def.sort?.by ?? (def.groupBy.some(g => BUCKETS[g]) ? def.groupBy.find(g => BUCKETS[g]) : def.metrics.length ? metricKey(def.metrics[0]) : src.dateField);
    const dir = def.sort ? (def.sort.dir === "asc" ? 1 : -1) : sortBy && BUCKETS[sortBy] ? 1 : -1;
    if (sortBy) rows.sort((a, b) => { const x = a[sortBy], y = b[sortBy]; if (x == y) return 0; if (x == null || x === "") return 1; if (y == null || y === "") return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir; });
    const cap = Math.min(def.limit ?? MAX_OUT, opts.limit ?? MAX_OUT), total = rows.length;
    const columns = def.metrics.length
      ? [...def.groupBy.map(g => ({ key: g, label: BUCKETS[g] || src.fields[g].label, type: BUCKETS[g] ? (g === "_month" ? "text" : "date") : src.fields[g].type })),
         ...def.metrics.flatMap(m => { const k = metricKey(m), l = metricLabel(src, m), t = m.fn === "count" || m.fn === "distinct" ? "number" : src.fields[m.field!].type === "money" ? "money" : "number";
           return def.compare === "none" ? [{ key: k, label: l, type: t }] : [{ key: k, label: l, type: t }, { key: `${k}__prev`, label: `${l} (${def.compare === "prev" ? "previous period" : "last year"})`, type: t }, { key: `${k}__chg`, label: `${l} change %`, type: "number" }]; })]
      : (def.columns.length ? def.columns : Object.keys(rows[0] || {})).map(k => ({ key: k, label: src.fields[k].label, type: src.fields[k].type }));
    return { columns, rows: rows.slice(0, cap), total, truncated: total > cap, range: r0, compareRange, view: def.view.type, source: def.source };
  })();
  try { return await Promise.race([work, new Promise<never>((_, no) => { timer = setTimeout(() => no(bad("This report took too long. Narrow the dates or add a filter.", 504)), TIMEOUT_MS); })]); }
  finally { clearTimeout(timer); }
}
function addCmp(def: ReportDef, r: Record<string, unknown>, p?: Record<string, unknown>) {
  for (const m of def.metrics) { const k = metricKey(m), cur = num(r[k]), prev = p ? num(p[k]) : (m.fn === "count" || m.fn === "sum" || m.fn === "distinct" ? 0 : null);
    r[`${k}__prev`] = prev; r[`${k}__chg`] = cur != null && prev ? Math.round((cur - prev) / Math.abs(prev) * 1000) / 10 : null; }
}

/** Catalogue for the builder UI: sources, fields, filters, metric/op/view lists. */
export function catalog() {
  return {
    sources: Object.entries(SOURCES).map(([key, s]) => ({ key, label: s.label, description: s.description, hasDate: !!s.dateField, maxDays: s.maxDays ?? null,
      dims: Object.keys(s.dims), fields: Object.entries(s.fields).map(([k, f]) => ({ key: k, label: f.label, type: f.type })) })),
    dims: DIMS, presets: PRESETS, buckets: BUCKETS, fns: FNS, ops: OPS, views: VIEWS, limits: { maxRows: MAX_ROWS, maxOut: MAX_OUT, timeoutMs: TIMEOUT_MS },
  };
}
