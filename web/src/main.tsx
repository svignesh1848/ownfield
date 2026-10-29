import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Toasts, toast, Empty, Loading, Field, fmtCell, ICONS } from "./ui";
import { SetupChecklist, RepHome, DistributorHome, ManagerHome } from "./home";
import { Dashboard, Beats, Orders, MyBeat, OrderForm, Inbox, ShopsMap, OfflineBadge } from "./field";
import { Collections } from "./collect";
import { Catalog, Stock, Schemes, SettingsPage, ImportPage } from "./config";
import { Invoices, Targets, Reports, Visits } from "./step4";
import { PurchaseOrders, DistributorTerms } from "./po";

export type Session = { token: string; user: { id: number; name: string; role: string; companyCode: string | null } };
const SAVED: Record<string, string> = { POST: "Saved", PUT: "Changes saved", PATCH: "Changes saved", DELETE: "Deleted" };
export const api = async (s: Session | null, url: string, opts: RequestInit = {}) => {
  const r = await fetch(url, { ...opts, headers: { ...(opts.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(s ? { Authorization: `Bearer ${s.token}` } : {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  const m = (opts.method || "GET").toUpperCase();
  if (m !== "GET" && !/\/api\/(auth|orders\/preview)/.test(url)) toast(SAVED[m] || "Saved");
  return j;
};

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [f, setF] = useState({ companyCode: "", email: "", password: "" }); const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null); const [busy, setBusy] = useState(false);
  const demo = f.companyCode.trim().toUpperCase() === "DEMO";
  const submit = async (e: any) => {
    e.preventDefault();
    if (!f.companyCode.trim()) return setErr({ field: "companyCode", text: "Enter your company code" });
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr({ field: "email", text: "Enter a valid email, e.g. name@company.com" });
    if (!f.password) return setErr({ field: "password", text: "Enter your password" });
    setBusy(true); setErr(null);
    try { onLogin(await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ ...f, companyCode: f.companyCode.trim(), email: f.email.trim() }) })); }
    catch (x: any) { setErr({ field: /company code/i.test(x.message) ? "companyCode" : /email or password/i.test(x.message) ? "password" : undefined, text: /fetch/i.test(x.message) ? "Can't reach the server. Check your internet connection." : x.message }); }
    finally { setBusy(false); }
  };
  const fe = (k: string) => err?.field === k ? err.text : undefined;
  return <div className="login-wrap"><form className="card login" onSubmit={submit} noValidate>
    <div className="brand"><span className="logo">FF</span><div><h1>FieldForce</h1><p className="muted">Sales & distributor app</p></div></div>
    <Field label="Company code" help="The short code your company uses, e.g. DEMO. Ask your administrator if you don't know it." error={fe("companyCode")}>
      <input autoCapitalize="characters" autoComplete="organization" value={f.companyCode} onChange={e => setF({ ...f, companyCode: e.target.value })} /></Field>
    {demo && <div className="hint"><b>Sample logins for the DEMO company</b><br />Admin: admin@example.com / demo<br />Sales rep: rep@example.com / changeme123<br /><span className="muted">All DEMO data is sample data.</span>
      <div className="row-btns"><button type="button" className="sm ghost" onClick={() => setF({ ...f, email: "admin@example.com", password: "demo" })}>Use admin</button>
        <button type="button" className="sm ghost" onClick={() => setF({ ...f, email: "rep@example.com", password: "changeme123" })}>Use sales rep</button></div></div>}
    <Field label="Email" help="The email address you were registered with." error={fe("email")}>
      <input type="email" inputMode="email" autoComplete="username" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
    <Field label="Password" error={fe("password")}>
      <div className="pw"><input type={show ? "text" : "password"} autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
        <button type="button" className="ghost sm" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button></div></Field>
    {err && !err.field && <p className="err">{err.text}</p>}
    <button className="block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <p className="muted small center">Platform owner? Use company code PLATFORM.</p></form></div>;
}

/** Data table: friendly headers, ₹/dates already formatted by callers or auto-formatted, and a helpful empty state. */
export function Table({ rows, cols, empty, loading }: { rows: any[] | null; cols: string[]; empty?: { title: string; text?: string; action?: string; onAction?: () => void }; loading?: boolean }) {
  if (loading || rows == null) return <Loading />;
  if (!rows.length) return <Empty title={empty?.title || "Nothing here yet"} text={empty?.text} action={empty?.action} onAction={empty?.onAction} />;
  return <div className="scroll"><table><thead><tr>{cols.map(c => <th key={c}>{label(c)}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c}>{fmtCell(r[c])}</td>)}</tr>)}</tbody></table></div>;
}

