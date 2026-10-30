// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 Vignesh S. OwnField is a trademark of Vignesh S. See TRADEMARKS.md.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Toasts, toast, Empty, Loading, Field, fmtCell, ICONS } from "./ui";
import { SetupChecklist, RepHome, DistributorHome, ManagerHome, DiskAlert } from "./home";
import { Dashboard, Beats, Orders, MyBeat, OrderForm, Inbox, ShopsMap, OfflineBadge, queue, Bell } from "./field";
import { Collections } from "./collect";
import { Catalog, Stock, Schemes, SettingsPage, ImportPage } from "./config";
import { Invoices, Targets, Visits } from "./step4";
import { PurchaseOrders, DistributorTerms } from "./po";
import { Integrations } from "./integrations";
import { ReportsHub, PinnedReports } from "./reports";
import { DataWorkspace } from "./workspace";
import { FlowSettings } from "./flow";
import { t, t as i18n, LANGS, lang, setLang } from "./i18n";
import { VanRep, VanAdmin, Inventory, Claims, Leads, Trail, useTracking, Coverage, Surveys, Messages } from "./ops";
import { UsersAdmin, SecurityPage, MyAccount, ResetPassword, useIdleLogout, deviceId } from "./security";
import { AuditSetup, AuditFill, AuditReport, MyExpenses, ExpenseApprovals, MyLeave, LeaveApprovals, IncentiveRules, Incentives, RetailerHome } from "./phase3";

