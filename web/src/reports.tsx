// SPDX-License-Identifier: AGPL-3.0-only
// Custom reports: build (pick data, filters, group, metrics, view), live preview, save/share/pin, export, schedule, templates.
import React, { useEffect, useMemo, useState } from "react";
import { api, type ViewProps, type Session } from "./main";
import { t } from "./i18n";
import { Empty, Loading, Field, fmtCell, inr0, toast } from "./ui";
import { Reports as StandardExports } from "./step4";

type Col = { key: string; label: string; type: string };
type Result = { columns: Col[]; rows: any[]; total: number; truncated: boolean; range: { from: string; to: string } | null; compareRange: { from: string; to: string } | null; view: string };
const blank = { version: 1, source: "orders", columns: [] as string[], filters: { dateRange: { preset: "this_month" } } as any, conditions: [] as any[], groupBy: ["rep"], metrics: [{ fn: "sum", field: "value" }] as any[], view: { type: "bar" }, compare: "none" };
const COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#ea580c", "#475569"];
const FN: Record<string, string> = { count: "Count", sum: "Total", avg: "Average", min: "Lowest", max: "Highest", distinct: "Distinct count" };
const OP: Record<string, string> = { eq: "is", neq: "is not", contains: "contains", gt: ">", gte: "≥", lt: "<", lte: "≤", empty: "is empty", notempty: "is not empty" };
const VIEW: Record<string, string> = { table: "Table", bar: "Bar chart", line: "Line chart", pie: "Pie chart", kpi: "KPI card" };
const ROLE: Record<string, string> = { manager: "Managers", sales_rep: "Sales reps (own data only)", distributor: "Distributors (own data only)" };

