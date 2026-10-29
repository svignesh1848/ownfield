import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { Dashboard, Beats, Orders, MyBeat, OrderForm, Inbox, ShopsMap, OfflineBadge } from "./field";

export type Session = { token: string; user: { name: string; role: string; companyCode: string | null } };
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
  const [list, setList] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const [f, setF] = useState({ code: "", name: "", userLimit: "10", email: "", adminName: "", password: "" });
  const load = () => api(s, "/api/platform/companies").then(setList);
  useEffect(() => { load(); }, []);
  return <>
    <section className="card"><h2>Companies</h2>
      {list.map(c => <div key={c.id} className="row"><b>{c.code}</b> {c.name}<Usage u={c.usage} />
        <button className="sm" onClick={async () => { const v = prompt("New user limit", c.user_limit); if (v) { await api(s, `/api/platform/companies/${c.id}`, { method: "PATCH", body: JSON.stringify({ userLimit: Number(v) }) }); load(); } }}>Set limit</button></div>)}
    </section>
    <form className="card" onSubmit={async e => { e.preventDefault(); try { await api(s, "/api/platform/companies", { method: "POST", body: JSON.stringify({ code: f.code, name: f.name, userLimit: Number(f.userLimit), admin: { email: f.email, name: f.adminName, password: f.password } }) }); setMsg("Created"); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h2>New company</h2>
      {Object.keys(f).map(k => <input key={k} placeholder={k} value={(f as any)[k]} type={k === "password" ? "password" : "text"} onChange={e => setF({ ...f, [k]: e.target.value })} />)}
      <button>Create</button><p>{msg}</p></form></>;
}

function Company({ s }: { s: Session }) {
  const role = s.user.role, admin = role === "company_admin", mgr = admin || role === "manager";
  const tabs = mgr ? ["dashboard", "beats", "orders", "users", "shops", "products", ...(admin ? ["import"] : [])]
    : role === "sales_rep" ? ["beat", "order", "orders"] : ["inbox", "products"];
  const [tab, setTab] = useState(tabs[0]); const [rows, setRows] = useState<any[]>([]); const [usage, setUsage] = useState<any>(null); const [msg, setMsg] = useState("");
  const custom: Record<string, any> = { dashboard: Dashboard, beats: Beats, orders: Orders, beat: MyBeat, order: OrderForm, inbox: Inbox, shops: mgr ? ShopsMap : null };
  useEffect(() => { setMsg(""); if (!custom[tab] && tab !== "import") api(s, `/api/${tab}`).then(setRows).catch(e => setMsg(e.message)); if (mgr) api(s, "/api/company/usage").then(setUsage); }, [tab]);
  const cols: Record<string, string[]> = { users: ["name", "email", "role", "active"], products: ["style", "sku", "size", "hsn", "mrp", "billing_price"] };
  const C = custom[tab];
  return <>
    {mgr && <Usage u={usage} />}<OfflineBadge s={s} />
    <nav>{tabs.map(t => <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
    <section className="card">{C ? <C s={s} /> : tab === "import"
      ? <>{["shops", "products", "users"].map(k => <form key={k} className="row" onSubmit={async e => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { const r = await api(s, `/api/import/${k}`, { method: "POST", body: fd }); setMsg(`${k}: ${r.inserted} added, ${r.updated} updated, ${r.errors.length} errors ${r.errors.map((x: any) => `[row ${x.row}: ${x.error}]`).join(" ")}`); setUsage(r.usage); } catch (x: any) { setMsg(x.message); } }}>
          <label>Upload {k} (.xlsx / .csv)</label><input name="file" type="file" accept=".xlsx,.xls,.csv" required /><button className="sm">Upload</button></form>)}
        <p className="muted">Templates: see <code>sample-data/</code> in the repo. Shops may include a "Distributor Email" column.</p></>
      : <Table rows={rows} cols={cols[tab]} />}<p>{msg}</p></section></>;
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