export type Session = { token: string; idleMinutes?: number; enrollTotp?: boolean; user: { id: number; name: string; role: string; companyCode: string | null } };
const SAVED: Record<string, string> = { POST: t("Saved"), PUT: t("Changes saved"), PATCH: t("Changes saved"), DELETE: t("Deleted") };
// Offline: these lists are cached on the phone and served when there is no network.
const CACHE_GET = /^\/api\/(shops|items|products|company\/settings|beats|schemes|outstanding|van\/today|leads|visits|audit-templates|surveys\/forms)(\?|$)/;
// Offline: these writes are queued (server dedupes by clientRef) and sent when the network returns.
const QUEUE_POST = /^\/api\/(orders|payments|van\/sale|visits\/offline|surveys\/responses)$/;
export const api = async (s: Session | null, url: string, opts: RequestInit = {}): Promise<any> => {
  const m0 = (opts.method || "GET").toUpperCase();
  if (s && m0 === "POST" && QUEUE_POST.test(url) && typeof opts.body === "string" && !navigator.onLine) {
    const body = JSON.parse(opts.body); body.clientRef = body.clientRef || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    queue.set([...queue.get(), { ...body, _url: url }]); toast(t("Saved offline — will sync when online")); return { queued: true, ...body };
  }
  let r: Response;
  try { r = await fetch(url, { ...opts, headers: { ...(opts.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(s ? { Authorization: `Bearer ${s.token}` } : {}) } }); }
  catch (e) { const c = m0 === "GET" && CACHE_GET.test(url) && localStorage.getItem("ff-c:" + url); if (c) return JSON.parse(c); throw e; }
  if (r.ok && m0 === "GET" && CACHE_GET.test(url)) { const c = r.clone(); c.text().then(t => { try { if (t.length < 500_000) localStorage.setItem("ff-c:" + url, t); } catch { /* storage full */ } }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && s) { localStorage.removeItem("ff"); setTimeout(() => location.reload(), 1500); }
  if (!r.ok) throw Object.assign(new Error(t(j.error || r.statusText)), { body: j });
  const m = (opts.method || "GET").toUpperCase();
  if (m !== "GET" && !/\/api\/(auth|orders\/preview|report-builder\/preview|data-workspace\/query)/.test(url)) toast(SAVED[m] || t("Saved"));
  return j;
};

function LangPicker() {
  return <label className="lang-pick">🌐 {t("Language")} <select value={lang()} onChange={e => setLang(e.target.value)}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [f, setF] = useState({ companyCode: "", email: "", password: "", totp: "" }); const [show, setShow] = useState(false); const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null); const [busy, setBusy] = useState(false);
  const demo = f.companyCode.trim().toUpperCase() === "DEMO";
  const submit = async (e: any) => {
    e.preventDefault();
    if (!f.companyCode.trim()) return setErr({ field: "companyCode", text: t("Enter your company code") });
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return setErr({ field: "email", text: t("Enter a valid email, e.g. name@company.com") });
    if (!f.password) return setErr({ field: "password", text: t("Enter your password") });
    setBusy(true); setErr(null);
    try { onLogin(await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ ...f, totp: f.totp || undefined, deviceId: deviceId(), companyCode: f.companyCode.trim(), email: f.email.trim() }) })); }
    catch (x: any) { if (x.body?.totpRequired) { setNeedTotp(true); setErr({ field: "totp", text: x.message }); return; } setErr({ field: /company code/i.test(x.message) ? "companyCode" : /email or password/i.test(x.message) ? "password" : undefined, text: /fetch/i.test(x.message) ? t("Can't reach the server. Check your internet connection.") : x.message }); }
    finally { setBusy(false); }
  };
  const fe = (k: string) => err?.field === k ? err.text : undefined;
  return <div className="login-wrap"><form className="card login" onSubmit={submit} noValidate>
    <div className="brand"><img className="logo" src="/logo-mark.svg" alt="OwnField" /><div><h1>{t("OwnField")}</h1><p className="muted">{t("Own your sales.")}</p><p className="muted small">{t("Sales & distributor app")}</p></div></div>
    <Field label={t("Company code")} help={t("The short code your company uses, e.g. DEMO. Ask your administrator if you don't know it.")} error={fe("companyCode")}>
      <input autoCapitalize="characters" autoComplete="organization" value={f.companyCode} onChange={e => setF({ ...f, companyCode: e.target.value })} /></Field>
    {demo && <div className="hint"><b>{t("Sample logins for the DEMO company")}</b><br />{t("Admin: admin@example.com / Demo@2026")}<br />{t("Sales rep: rep@example.com / Demo@2026")}<br />{t("Distributor: distributor@example.com / Demo@2026")}<br />{t("Shop (retailer): retailer@example.com / Demo@2026")}<br /><span className="muted">{t("All DEMO data is sample data.")}</span>
      <div className="row-btns"><button type="button" className="sm ghost" onClick={() => setF({ ...f, email: "admin@example.com", password: "Demo@2026" })}>{t("Use admin")}</button>
        <button type="button" className="sm ghost" onClick={() => setF({ ...f, email: "rep@example.com", password: "Demo@2026" })}>{t("Use sales rep")}</button>
        <button type="button" className="sm ghost" onClick={() => setF({ ...f, email: "retailer@example.com", password: "Demo@2026" })}>{t("Use shop")}</button></div></div>}
    <Field label={t("Email")} help={t("The email address you were registered with.")} error={fe("email")}>
      <input type="email" inputMode="email" autoComplete="username" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
    <Field label={t("Password")} error={fe("password")}>
      <div className="pw"><input type={show ? "text" : "password"} autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
        <button type="button" className="ghost sm" aria-label={show ? t("Hide password") : t("Show password")} onClick={() => setShow(!show)}>{show ? t("Hide") : t("Show")}</button></div></Field>
    {needTotp && <Field label={t("6-digit code from your authenticator app")} error={fe("totp")}>
      <input inputMode="numeric" autoComplete="one-time-code" value={f.totp} onChange={e => setF({ ...f, totp: e.target.value })} /></Field>}
    {err && !err.field && <p className="err">{err.text}</p>}
    <button className="block" disabled={busy}>{busy ? t("Signing in…") : t("Sign in")}</button>
    <p className="center"><a href="#reset">{t("Have a reset code from your administrator?")}</a></p>
    <p className="center"><a href="#signup">{t("New here? Create your company")}</a></p>
    <p className="muted small center">{t("Platform owner? Use company code PLATFORM.")}</p>
    <LangPicker /><p className="muted small center copy">© 2026 Vignesh S. OwnField is a trademark of Vignesh S. · <a href="/privacy.html">{t("Privacy")}</a></p></form></div>;
}