function Usage({ u }: { u: any }) {
  if (!u) return null;
  return <div className={`usage ${u.atLimit ? "block" : u.warning ? "warn" : ""}`}>
    {u.count} of {u.limit} user seats used {u.atLimit ? "— limit reached. Contact the platform owner to add more." : u.warning ? "— you're close to your limit." : ""}
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
const WORDS: Record<string, string> = { shop_name: "Outlet", shop: "Outlet", rep_name: "Sales rep", doc_date: "Date", pay_date: "Date", sku: "Product code", hsn: "HSN code", gstin: "GSTIN", uom: "Unit",
  base_qty: "Qty", min_qty: "Minimum qty", tax_type: "Tax", taxable: "Value before tax", qty_base: "Qty", created_at: "Created", item_name: "Product", number: "No.", drug_licence: "Drug licence", active: "Active" };
export const label = (k: string) => WORDS[k] || k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

export const TAB_LABEL: Record<string, string> = { home: "Home", beat: "Today's beat", order: "New order", orders: "Orders", collect: "Collect", targets: "Targets", catalog: "Products",
  inbox: "New orders", invoices: "Invoices", collections: "Collections", POs: "Purchase orders", stock: "Stock", profile: "My profile", dashboard: "Team activity", beats: "Beat plans",
  visits: "Visits", reports: "Reports", shops: "Outlets", schemes: "Offers & schemes", distributors: "Distributors", users: "Users", settings: "Company settings", import: "Upload data", more: "More" };
export type Go = (tab: string) => void;
export type ViewProps = { s: Session; cfg: Cfg; reload: () => void; onUsage: (u: any) => void; go: Go };

function Company({ s, onLogout }: { s: Session; onLogout: () => void }) {
  const role = s.user.role, admin = role === "company_admin", mgr = admin || role === "manager";
  const [cfg, setCfg] = useState<Cfg | null>(null); const [usage, setUsage] = useState<any>(null);
  const [tab, setTabRaw] = useState(() => location.hash.slice(1) || "home"); const [more, setMore] = useState(false); const [err, setErr] = useState("");
  const setTab = (t: string) => { setTabRaw(t); setMore(false); history.replaceState(null, "", `#${t}`); window.scrollTo(0, 0); };
  const reload = () => api(s, "/api/company/settings").then(setCfg).catch(e => setErr(e.message));
  useEffect(() => { reload(); if (mgr) api(s, "/api/company/usage").then(setUsage).catch(() => {}); }, []);
  if (!cfg) return err ? <Empty icon="⚠️" title="Couldn't load your company" text={err} action="Try again" onAction={reload} /> : <Loading text="Loading your workspace…" />;
  const f = cfg.settings.features;
  const groups: [string, string[]][] = mgr ? [
    ["Sales", ["home", "dashboard", "orders", "beats", "visits", "targets", "shops", ...(f.schemes ? ["schemes"] : [])]],
    ["Distributors", ["distributors", ...(f.purchaseOrders ? ["POs"] : []), ...(f.stock ? ["stock"] : [])]],
    ["Finance", [...(f.invoicing ? ["invoices", "collections"] : []), "reports"]],
    ["Setup", ["catalog", "users", ...(admin ? ["settings", "import"] : [])]]]
    : role === "sales_rep" ? [["Menu", ["home", "beat", "order", "orders", ...(f.invoicing ? ["collect"] : []), "targets", "catalog"]]]
    : [["Menu", ["home", "inbox", ...(f.invoicing && f.distributorBilling ? ["invoices", "collections"] : []), ...(f.stock ? ["stock"] : []), ...(f.purchaseOrders ? ["POs"] : []), "profile", "catalog"]]];
  const tabs = groups.flatMap(g => g[1]);
  const primary = (mgr ? ["home", "orders", f.invoicing ? "collections" : "dashboard", "reports"] : role === "sales_rep" ? ["home", "beat", "order", f.invoicing ? "collect" : "orders"]
    : ["home", "inbox", f.invoicing && f.distributorBilling ? "invoices" : "catalog", f.stock ? "stock" : f.purchaseOrders ? "POs" : "profile"]).filter(t => tabs.includes(t));
  const cur = tabs.includes(tab) ? tab : "home";
  const views: Record<string, any> = { home: mgr ? ManagerHome : role === "sales_rep" ? RepHome : DistributorHome, dashboard: Dashboard, beats: Beats, orders: Orders, beat: MyBeat, order: OrderForm, inbox: Inbox, shops: ShopsMap,
    catalog: Catalog, stock: Stock, invoices: Invoices, targets: Targets, reports: Reports, visits: Visits, POs: PurchaseOrders, distributors: DistributorTerms, profile: DistributorTerms, schemes: Schemes,
    collections: Collections, collect: Collections, settings: SettingsPage, import: ImportPage, users: Users };
  const C = views[cur];
  const Item = ({ t }: { t: string }) => <button className={`nav-item ${t === cur ? "on" : ""}`} onClick={() => setTab(t)}><span className="ic" aria-hidden>{ICONS[t]}</span><span>{TAB_LABEL[t] || t}</span></button>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand sm"><span className="logo">FF</span><b>FieldForce</b></div>
      {groups.map(([g, ts]) => <div key={g} className="group"><div className="group-h">{g}</div>{ts.map(t => <Item key={t} t={t} />)}</div>)}
      <div className="who"><b>{s.user.name}</b><span>{ROLE[role]} · {s.user.companyCode}</span><button className="ghost sm" onClick={onLogout}>Sign out</button></div></aside>
    <div className="content">
      <header className="top"><div className="brand sm"><span className="logo">FF</span><b>{s.user.companyCode}</b></div><span className="who-sm" title={s.user.name}>{s.user.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}</span></header>
      {mgr && cur === "home" && <Usage u={usage} />}<OfflineBadge s={s} />
      <section className="card main-card"><C s={s} cfg={cfg} reload={reload} onUsage={setUsage} go={setTab} /></section>
    </div>
    <nav className="bottom">{primary.map(t => <Item key={t} t={t} />)}
      <button className={`nav-item ${more ? "on" : ""}`} onClick={() => setMore(!more)}><span className="ic" aria-hidden>{ICONS.more}</span><span>More</span></button></nav>
    {more && <div className="sheet-bg" onClick={() => setMore(false)}><div className="sheet" onClick={e => e.stopPropagation()}>
      {groups.map(([g, ts]) => <div key={g}><div className="group-h">{g}</div><div className="sheet-grid">{ts.map(t => <Item key={t} t={t} />)}</div></div>)}
      <div className="who"><b>{s.user.name}</b><span>{ROLE[role]} · {s.user.companyCode}</span><button className="ghost sm" onClick={onLogout}>Sign out</button></div></div></div>}
  </div>;
}
const ROLE: Record<string, string> = { company_admin: "Administrator", manager: "Manager", sales_rep: "Sales rep", distributor: "Distributor", platform_owner: "Platform owner" };

function Users({ s, cfg, go }: ViewProps) {
  const [rows, setRows] = useState<any[] | null>(null); useEffect(() => { api(s, "/api/users").then(setRows); }, []);
  return <><h2>Users</h2><Table rows={rows.map(r => ({ ...r, role: ROLE[r.role] || r.role }))} cols={["name", "email", "role", ...(cfg.settings.features.drugLicence ? ["drug_licence"] : []), "active"]}
    empty={{ title: "No users yet", text: "Add sales reps, managers and distributors by uploading a users sheet.", action: "Upload users", onAction: () => go("import") }} /></>;
}

function App() {
  const [s, setS] = useState<Session | null>(() => JSON.parse(localStorage.getItem("ff") || "null"));
  const set = (v: Session | null) => { setS(v); v ? localStorage.setItem("ff", JSON.stringify(v)) : localStorage.removeItem("ff"); };
  if (!s) return <><Login onLogin={set} /><Toasts /></>;
  return <>{s.user.role === "platform_owner" ? <main><header className="top"><b>FieldForce · Platform</b><button className="sm ghost" onClick={() => set(null)}>Sign out</button></header><Platform s={s} /></main>
    : <Company s={s} onLogout={() => { set(null); location.hash = ""; }} />}<Toasts /></>;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
createRoot(document.getElementById("root")!).render(<App />);
