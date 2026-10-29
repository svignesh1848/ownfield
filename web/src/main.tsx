import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Dashboard, Beats, Orders, MyBeat, OrderForm, Inbox, ShopsMap, OfflineBadge } from "./field";
import { Catalog, Stock, Schemes, SettingsPage, ImportPage } from "./config";
import { Invoices, Targets, Reports, Visits } from "./step4";
import { PurchaseOrders, DistributorTerms } from "./po";

export type Session = { token: string; user: { id: number; name: string; role: string; companyCode: string | null } };
export const api = async (s: Session | null, url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { ...opts, headers: { ...(opts.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(s ? { Authorization: `Bearer ${s.token}` } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [f, setF] = useState({ companyCode: "", email: "", password: "" }); const [err, setErr] = useState("");
  return <form className="card login" onSubmit={async e => { e.preventDefault(); try { onLogin(await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify(f) })); } catch (x: any) { setErr(x.message); } }}>
    <h1>FieldForce OSS</h1><p className="muted">Field sales & distributor management</p>
    {(["companyCode", "email", "password"] as const).map(k => <input key={k} placeholder={k === "companyCode" ? "Company code (PLATFORM for owner)" : k} type={k === "password" ? "password" : "text"} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />)}
    {err && <p className="err">{err}</p>}<button>Sign in</button></form>;
}

export function Table({ rows, cols }: { rows: any[]; cols: string[] }) {
  if (!rows.length) return <p className="muted">No records yet.</p>;
  return <div className="scroll"><table><thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c}>{String(r[c] ?? "")}</td>)}</tr>)}</tbody></table></div>;
}

function Usage({ u }: { u: any }) {
  if (!u) return null;
  return <div className={`usage ${u.atLimit ? "block" : u.warning ? "warn" : ""}`}>
    Users: {u.count}/{u.limit} ({u.pct}%) {u.atLimit ? "— limit reached, contact platform owner" : u.warning ? "— nearing limit" : ""}
    <div className="bar"><span style={{ width: `${Math.min(100, u.pct)}%` }} /></div></div>;
}

function Platform({ s }: { s: Session }) {
  const [list, setList] = useState<any[]>([]); const [msg, setMsg] = useState(""); const [tpl, setTpl] = useState<any[]>([]);
  const [f, setF] = useState({ code: "", name: "", userLimit: "10", email: "", adminName: "", password: "" }); const [industry, setIndustry] = useState("apparel");
  const load = () => api(s, "/api/platform/companies").then(setList);
  useEffect(() => { load(); api(null, "/api/templates").then(setTpl); }, []);
  return <>
    <section className="card"><h2>Companies</h2>
      {list.map(c => <div key={c.id} className="row"><b>{c.code}</b> {c.name} <span className="pill">{c.industry}</span><Usage u={c.usage} />
        <button className="sm" onClick={async () => { const v = prompt("New user limit", c.user_limit); if (v) { await api(s, `/api/platform/companies/${c.id}`, { method: "PATCH", body: JSON.stringify({ userLimit: Number(v) }) }); load(); } }}>Set limit</button></div>)}
    </section>
    <form className="card" onSubmit={async e => { e.preventDefault(); try { await api(s, "/api/platform/companies", { method: "POST", body: JSON.stringify({ code: f.code, name: f.name, industry, userLimit: Number(f.userLimit), admin: { email: f.email, name: f.adminName, password: f.password } }) }); setMsg("Created"); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h2>New company</h2>
      <label>Industry template</label>
      <div className="tpls">{tpl.map(t => <label key={t.id} className={`tpl ${industry === t.id ? "on" : ""}`}><input type="radio" name="ind" checked={industry === t.id} onChange={() => setIndustry(t.id)} /><b>{t.label}</b><span>{t.description}</span></label>)}</div>
      {Object.keys(f).map(k => <input key={k} placeholder={k} value={(f as any)[k]} type={k === "password" ? "password" : "text"} onChange={e => setF({ ...f, [k]: e.target.value })} />)}
      <button>Create</button><p>{msg}</p></form></>;
}

export type Cfg = { industry: string; settings: { features: Record<string, boolean>; attributes: string[]; uoms: { code: string; factor: number }[]; customFields: Record<string, any[]>; po?: any; gst?: any } };
export const label = (k: string) => k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

function Company({ s }: { s: Session }) {
  const role = s.user.role, admin = role === "company_admin", mgr = admin || role === "manager";
  const [cfg, setCfg] = useState<Cfg | null>(null); const [usage, setUsage] = useState<any>(null); const [tab, setTab] = useState("");
  const reload = () => api(s, "/api/company/settings").then(setCfg);
  useEffect(() => { reload(); if (mgr) api(s, "/api/company/usage").then(setUsage); }, []);
  if (!cfg) return <p className="muted">Loading…</p>;
  const f = cfg.settings.features;
  const tabs = mgr ? ["dashboard", "beats", "orders", ...(f.invoicing ? ["invoices"] : []), "visits", "targets", "reports", "catalog", "shops", ...(f.stock ? ["stock"] : []), ...(f.schemes ? ["schemes"] : []), ...(f.purchaseOrders ? ["POs"] : []), "distributors", "users", ...(admin ? ["settings", "import"] : [])]
    : role === "sales_rep" ? ["beat", "order", "orders", "targets", "catalog"] : ["inbox", ...(f.invoicing && f.distributorBilling ? ["invoices"] : []), ...(f.purchaseOrders ? ["POs"] : []), ...(f.stock ? ["stock"] : []), "profile", "catalog"];
  const cur = tabs.includes(tab) ? tab : tabs[0];
  const views: Record<string, any> = { dashboard: Dashboard, beats: Beats, orders: Orders, beat: MyBeat, order: OrderForm, inbox: Inbox, shops: ShopsMap,
    catalog: Catalog, stock: Stock, invoices: Invoices, targets: Targets, reports: Reports, visits: Visits, POs: PurchaseOrders, distributors: DistributorTerms, profile: DistributorTerms, schemes: Schemes, settings: SettingsPage, import: ImportPage, users: Users };
  const C = views[cur];
  return <>
    {mgr && <Usage u={usage} />}<OfflineBadge s={s} />
    <nav>{tabs.map(t => <button key={t} className={t === cur ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
    <section className="card"><C s={s} cfg={cfg} reload={reload} onUsage={setUsage} /></section></>;
}

function Users({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [rows, setRows] = useState<any[]>([]); useEffect(() => { api(s, "/api/users").then(setRows); }, []);
  return <><h2>Users</h2><Table rows={rows} cols={["name", "email", "role", ...(cfg.settings.features.drugLicence ? ["drug_licence"] : []), "active"]} /></>;
}

function App() {
  const [s, setS] = useState<Session | null>(() => JSON.parse(localStorage.getItem("ff") || "null"));
  const set = (v: Session | null) => { setS(v); v ? localStorage.setItem("ff", JSON.stringify(v)) : localStorage.removeItem("ff"); };
  if (!s) return <Login onLogin={set} />;
  return <main><header><b>FieldForce OSS</b><span>{s.user.companyCode || "Platform"} · {s.user.name} ({s.user.role.replace("_", " ")})</span><button className="sm" onClick={() => set(null)}>Logout</button></header>
    {s.user.role === "platform_owner" ? <Platform s={s} /> : <Company s={s} />}</main>;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
createRoot(document.getElementById("root")!).render(<App />);
