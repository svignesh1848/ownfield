// SPDX-License-Identifier: AGPL-3.0-only
// Data workspace: read-only SQL over this company's data (admins + data analysts), saved datasets, BI access.
import React, { useEffect, useState } from "react";
import { api, type ViewProps } from "./main";
import { t } from "./i18n";
import { Empty, Loading, Field, fmtCell } from "./ui";

const EXAMPLE = "SELECT u.name AS rep, count(o.id) AS orders, sum(o.total) AS value\nFROM orders o JOIN users u ON u.id = o.rep_id\nGROUP BY u.name\nORDER BY value DESC";

export function DataWorkspace({ s }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [schema, setSchema] = useState<any>(null); const [err, setErr] = useState(""); const [sql, setSql] = useState(EXAMPLE);
  const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false); const [ds, setDs] = useState<any[]>([]); const [cur, setCur] = useState<any>(null);
  const [name, setName] = useState(""); const [tab, setTab] = useState("sql");
  const loadDs = () => api(s, "/api/data-workspace/datasets").then(setDs).catch(() => {});
  useEffect(() => { api(s, "/api/data-workspace/schema").then(setSchema).catch(e => setErr(e.message)); loadDs(); }, []);
  if (err) return <Empty icon="🔒" title={t("Data workspace")} text={err} />;
  if (!schema) return <Loading />;
  const run = async () => { setBusy(true); try { setRes(await api(s, "/api/data-workspace/query", { method: "POST", body: JSON.stringify({ sql }) })); } catch (e: any) { setRes({ error: e.message }); } finally { setBusy(false); } };
  const save = async () => { if (!name.trim()) return setRes({ error: t("Give the dataset a name") });
    try { const d = await api(s, cur ? `/api/data-workspace/datasets/${cur.id}` : "/api/data-workspace/datasets", { method: cur ? "PUT" : "POST", body: JSON.stringify({ name, sql }) }); setCur(d); loadDs(); } catch (e: any) { setRes({ error: e.message }); } };
  return <div>
    <h2>{t("Data workspace")}</h2>
    <p className="muted small">{t("Read-only SQL over your company's data only. Every query is logged. Save a query as a dataset to use it in the report builder.")}</p>
    <div className="chiprow">{[["sql", t("SQL editor")], ...(admin ? [["access", t("Access")], ["history", t("Query log")]] : [])].map(([k, l]) => <button key={k} className={`chip sm ${tab === k ? "on" : "ghost"}`} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "sql" && <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
      <div style={{ gridColumn: "span 2" }}>
        <textarea value={sql} onChange={e => setSql(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); }} rows={9} spellCheck={false} style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }} aria-label={t("SQL query")} />
        <div className="row-btns"><button onClick={run} disabled={busy}>{busy ? t("Running…") : t("Run (Ctrl+Enter)")}</button>
          <input placeholder={t("Dataset name")} value={name} onChange={e => setName(e.target.value)} style={{ maxWidth: 200 }} /><button className="ghost" onClick={save}>{cur ? t("Update dataset") : t("Save as dataset")}</button>
          {cur && <button className="ghost sm" onClick={() => { setCur(null); setName(""); }}>{t("New")}</button>}</div>
        {res?.error && <p className="err">{res.error}</p>}
        {res?.rows && <><p className="muted small">{t("{0} rows in {1} ms", res.rows.length, res.ms)}{res.truncated ? ` · ${t("more rows not shown")}` : ""}</p>
          {res.rows.length ? <div className="scroll"><table><thead><tr>{res.columns.map((c: any) => <th key={c.key}>{c.key}</th>)}</tr></thead>
            <tbody>{res.rows.map((r: any, i: number) => <tr key={i}>{res.columns.map((c: any) => <td key={c.key}>{fmtCell(r[c.key])}</td>)}</tr>)}</tbody></table></div> : <p>{t("No rows")}</p>}</>}
        {ds.length > 0 && <><h3>{t("Saved datasets")}</h3>{ds.map(d => <div className="row line" key={d.id}><span><b>{d.name}</b><br /><span className="muted small">{d.columns.map((c: any) => c.key).join(", ")}</span></span>
          <span className="row-btns"><button className="sm ghost" onClick={() => { setSql(d.sql); setName(d.name); setCur(d); }}>{t("Open")}</button>
            <button className="sm ghost" onClick={async () => { if (confirm(t("Delete dataset \"{0}\"?", d.name))) { await api(s, `/api/data-workspace/datasets/${d.id}`, { method: "DELETE" }); loadDs(); } }}>{t("Delete")}</button></span></div>)}</>}
      </div>
      <div><b>{t("Tables")}</b><p className="muted small">{t("Max {0} rows, {1} s per query.", schema.limits.maxRows, Math.round(schema.limits.timeoutMs / 1000))}</p>
        {schema.tables.map((tb: any) => <details key={tb.name}><summary><code>{tb.name}</code></summary><p className="muted small">{tb.doc}</p>
          {tb.columns.map((c: any) => <div key={c.name} className="small"><code style={{ cursor: "pointer" }} onClick={() => setSql(sql + " " + c.name)}>{c.name}</code> <span className="muted">{c.doc}</span></div>)}</details>)}</div>
    </div>}
    {tab === "access" && admin && <Access p={{ s } as any} />}
    {tab === "history" && admin && <History p={{ s } as any} />}
  </div>;
}