const download = async (s: Session, url: string, init: RequestInit = {}) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` } });
  if (!r.ok) throw new Error(t((await r.json().catch(() => ({}))).error || r.statusText));
  const name = /filename="?([^";]+)/.exec(r.headers.get("content-disposition") || "")?.[1] || "report";
  const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = name; a.click();
};
const cell = (v: unknown, type: string) => v == null || v === "" ? "—" : type === "money" ? inr0(v) : type === "number" ? Number(v).toLocaleString("en-IN") : fmtCell(v);

/** Table, bar, line, pie or KPI rendering of a result. */
export function ReportResult({ r, view, compact }: { r: Result; view?: string; compact?: boolean }) {
  const v = view || r.view;
  const metricCols = r.columns.filter(c => (c.type === "number" || c.type === "money") && !c.key.endsWith("__chg") && !c.key.endsWith("__prev"));
  const labelCols = r.columns.filter(c => !metricCols.includes(c) && !c.key.endsWith("__chg") && !c.key.endsWith("__prev"));
  const m = metricCols[0], lbl = (row: any) => labelCols.map(c => fmtCell(row[c.key])).join(" · ") || t("Total");
  if (!r.rows.length) return <Empty icon="📊" title={t("No data for these filters")} text={t("Try a wider date range or remove a filter.")} />;
  if (v === "kpi" && m) {
    const row = r.rows[0], chg = row[`${m.key}__chg`];
    return <div className="kpis">{metricCols.map(c => <div className="tile" key={c.key}><span className="muted small">{t(c.label)}</span><b style={{ fontSize: "1.6em" }}>{cell(row[c.key], c.type)}</b>
      {row[`${c.key}__prev`] !== undefined && <span className={`small ${Number(row[`${c.key}__chg`]) < 0 ? "err" : ""}`}>{t("Before")}: {cell(row[`${c.key}__prev`], c.type)}{chg != null && c === m ? ` (${chg > 0 ? "+" : ""}${chg}%)` : ""}</span>}</div>)}</div>;
  }
  if ((v === "bar" || v === "line" || v === "pie") && m) {
    const rows = r.rows.slice(0, v === "pie" ? 10 : compact ? 12 : 40), vals = rows.map(x => Number(x[m.key]) || 0), prev = rows.map(x => Number(x[`${m.key}__prev`]) || 0);
    const hasPrev = r.rows[0][`${m.key}__prev`] !== undefined, max = Math.max(1, ...vals, ...(hasPrev ? prev : []));
    const legend = <p className="muted small">{t(m.label)}{hasPrev && <> · <span style={{ color: "#94a3b8" }}>■</span> {t(r.compareRange ? "Comparison period" : "Before")}</>}</p>;
    if (v === "pie") {
      const sum = vals.reduce((a, b) => a + b, 0) || 1; let a0 = 0;
      const arcs = vals.map((x, i) => { const a1 = a0 + (x / sum) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
        const p = `M50,50 L${50 + 45 * Math.sin(a0)},${50 - 45 * Math.cos(a0)} A45,45 0 ${big} 1 ${50 + 45 * Math.sin(a1)},${50 - 45 * Math.cos(a1)} Z`; a0 = a1;
        return vals.length === 1 ? <circle key={i} cx="50" cy="50" r="45" fill={COLORS[0]} /> : <path key={i} d={p} fill={COLORS[i % 10]} />; });
      return <div className="row" style={{ flexWrap: "wrap", gap: 16, alignItems: "center" }}><svg viewBox="0 0 100 100" width={compact ? 120 : 180} height={compact ? 120 : 180} role="img" aria-label={t(m.label)}>{arcs}</svg>
        <div>{rows.map((x, i) => <div key={i} className="small"><span style={{ color: COLORS[i % 10] }}>■</span> {lbl(x)}: <b>{cell(vals[i], m.type)}</b> ({Math.round(vals[i] / sum * 100)}%)</div>)}</div></div>;
    }
    if (v === "line") {
      const W = 600, H = 200, step = rows.length > 1 ? W / (rows.length - 1) : W, y = (n: number) => H - (n / max) * (H - 10);
      const path = (a: number[]) => a.map((n, i) => `${i ? "L" : "M"}${i * step},${y(n)}`).join(" ");
      return <div>{legend}<svg viewBox={`-5 0 ${W + 10} ${H + 20}`} width="100%" height={compact ? 140 : 220} preserveAspectRatio="none">
        {hasPrev && <path d={path(prev)} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="5 4" />}
        <path d={path(vals)} fill="none" stroke={COLORS[0]} strokeWidth="3" />{rows.map((x, i) => <circle key={i} cx={i * step} cy={y(vals[i])} r="3" fill={COLORS[0]}><title>{lbl(x)}: {cell(vals[i], m.type)}</title></circle>)}</svg>
        <div className="row muted small"><span>{lbl(rows[0])}</span><span>{lbl(rows[rows.length - 1])}</span></div></div>;
    }
    return <div>{legend}{rows.map((x, i) => <div key={i} style={{ margin: "6px 0" }}><div className="row small" style={{ gap: 8, justifyContent: "space-between" }}><span>{lbl(x)}</span><b>{cell(vals[i], m.type)}</b></div>
      <div className="bar"><span style={{ width: `${(vals[i] / max) * 100}%`, background: COLORS[0] }} /></div>
      {hasPrev && <div className="bar"><span style={{ width: `${(prev[i] / max) * 100}%`, background: "#94a3b8" }} /></div>}</div>)}</div>;
  }
  const rows = compact ? r.rows.slice(0, 10) : r.rows;
  return <div className="scroll"><table><thead><tr>{r.columns.map(c => <th key={c.key}>{c.key.endsWith("__chg") ? t("Change %") : c.key.endsWith("__prev") ? `${t(r.columns.find(x => c.key.startsWith(x.key + "__"))?.label || "")} (${t("before")})` : t(c.label)}</th>)}</tr></thead>
    <tbody>{rows.map((x, i) => <tr key={i}>{r.columns.map(c => <td key={c.key} className={c.type === "number" || c.type === "money" ? "n" : ""}>{c.key.endsWith("__chg") && x[c.key] != null ? `${x[c.key] > 0 ? "+" : ""}${x[c.key]}%` : cell(x[c.key], c.type)}</td>)}</tr>)}</tbody></table></div>;
}
const rangeText = (r: Result) => r.range ? `${fmtCell(r.range.from)} – ${fmtCell(r.range.to)}${r.compareRange ? ` · ${t("vs")} ${fmtCell(r.compareRange.from)} – ${fmtCell(r.compareRange.to)}` : ""}` : "";

/** Small pickers for rep / distributor / outlet / beat / product lists. */
function useLookups(s: Session) {
  const [L, setL] = useState<any>({});
  useEffect(() => {
    Promise.all([api(s, "/api/users").catch(() => []), api(s, "/api/shops").catch(() => []), api(s, "/api/beats").catch(() => []), api(s, "/api/items").catch(() => [])]).then(([u, sh, b, it]) => {
      const items = Array.isArray(it) ? it : it.items || [];
      setL({ rep: u.filter((x: any) => x.role === "sales_rep").map((x: any) => [x.id, x.name]), distributor: u.filter((x: any) => x.role === "distributor").map((x: any) => [x.id, x.name]),
        shop: sh.map((x: any) => [x.id, `${x.name} (${x.code})`]), beat: b.map((x: any) => [x.id, x.name]), product: items.map((x: any) => [x.id, x.name]),
        area: [...new Set(sh.map((x: any) => x.city).filter(Boolean))].sort().map(c => [c, c]), category: [...new Set(items.map((x: any) => x.category).filter(Boolean))].sort().map(c => [c, c]) });
    });
  }, []);
  return L;
}
function Multi({ opts, value, onChange }: { opts: [any, string][]; value: any[]; onChange: (v: any[]) => void }) {
  return <select multiple size={Math.min(5, Math.max(2, opts.length))} value={value.map(String)} onChange={e => onChange([...e.target.selectedOptions].map(o => opts.find(x => String(x[0]) === o.value)![0]))}>
    {opts.map(([k, l]) => <option key={k} value={String(k)}>{l}</option>)}</select>;
}

function Builder({ s, cat, init, onDone }: { s: Session; cat: any; init: any; onDone: () => void }) {
  const [def, setDef] = useState<any>(init?.def || blank); const [meta, setMeta] = useState<any>({ name: init?.name || "", description: init?.description || "", roles: init?.roles || [], pinned: !!init?.pinned, schedule: init?.schedule || { enabled: false, freq: "weekly", weekday: 1, day: 1, hour: 8, emails: "", format: "xlsx" } });
  const [res, setRes] = useState<Result | null>(null); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const L = useLookups(s);
  const src = cat.sources.find((x: any) => x.key === def.source) || cat.sources[0];
  const fields: Col[] = src.fields, num = fields.filter(f => f.type === "number" || f.type === "money");
  const up = (p: any) => setDef((d: any) => ({ ...d, ...p }));
  const upF = (p: any) => setDef((d: any) => ({ ...d, filters: { ...d.filters, ...p } }));
  const key = JSON.stringify(def);
  useEffect(() => { setBusy(true); const h = setTimeout(() => api(s, "/api/report-builder/preview", { method: "POST", body: JSON.stringify({ def }) }).then(r => { setRes(r); setErr(""); }).catch(e => { setErr(e.message); setRes(null); }).finally(() => setBusy(false)), 500); return () => clearTimeout(h); }, [key]);
  const pickSource = (k: string) => { const ns = cat.sources.find((x: any) => x.key === k); const n0 = ns.fields.find((f: any) => f.type === "money") || ns.fields.find((f: any) => f.type === "number");
    setDef({ ...blank, source: k, groupBy: [], metrics: n0 ? [{ fn: "sum", field: n0.key }] : [{ fn: "count" }], view: { type: "table" }, filters: ns.hasDate ? { dateRange: def.filters.dateRange || { preset: "this_month" } } : {} }); };
  const dr = def.filters.dateRange || { preset: "this_month" };
  const groupOpts: [string, string][] = [...(src.hasDate ? Object.entries(cat.buckets).map(([k, v]) => [k, t(v as string)] as [string, string]) : []), ...fields.filter(f => f.type !== "money" && f.type !== "number").map(f => [f.key, t(f.label)] as [string, string])];
  const save = async () => {
    if (!meta.name.trim()) return setErr(t("Give the report a name"));
    const body = { ...meta, def, schedule: meta.schedule.enabled ? meta.schedule : null };
    try { await api(s, init?.id ? `/api/custom-reports/${init.id}` : "/api/custom-reports", { method: init?.id ? "PUT" : "POST", body: JSON.stringify(body) }); onDone(); } catch (e: any) { setErr(e.message); }
  };
  return <div>
    <div className="row"><h2>{init?.id ? t("Edit report") : t("New report")}</h2><button className="sm ghost" onClick={onDone}>{t("Back")}</button></div>
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
      <div>
        <Field label={t("1. Data")} help={t(src.description)}><select value={def.source} onChange={e => pickSource(e.target.value)}>{cat.sources.map((x: any) => <option key={x.key} value={x.key}>{t(x.label)}</option>)}</select></Field>
        {src.hasDate && <Field label={t("Dates")}><select value={dr.preset} onChange={e => upF({ dateRange: { ...dr, preset: e.target.value } })}>{Object.entries(cat.presets).map(([k, v]) => <option key={k} value={k}>{t(v as string)}</option>)}</select>
          {dr.preset === "custom" && <div className="dates"><input type="date" value={dr.from || ""} onChange={e => upF({ dateRange: { ...dr, from: e.target.value } })} /><input type="date" value={dr.to || ""} onChange={e => upF({ dateRange: { ...dr, to: e.target.value } })} /></div>}</Field>}
        <details><summary>{t("2. Filters")}</summary>
          {src.dims.map((d: string) => L[d]?.length ? <Field key={d} label={t(cat.dims[d])} help={t("Leave empty for all. Hold Ctrl / long-press to pick several.")}><Multi opts={L[d]} value={def.filters[d] || []} onChange={v => upF({ [d]: v })} /></Field> : null)}
          {def.conditions.map((c: any, i: number) => <div className="row" key={i} style={{ gap: 4 }}>
            <select value={c.field} onChange={e => up({ conditions: def.conditions.map((x: any, j: number) => j === i ? { ...x, field: e.target.value } : x) })}>{fields.map(f => <option key={f.key} value={f.key}>{t(f.label)}</option>)}</select>
            <select value={c.op} onChange={e => up({ conditions: def.conditions.map((x: any, j: number) => j === i ? { ...x, op: e.target.value } : x) })}>{cat.ops.map((o: string) => <option key={o} value={o}>{t(OP[o])}</option>)}</select>
            {!/empty/.test(c.op) && <input value={c.value ?? ""} onChange={e => up({ conditions: def.conditions.map((x: any, j: number) => j === i ? { ...x, value: e.target.value } : x) })} style={{ width: 90 }} />}
            <button className="sm ghost" aria-label={t("Remove")} onClick={() => up({ conditions: def.conditions.filter((_: any, j: number) => j !== i) })}>✕</button></div>)}
          <button className="sm ghost" onClick={() => up({ conditions: [...def.conditions, { field: fields[0].key, op: "eq", value: "" }] })}>+ {t("Add condition")}</button>
        </details>
        <Field label={t("3. Group by")} help={t("Leave empty for one total, or for a plain list of rows.")}>
          {[0, 1].map(i => <select key={i} value={def.groupBy[i] || ""} onChange={e => { const g = [...def.groupBy]; g[i] = e.target.value; up({ groupBy: g.filter(Boolean) }); }}>
            <option value="">{i ? t("(no second group)") : t("(no grouping)")}</option>{groupOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>)}</Field>
        <Field label={t("4. Numbers to show")} help={t("Remove all to get a plain list of rows.")}>
          {def.metrics.map((m: any, i: number) => <div className="row" key={i} style={{ gap: 4 }}>
            <select value={m.fn} onChange={e => up({ metrics: def.metrics.map((x: any, j: number) => j === i ? { fn: e.target.value, field: e.target.value === "count" ? undefined : (e.target.value === "distinct" ? x.field || fields[0].key : num.find(f => f.key === x.field)?.key || num[0]?.key) } : x) })}>
              {cat.fns.filter((f: string) => f === "count" || f === "distinct" || num.length).map((f: string) => <option key={f} value={f}>{t(FN[f])}</option>)}</select>
            {m.fn !== "count" && <select value={m.field} onChange={e => up({ metrics: def.metrics.map((x: any, j: number) => j === i ? { ...x, field: e.target.value } : x) })}>{(m.fn === "distinct" ? fields : num).map(f => <option key={f.key} value={f.key}>{t(f.label)}</option>)}</select>}
            <button className="sm ghost" aria-label={t("Remove")} onClick={() => up({ metrics: def.metrics.filter((_: any, j: number) => j !== i) })}>✕</button></div>)}
          <button className="sm ghost" onClick={() => up({ metrics: [...def.metrics, num[0] ? { fn: "sum", field: num[0].key } : { fn: "count" }] })}>+ {t("Add number")}</button></Field>
        {!def.metrics.length && <Field label={t("Columns")}><div className="chips">{fields.map(f => <label key={f.key} className="chk"><input type="checkbox" checked={def.columns.includes(f.key)} onChange={e => up({ columns: e.target.checked ? [...def.columns, f.key] : def.columns.filter((c: string) => c !== f.key) })} /> {t(f.label)}</label>)}</div></Field>}
        <Field label={t("5. Show as")}><select value={def.view.type} onChange={e => up({ view: { type: e.target.value } })}>{cat.views.map((v: string) => <option key={v} value={v}>{t(VIEW[v])}</option>)}</select></Field>
        {src.hasDate && def.metrics.length > 0 && <Field label={t("Compare with")}><select value={def.compare} onChange={e => up({ compare: e.target.value })}>
          <option value="none">{t("No comparison")}</option><option value="prev">{t("Previous period")}</option><option value="yoy">{t("Same period last year")}</option></select></Field>}
        {res && <Field label={t("Sort by")}><div className="row" style={{ gap: 4 }}><select value={def.sort?.by || ""} onChange={e => up({ sort: e.target.value ? { by: e.target.value, dir: def.sort?.dir || "desc" } : undefined })}>
          <option value="">{t("Automatic")}</option>{res.columns.filter(c => !c.key.includes("__")).map(c => <option key={c.key} value={c.key}>{t(c.label)}</option>)}</select>
          <select value={def.sort?.dir || "desc"} onChange={e => def.sort && up({ sort: { ...def.sort, dir: e.target.value } })}><option value="desc">{t("High to low")}</option><option value="asc">{t("Low to high")}</option></select></div></Field>}
      </div>
      <div>
        <div className="row"><b>{t("Preview")}</b>{busy && <span className="spin" />}</div>
        {res && <p className="muted small">{rangeText(res)}{res.truncated ? ` · ${t("showing first {0} of {1} rows", res.rows.length, res.total)}` : ""}</p>}
        {err ? <p className="err">{err}</p> : res ? <ReportResult r={res} view={def.view.type} /> : <Loading />}
      </div>
    </div>
    <div className="card">
      <Field label={t("Report name")}><input value={meta.name} maxLength={80} onChange={e => setMeta({ ...meta, name: e.target.value })} /></Field>
      <Field label={t("Description (optional)")}><input value={meta.description} maxLength={300} onChange={e => setMeta({ ...meta, description: e.target.value })} /></Field>
      <Field label={t("Who else can open it")} help={t("Admins can always open every report.")}><div className="chips">{cat.shareRoles.map((r: string) => <label key={r} className="chk"><input type="checkbox" checked={meta.roles.includes(r)} onChange={e => setMeta({ ...meta, roles: e.target.checked ? [...meta.roles, r] : meta.roles.filter((x: string) => x !== r) })} /> {t(ROLE[r])}</label>)}</div></Field>
      <label className="chk"><input type="checkbox" checked={meta.pinned} onChange={e => setMeta({ ...meta, pinned: e.target.checked })} /> {t("Pin to home dashboard")}</label>
      <details><summary>{t("Email on a schedule")}</summary>
        <label className="chk"><input type="checkbox" checked={meta.schedule.enabled} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, enabled: e.target.checked } })} /> {t("Send this report automatically")}</label>
        {!cat.smtp && <p className="muted small">{t("Email is not set up on this server, so the file is only saved on the server. Your administrator can add SMTP settings.")}</p>}
        {meta.schedule.enabled && <>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}><select value={meta.schedule.freq} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, freq: e.target.value } })}><option value="daily">{t("Every day")}</option><option value="weekly">{t("Every week")}</option><option value="monthly">{t("Every month")}</option></select>
            {meta.schedule.freq === "weekly" && <select value={meta.schedule.weekday} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, weekday: Number(e.target.value) } })}>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{t(d)}</option>)}</select>}
            {meta.schedule.freq === "monthly" && <select value={meta.schedule.day} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, day: Number(e.target.value) } })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select>}
            <select value={meta.schedule.hour} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, hour: Number(e.target.value) } })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select>
            <select value={meta.schedule.format} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, format: e.target.value } })}><option value="xlsx">Excel</option><option value="csv">CSV</option></select></div>
          <Field label={t("Send to (emails, comma separated)")}><input value={Array.isArray(meta.schedule.emails) ? meta.schedule.emails.join(", ") : meta.schedule.emails} onChange={e => setMeta({ ...meta, schedule: { ...meta.schedule, emails: e.target.value } })} /></Field></>}
      </details>
      <div className="row-btns"><button onClick={save}>{t("Save report")}</button>
        <button className="ghost" onClick={() => download(s, "/api/report-builder/export?format=xlsx", { method: "POST", body: JSON.stringify({ def, name: meta.name || "report" }) }).catch(e => setErr(e.message))}>{t("Excel")}</button>
        <button className="ghost" onClick={() => download(s, "/api/report-builder/export?format=csv", { method: "POST", body: JSON.stringify({ def, name: meta.name || "report" }) }).catch(e => setErr(e.message))}>{t("CSV")}</button></div>
    </div>
  </div>;
}

function Viewer({ s, rep, canEdit, onEdit, onBack }: { s: Session; rep: any; canEdit: boolean; onEdit: () => void; onBack: () => void }) {
  const [res, setRes] = useState<Result | null>(null); const [err, setErr] = useState(""); const [preset, setPreset] = useState("");
  useEffect(() => { setRes(null); api(s, `/api/custom-reports/${rep.id}/run${preset ? `?preset=${preset}` : ""}`).then(setRes).catch(e => setErr(e.message)); }, [preset]);
  const q = preset ? `&preset=${preset}` : "";
  return <div><div className="row"><h2>{rep.name}</h2><button className="sm ghost" onClick={onBack}>{t("Back")}</button></div>
    {rep.description && <p className="muted">{rep.description}</p>}
    <div className="row-btns">{res?.range && <select value={preset} onChange={e => setPreset(e.target.value)}><option value="">{t("Saved dates")}</option>{["today", "yesterday", "last_7", "this_week", "this_month", "last_month", "this_quarter", "this_fy"].map(p => <option key={p} value={p}>{t(({ today: "Today", yesterday: "Yesterday", last_7: "Last 7 days", this_week: "This week", this_month: "This month", last_month: "Last month", this_quarter: "This quarter", this_fy: "This financial year" } as any)[p])}</option>)}</select>}
      <button className="sm ghost" onClick={() => download(s, `/api/custom-reports/${rep.id}/export?format=xlsx${q}`).catch(e => setErr(e.message))}>{t("Excel")}</button>
      <button className="sm ghost" onClick={() => download(s, `/api/custom-reports/${rep.id}/export?format=csv${q}`).catch(e => setErr(e.message))}>{t("CSV")}</button>
      {canEdit && <button className="sm" onClick={onEdit}>{t("Edit")}</button>}</div>
    {res && <p className="muted small">{rangeText(res)}</p>}
    {err ? <p className="err">{err}</p> : res ? <ReportResult r={res} /> : <Loading />}</div>;
}

/** Reports tab: saved custom reports, templates, builder, and the standard exports. */
export function ReportsHub(p: ViewProps) {
  const { s } = p; const mgr = ["company_admin", "manager"].includes(s.user.role);
  const [list, setList] = useState<any[] | null>(null); const [cat, setCat] = useState<any>(null);
  const [mode, setMode] = useState<{ k: "list" | "build" | "view"; rep?: any }>({ k: "list" }); const [tab, setTab] = useState("mine");
  const load = () => api(s, "/api/custom-reports").then(setList).catch(() => setList([]));
  useEffect(() => { load(); if (mgr) api(s, "/api/report-builder/catalog").then(setCat).catch(() => {}); }, []);
  if (mode.k === "build" && cat) return <Builder s={s} cat={cat} init={mode.rep} onDone={() => { setMode({ k: "list" }); load(); }} />;
  if (mode.k === "view") return <Viewer s={s} rep={mode.rep} canEdit={mgr} onEdit={() => setMode({ k: "build", rep: mode.rep })} onBack={() => setMode({ k: "list" })} />;
  const copy = async (k: string) => { const r = await api(s, `/api/custom-reports/from-template/${k}`, { method: "POST", body: "{}" }); setTab("mine"); await load(); setMode({ k: "view", rep: r }); };
  const del = async (r: any) => { if (confirm(t("Delete report \"{0}\"?", r.name))) { await api(s, `/api/custom-reports/${r.id}`, { method: "DELETE" }); load(); } };
  const pin = async (r: any) => { await api(s, `/api/custom-reports/${r.id}/pin`, { method: "PATCH", body: JSON.stringify({ pinned: !r.pinned }) }); load(); };
  const importFile = async (f: File) => { try { const j = JSON.parse(await f.text()); const r = await api(s, "/api/custom-reports/import", { method: "POST", body: JSON.stringify(j) }); toast(t("Imported {0} reports", r.length)); load(); } catch (e: any) { toast(e.message, "err"); } };
  return <div>
    <div className="row"><h2>{t("Reports")}</h2>{mgr && cat && <button className="sm" onClick={() => setMode({ k: "build" })}>+ {t("New report")}</button>}</div>
    <div className="chiprow">{[["mine", t("My reports")], ...(mgr ? [["templates", t("Ready-made")], ["exports", t("Standard exports")]] : [])].map(([k, l]) => <button key={k} className={`chip ${tab === k ? "on" : "ghost"} sm`} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "mine" && (list == null ? <Loading /> : !list.length ? <Empty icon="📊" title={t("No custom reports yet")} text={mgr ? t("Start from a ready-made report or build your own.") : t("Your manager hasn't shared any reports with you yet.")} action={mgr ? t("See ready-made reports") : undefined} onAction={() => setTab("templates")} />
      : <div>{list.map(r => <div className="row line" key={r.id}><span style={{ cursor: "pointer" }} onClick={() => setMode({ k: "view", rep: r })}><b>{r.pinned ? "📌 " : ""}{r.name}</b><br /><span className="muted small">{r.description}{r.schedule?.enabled ? ` · ⏰ ${t("scheduled")}` : ""}{r.roles?.length ? ` · ${t("shared")}` : ""}</span></span>
        <span className="row-btns"><button className="sm" onClick={() => setMode({ k: "view", rep: r })}>{t("Open")}</button>{mgr && <><button className="sm ghost" onClick={() => pin(r)} aria-label={t("Pin to home dashboard")}>{r.pinned ? t("Unpin") : t("Pin")}</button><button className="sm ghost" onClick={() => setMode({ k: "build", rep: r })}>{t("Edit")}</button><button className="sm ghost" onClick={() => del(r)}>{t("Delete")}</button></>}</span></div>)}</div>)}
    {tab === "mine" && mgr && <p className="muted small">{t("Move reports between companies or servers:")} <a href="#" onClick={e => { e.preventDefault(); download(s, "/api/custom-reports/export").catch(x => toast(x.message, "err")); }}>{t("Export all (JSON)")}</a> · <label className="link" style={{ cursor: "pointer", textDecoration: "underline" }}>{t("Import JSON")}<input type="file" accept="application/json,.json" hidden onChange={e => e.target.files?.[0] && importFile(e.target.files[0])} /></label></p>}
    {tab === "templates" && cat && <div>{cat.templates.map((x: any) => <div className="row line" key={x.key}><span><b>{t(x.name)}</b><br /><span className="muted small">{t(x.description)}</span></span><button className="sm" onClick={() => copy(x.key)}>{t("Use this")}</button></div>)}</div>}
    {tab === "exports" && <StandardExports {...p} />}
  </div>;
}

/** Pinned reports on the home dashboard. */
export function PinnedReports({ s, go }: { s: Session; go?: (t: string) => void }) {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => { api(s, "/api/custom-reports/pinned").then(setList).catch(() => {}); }, []);
  const shown = useMemo(() => list.filter(x => x.result), [list]);
  if (!shown.length) return null;
  return <div className="card"><div className="row"><b>📌 {t("Pinned reports")}</b>{go && <button className="sm ghost" onClick={() => go("reports")}>{t("All reports")}</button>}</div>
    {shown.map(x => <div key={x.id} style={{ marginTop: 8 }}><b className="small">{x.name}</b><ReportResult r={x.result} compact /></div>)}</div>;
}