function Signup({ onLogin }: { onLogin: (s: Session) => void }) {
  const [f, setF] = useState({ companyName: "", companyCode: "", industry: "", adminName: "", email: "", password: "", confirm: "", website: "" }); const [consent, setConsent] = useState(false);
  const [codeEdited, setCodeEdited] = useState(false); const [codeOk, setCodeOk] = useState<null | { available: boolean; suggestion?: string }>(null);
  const [tpl, setTpl] = useState<any[]>([]); const [show, setShow] = useState(false);
  const [err, setErr] = useState<{ field?: string; text: string } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api(null, "/api/templates").then(setTpl).catch(() => {}); }, []);
  const set = (k: string, v: string) => setF(p => ({ ...p, [k]: v }));
  useEffect(() => {
    const q = codeEdited ? `code=${encodeURIComponent(f.companyCode)}` : `name=${encodeURIComponent(f.companyName)}`;
    if (!(codeEdited ? f.companyCode : f.companyName).trim()) { setCodeOk(null); return; }
    const t = setTimeout(() => api(null, `/api/signup/check-code?${q}`).then(r => {
      if (!codeEdited) { const c = r.available ? r.code : r.suggestion || r.code; setF(p => ({ ...p, companyCode: c })); setCodeOk({ available: true }); }
      else setCodeOk(r);
    }).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [f.companyName, f.companyCode, codeEdited]);
  const submit = async (e: any) => {
    e.preventDefault();
    const fail = (field: string, text: string) => setErr({ field, text });
    if (f.companyName.trim().length < 2) return fail("companyName", t("Enter your company name"));
    if (!/^[A-Za-z0-9]{3,12}$/.test(f.companyCode.trim())) return fail("companyCode", t("Use 3–12 letters or numbers, no spaces"));
    if (!f.industry) return fail("industry", t("Pick what your business sells"));
    if (f.adminName.trim().length < 2) return fail("adminName", t("Enter your name"));
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return fail("email", t("Enter a valid email, e.g. name@company.com"));
    if (f.password.length < 8 || !/[A-Za-z]/.test(f.password) || !/[0-9]/.test(f.password)) return fail("password", t("Use at least 8 characters with a letter and a number"));
    if (f.password !== f.confirm) return fail("confirm", t("Passwords don't match"));
    if (!consent) return fail("consent", t("Please accept the privacy notice to continue"));
    setBusy(true); setErr(null);
    try {
      const { confirm, ...body } = f;
      const r = await api(null, "/api/signup", { method: "POST", body: JSON.stringify({ ...body, consent, companyCode: f.companyCode.trim().toUpperCase(), email: f.email.trim() }) });
      location.hash = "home"; onLogin(r); toast(t("Welcome! Your company is ready."));
    } catch (x: any) {
      const field = /code/i.test(x.message) ? "companyCode" : /email/i.test(x.message) ? "email" : /password/i.test(x.message) ? "password" : undefined;
      setErr({ field, text: /fetch/i.test(x.message) ? t("Can't reach the server. Check your internet connection.") : x.message });
    } finally { setBusy(false); }
  };
  const fe = (k: string) => err?.field === k ? err.text : undefined;
  return <div className="login-wrap"><form className="card login" onSubmit={submit} noValidate>
    <div className="brand"><img className="logo" src="/logo-mark.svg" alt="OwnField" /><div><h1>{t("Create your company")}</h1><p className="muted">{t("Free plan · up to 5 users · no card needed")}</p></div></div>
    <Field label={t("Company name")} error={fe("companyName")}>
      <input autoComplete="organization" value={f.companyName} onChange={e => set("companyName", e.target.value)} /></Field>
    <Field label={t("Company code")} help={codeOk && !codeOk.available ? t("Taken. Try {0}.", codeOk.suggestion) : t("Your team types this to sign in. You can change it.")} error={fe("companyCode")}>
      <input autoCapitalize="characters" maxLength={12} value={f.companyCode} onChange={e => { setCodeEdited(true); set("companyCode", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); }} /></Field>
    <Field label={t("What does your business sell?")} error={fe("industry")}>
      <select value={f.industry} onChange={e => set("industry", e.target.value)}><option value="">{t("Choose one…")}</option>
        {tpl.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></Field>
    {f.industry && <p className="muted small">{tpl.find(t => t.id === f.industry)?.description}</p>}
    <Field label={t("Your name")} error={fe("adminName")}>
      <input autoComplete="name" value={f.adminName} onChange={e => set("adminName", e.target.value)} /></Field>
    <Field label={t("Your email")} help={t("You'll sign in with this.")} error={fe("email")}>
      <input type="email" inputMode="email" autoComplete="email" value={f.email} onChange={e => set("email", e.target.value)} /></Field>
    <Field label={t("Password")} help={t("At least 8 characters, with a letter and a number.")} error={fe("password")}>
      <div className="pw"><input type={show ? "text" : "password"} autoComplete="new-password" value={f.password} onChange={e => set("password", e.target.value)} />
        <button type="button" className="ghost sm" onClick={() => setShow(!show)}>{show ? t("Hide") : t("Show")}</button></div></Field>
    <Field label={t("Confirm password")} error={fe("confirm")}>
      <input type={show ? "text" : "password"} autoComplete="new-password" value={f.confirm} onChange={e => set("confirm", e.target.value)} /></Field>
    <input style={{ display: "none" }} tabIndex={-1} autoComplete="off" value={f.website} onChange={e => set("website", e.target.value)} aria-hidden="true" />
    <label className="small"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> {t("I have read the")}{" "}<a href="/privacy.html" target="_blank" rel="noopener">{t("privacy notice")}</a> {t("and agree to my data being processed to run this account.")}</label>
    {fe("consent") && <p className="err">{fe("consent")}</p>}
    {err && !err.field && <p className="err">{err.text}</p>}
    <button className="block" disabled={busy}>{busy ? t("Creating…") : t("Create company")}</button>
    <p className="center"><a href="#">{t("Already have an account? Sign in")}</a></p></form></div>;
}

/** Data table: friendly headers, ₹/dates already formatted by callers or auto-formatted, and a helpful empty state. */
export function Table({ rows, cols, empty, loading }: { rows: any[] | null; cols: string[]; empty?: { title: string; text?: string; action?: string; onAction?: () => void }; loading?: boolean }) {
  if (loading || rows == null) return <Loading />;
  if (!rows.length) return <Empty title={empty?.title || t("Nothing here yet")} text={empty?.text} action={empty?.action} onAction={empty?.onAction} />;
  return <div className="scroll"><table><thead><tr>{cols.map(c => <th key={c}>{label(c)}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{cols.map(c => <td key={c}>{fmtCell(r[c])}</td>)}</tr>)}</tbody></table></div>;
}

function Usage({ u }: { u: any }) {
  if (!u) return null;
  return <div className={`usage ${u.atLimit ? "block" : u.warning ? "warn" : ""}`}>
    {u.count} of {u.limit} {t("user seats used")}{" "}{u.atLimit ? t("— limit reached. Contact the platform owner to add more.") : u.warning ? t("— you're close to your limit.") : ""}
    <div className="bar"><span style={{ width: `${Math.min(100, u.pct)}%` }} /></div></div>;
}

function Platform({ s }: { s: Session }) {
  const [list, setList] = useState<any[]>([]); const [msg, setMsg] = useState(""); const [tpl, setTpl] = useState<any[]>([]);
  const [f, setF] = useState({ code: "", name: "", userLimit: "10", email: "", adminName: "", password: "" }); const [industry, setIndustry] = useState("apparel");
  const load = () => api(s, "/api/platform/companies").then(setList);
  useEffect(() => { load(); api(null, "/api/templates").then(setTpl); }, []);
  return <>
    <DiskAlert s={s} />
    <section className="card"><h2>{t("Companies")}</h2>
      {list.map(c => <div key={c.id} className="row"><b>{c.code}</b> {c.name} <span className="pill">{c.industry}</span><Usage u={c.usage} />
        <button className="sm" onClick={async () => { const v = prompt(t("New user limit"), c.user_limit); if (v) { await api(s, `/api/platform/companies/${c.id}`, { method: "PATCH", body: JSON.stringify({ userLimit: Number(v) }) }); load(); } }}>{t("Set limit")}</button></div>)}
    </section>
    <form className="card" onSubmit={async e => { e.preventDefault(); try { await api(s, "/api/platform/companies", { method: "POST", body: JSON.stringify({ code: f.code, name: f.name, industry, userLimit: Number(f.userLimit), admin: { email: f.email, name: f.adminName, password: f.password } }) }); setMsg(t("Created")); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h2>{t("New company")}</h2>
      <label>{t("Industry template")}</label>
      <div className="tpls">{tpl.map(t => <label key={t.id} className={`tpl ${industry === t.id ? "on" : ""}`}><input type="radio" name="ind" checked={industry === t.id} onChange={() => setIndustry(t.id)} /><b>{t.label}</b><span>{t.description}</span></label>)}</div>
      {Object.keys(f).map(k => <input key={k} placeholder={k} value={(f as any)[k]} type={k === "password" ? "password" : "text"} onChange={e => setF({ ...f, [k]: e.target.value })} />)}
      <button>{t("Create")}</button><p>{msg}</p></form></>;
}

export type Cfg = { industry: string; settings: { features: Record<string, boolean>; attributes: string[]; uoms: { code: string; factor: number }[]; customFields: Record<string, any[]>; po?: any; gst?: any } };
const WORDS: Record<string, string> = { shop_name: t("Outlet"), shop: t("Outlet"), rep_name: t("Sales rep"), doc_date: t("Date"), pay_date: t("Date"), sku: t("Product code"), hsn: "HSN code", gstin: "GSTIN", uom: t("Unit"),
  base_qty: t("Qty"), min_qty: t("Minimum qty"), tax_type: t("Tax"), taxable: t("Value before tax"), qty_base: t("Qty"), created_at: t("Created"), item_name: t("Product"), number: "No.", drug_licence: t("Drug licence"), active: t("Active") };
export const label = (k: string) => t(WORDS[k] || k.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()));

export const TAB_LABEL: Record<string, string> = { home: "Home", beat: "Today's beat", order: "New order", orders: "Orders", collect: "Collect", targets: "Targets", catalog: "Products",
  inbox: "New orders", invoices: "Invoices", collections: "Collections", POs: "Purchase orders", stock: "Stock", profile: "My profile", dashboard: "Team activity", beats: "Beat plans",
  visits: "Visits", reports: "Reports", shops: "Outlets", schemes: "Offers & schemes", distributors: "Distributors", users: "Users", settings: "Company settings", import: "Upload data", security: "Security & privacy", integrations: "Integrations", van: "My van", surveys: "Surveys", messages: "WhatsApp / SMS", vans: "Van sales", inventory: "Inventory", claims: "Claims", leads: "Leads", trail: "Location trail", coverage: "Coverage", account: "My account", more: "More", audit: "Store check", audits: "Store checks", checklists: "Store checklists", expenses: "Expenses", myexpenses: "My expenses", leave: "Leave & attendance", myleave: "My leave", incentives: "Incentives", rules: "Incentive rules", fieldrules: "Field rules", data: "Data workspace" };
export type Go = (tab: string) => void;
export type ViewProps = { s: Session; cfg: Cfg; reload: () => void; onUsage: (u: any) => void; go: Go };

function Company({ s, onLogout }: { s: Session; onLogout: () => void }) {
  const role = s.user.role, admin = role === "company_admin", mgr = admin || role === "manager";
  const [cfg, setCfg] = useState<Cfg | null>(null); const [usage, setUsage] = useState<any>(null);
  const [tab, setTabRaw] = useState(() => location.hash.slice(1) || "home"); const [more, setMore] = useState(false); const [err, setErr] = useState("");
  const setTab = (t: string) => { setTabRaw(t); setMore(false); history.replaceState(null, "", `#${t}`); window.scrollTo(0, 0); };
  useIdleLogout(s.idleMinutes || 60, onLogout);
  useTracking(s, role === "sales_rep" && !!cfg?.settings.features.tracking);
  const reload = () => api(s, "/api/company/settings").then(setCfg).catch(e => setErr(e.message));
  useEffect(() => { reload(); if (mgr) api(s, "/api/company/usage").then(setUsage).catch(() => {}); }, []);
  if (!cfg) return err ? <Empty icon="⚠️" title={t("Couldn't load your company")} text={err} action={t("Try again")} onAction={reload} /> : <Loading text={t("Loading your workspace…")} />;
  const f = cfg.settings.features;
  const groups: [string, string[]][] = mgr ? [
    [t("Sales"), ["home", "dashboard", "orders", "beats", "visits", "targets", "shops", ...(f.schemes ? ["schemes"] : []), ...(f.audits ? ["audits"] : []), ...(f.leave ? ["leave"] : []), ...(f.incentives ? ["incentives"] : []), ...(f.vanSales ? ["vans"] : []), ...(f.leads ? ["leads"] : []), ...(f.surveys ? ["surveys"] : []), ...(f.tracking ? ["trail"] : []), ...(f.coverage ? ["coverage"] : [])]],
    [t("Distributors"), ["distributors", ...(f.purchaseOrders ? ["POs"] : []), ...(f.stock ? ["stock"] : []), ...(f.distInventory ? ["inventory"] : []), ...(f.claims ? ["claims"] : [])]],
    [t("Finance"), [...(f.invoicing ? ["invoices", "collections"] : []), ...(f.expenses ? ["expenses"] : []), ...(f.messaging ? ["messages"] : []), "reports"]],
    [t("Setup"), ["catalog", "users", ...(admin ? ["settings", "import", ...(f.audits ? ["checklists"] : []), ...(f.incentives ? ["rules"] : []), "fieldrules", "integrations", "security"] : []), "data", "account"]]]
    : role === "retailer" ? [[t("Menu"), ["home", "order", "orders", "catalog", "account"]]]
    : role === "sales_rep" ? [[t("Menu"), ["home", "beat", "order", "orders", ...(f.vanSales ? ["van"] : []), ...(f.leads ? ["leads"] : []), ...(f.surveys ? ["surveys"] : []), ...(f.audits ? ["audit"] : []), ...(f.invoicing ? ["collect"] : []), ...(f.expenses ? ["myexpenses"] : []), ...(f.leave ? ["myleave"] : []), ...(f.incentives ? ["incentives"] : []), "targets", "reports", "catalog", "account"]]]
    : [[t("Menu"), ["home", "inbox", ...(f.invoicing && f.distributorBilling ? ["invoices", "collections"] : []), ...(f.stock ? ["stock"] : []), ...(f.distInventory ? ["inventory"] : []), ...(f.claims ? ["claims"] : []), ...(f.purchaseOrders ? ["POs"] : []), "profile", "reports", "catalog", "account"]]];
  const tabs = groups.flatMap(g => g[1]);
  const primary = (mgr ? ["home", "orders", f.invoicing ? "collections" : "dashboard", "reports"] : role === "retailer" ? ["home", "order", "orders", "catalog"] : role === "sales_rep" ? ["home", "beat", "order", f.invoicing ? "collect" : "orders"]
    : ["home", "inbox", f.invoicing && f.distributorBilling ? "invoices" : "catalog", f.stock ? "stock" : f.purchaseOrders ? "POs" : "profile"]).filter(t => tabs.includes(t));
  const cur = s.enrollTotp ? "account" : tabs.includes(tab) ? tab : "home";
  const views: Record<string, any> = { home: mgr ? ManagerHome : role === "retailer" ? RetailerHome : role === "sales_rep" ? RepHome : DistributorHome, dashboard: Dashboard, beats: Beats, orders: Orders, beat: MyBeat, order: OrderForm, inbox: Inbox, shops: ShopsMap,
    catalog: Catalog, stock: Stock, invoices: Invoices, targets: Targets, reports: ReportsHub, visits: Visits, POs: PurchaseOrders, distributors: DistributorTerms, profile: DistributorTerms, schemes: Schemes,
    collections: Collections, collect: Collections, settings: SettingsPage, import: ImportPage, users: UsersAdmin, security: SecurityPage, integrations: Integrations, van: VanRep, vans: VanAdmin, inventory: Inventory, claims: Claims, leads: Leads, surveys: Surveys, messages: Messages, trail: Trail, coverage: Coverage, account: (p: ViewProps) => <><div className="card"><LangPicker /></div><MyAccount s={p.s} onSignedOut={onLogout} /></>, audit: AuditFill, audits: AuditReport, checklists: AuditSetup, expenses: ExpenseApprovals, myexpenses: MyExpenses, leave: LeaveApprovals, myleave: MyLeave, incentives: Incentives, rules: IncentiveRules, fieldrules: FlowSettings, data: DataWorkspace };
  const C = views[cur];
  const Item = ({ t }: { t: string }) => /* t is a tab id here */ <button className={`nav-item ${t === cur ? "on" : ""}`} onClick={() => setTab(t)}><span className="ic" aria-hidden>{ICONS[t]}</span><span>{i18n(TAB_LABEL[t] || t)}</span></button>;
  return <div className="shell">
    <aside className="sidebar"><div className="brand sm"><img className="logo" src="/logo-mark.svg" alt="OwnField" /><b>{t("OwnField")}</b></div>
      {groups.map(([g, ts]) => <div key={g} className="group"><div className="group-h">{t(g)}</div>{ts.map(t => <Item key={t} t={t} />)}</div>)}
      <div className="who"><b>{s.user.name}</b><span>{t(ROLE[role])} · {s.user.companyCode}</span><button className="ghost sm" onClick={onLogout}>{t("Sign out")}</button></div>
      <p className="muted small copy">{t("OwnField — Own your sales.")}<br />© 2026 Vignesh S. OwnField is a trademark of Vignesh S. AGPL-3.0.</p></aside>
    <div className="content">
      <header className="top"><div className="brand sm"><img className="logo" src="/logo-mark.svg" alt="OwnField" /><b>{s.user.companyCode}</b></div><Bell s={s} go={setTab} /><span className="who-sm" title={s.user.name}>{s.user.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}</span></header>
      {mgr && cur === "home" && <Usage u={usage} />}<OfflineBadge s={s} />{cur === "home" && role !== "retailer" && <PinnedReports s={s} go={setTab} />}
      <section className="card main-card"><C s={s} cfg={cfg} reload={reload} onUsage={setUsage} go={setTab} /></section>
    </div>
    <nav className="bottom">{primary.map(t => <Item key={t} t={t} />)}
      <button className={`nav-item ${more ? "on" : ""}`} onClick={() => setMore(!more)}><span className="ic" aria-hidden>{ICONS.more}</span><span>{t("More")}</span></button></nav>
    {more && <div className="sheet-bg" onClick={() => setMore(false)}><div className="sheet" onClick={e => e.stopPropagation()}>
      {groups.map(([g, ts]) => <div key={g}><div className="group-h">{t(g)}</div><div className="sheet-grid">{ts.map(t => <Item key={t} t={t} />)}</div></div>)}
      <div className="who"><b>{s.user.name}</b><span>{t(ROLE[role])} · {s.user.companyCode}</span><button className="ghost sm" onClick={onLogout}>{t("Sign out")}</button></div></div></div>}
  </div>;
}
const ROLE: Record<string, string> = { company_admin: t("Administrator"), manager: t("Manager"), sales_rep: t("Sales rep"), distributor: t("Distributor"), retailer: t("Retailer (shop)"), platform_owner: t("Platform owner") };

function Users({ s, cfg, go }: ViewProps) {
  const [rows, setRows] = useState<any[] | null>(null); useEffect(() => { api(s, "/api/users").then(setRows); }, []);
  return <><h2>{t("Users")}</h2><Table rows={rows.map(r => ({ ...r, role: t(ROLE[r.role] || r.role) }))} cols={["name", "email", "role", ...(cfg.settings.features.drugLicence ? ["drug_licence"] : []), "active"]}
    empty={{ title: t("No users yet"), text: t("Add sales reps, managers and distributors by uploading a users sheet."), action: t("Upload users"), onAction: () => go("import") }} /></>;
}

function App() {
  const [s, setS] = useState<Session | null>(() => JSON.parse(localStorage.getItem("ff") || "null"));
  const set = (v: Session | null) => { setS(v); v ? localStorage.setItem("ff", JSON.stringify(v)) : localStorage.removeItem("ff"); };
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const h = () => setHash(location.hash); addEventListener("hashchange", h); return () => removeEventListener("hashchange", h); }, []);
  if (!s && (hash === "#reset" || new URLSearchParams(location.search).has("reset"))) return <><ResetPassword onDone={() => { location.hash = ""; setHash(""); }} /><Toasts /></>;
  if (!s) return <>{hash === "#signup" ? <Signup onLogin={set} /> : <Login onLogin={set} />}<Toasts /></>;
  return <>{s.user.role === "platform_owner" ? <main><header className="top"><b>{t("OwnField · Platform")}</b><button className="sm ghost" onClick={() => set(null)}>{t("Sign out")}</button></header><Platform s={s} /></main>
    : <Company s={s} onLogout={() => { set(null); location.hash = ""; }} />}<Toasts /></>;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
createRoot(document.getElementById("root")!).render(<App />);