function Access({ p }: { p: ViewProps }) {
  const { s } = p; const [users, setUsers] = useState<any[]>([]); const [sel, setSel] = useState<number[]>([]); const [bi, setBi] = useState<any>(null); const [cred, setCred] = useState<any>(null); const [msg, setMsg] = useState("");
  useEffect(() => { api(s, "/api/users").then(setUsers); api(s, "/api/data-workspace/analysts").then(setSel); api(s, "/api/data-workspace/bi-access").then(setBi).catch(() => {}); }, []);
  const toggleBi = async (on: boolean) => { try { const r = await api(s, "/api/data-workspace/bi-access", { method: "PUT", body: JSON.stringify({ enabled: on }) }); setBi({ ...bi, enabled: r.enabled }); setCred(on ? r : null); setMsg(""); } catch (e: any) { setMsg(e.message); } };
  return <div>
    <Field label={t("Data analysts")} help={t("These people can use the SQL editor. Admins always can.")}><div className="chips">{users.filter(u => ["manager", "sales_rep", "distributor"].includes(u.role)).map(u =>
      <label key={u.id} className="chk"><input type="checkbox" checked={sel.includes(u.id)} onChange={e => setSel(e.target.checked ? [...sel, u.id] : sel.filter(x => x !== u.id))} /> {u.name}</label>)}</div></Field>
    <button onClick={() => api(s, "/api/data-workspace/analysts", { method: "PUT", body: JSON.stringify({ userIds: sel }) }).then(setSel)}>{t("Save")}</button>
    <h3>{t("BI tool access (Metabase, Power BI, Superset)")}</h3>
    <p className="muted small">{t("A read-only database login that sees only your company's tables. Off by default. Your server host must allow database connections.")}</p>
    {bi && <label className="chk"><input type="checkbox" checked={!!bi.enabled} onChange={e => toggleBi(e.target.checked)} /> {bi.enabled ? t("On") : t("Off")}</label>}
    {bi?.enabled && !cred && <button className="sm ghost" onClick={() => toggleBi(true)}>{t("Make a new password")}</button>}
    {cred && <div className="hint"><b>{t("Copy now — the password is shown only once.")}</b><br />Host: {cred.host}<br />Port: {cred.port}<br />Database: {cred.database}<br />User: <code>{cred.user}</code><br />Password: <code>{cred.password}</code><br />Schema: <code>{cred.schema}</code></div>}
    {msg && <p className="err">{msg}</p>}
  </div>;
}
function History({ p }: { p: ViewProps }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api(p.s, "/api/data-workspace/history").then(setRows); }, []);
  if (!rows) return <Loading />;
  return <div className="scroll"><table><thead><tr><th>{t("When")}</th><th>{t("Who")}</th><th>{t("Result")}</th><th>SQL</th></tr></thead><tbody>{rows.map((r, i) => { const d = (() => { try { return JSON.parse(r.detail); } catch { return {}; } })();
    return <tr key={i}><td>{fmtCell(r.at)}</td><td>{r.name}</td><td>{r.action === "workspace.sql" ? `${d.rows ?? ""} ${t("rows")}` : r.action === "workspace.sql_refused" ? `⚠ ${d.error || ""}` : r.action}</td><td><code className="small">{String(d.sql || "").slice(0, 200)}</code></td></tr>; })}</tbody></table></div>;
}
