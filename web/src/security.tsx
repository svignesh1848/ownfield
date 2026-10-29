import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps, type Session } from "./main";
import { Field, toast, Loading } from "./ui";

const raw = (s: Session, url: string) => fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }).then(async r => { if (!r.ok) throw new Error("Download failed"); return r.blob(); });
const save = (b: Blob, name: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };

export function UsersAdmin({ s, cfg, go }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [rows, setRows] = useState<any[] | null>(null); const [code, setCode] = useState<any>(null);
  const load = () => api(s, "/api/users").then(setRows).catch(e => toast(e.message, "err")); useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>) => { try { await fn(); load(); } catch (e: any) { toast(e.message, "err"); } };
  if (!rows) return <Loading />;
  return <><h2>Users</h2>
    {code && <div className="hint"><b>One-time reset code for {code.email}:</b> <code>{code.code}</code> (valid {code.expiresInMin} min)<br />Link: <code>{location.origin + code.link}</code><br /><span className="muted">Share it privately. It works once.</span></div>}
    <Table rows={rows.map(r => ({ ...r, actions: r.id }))} cols={["name", "email", "role", ...(cfg.settings.features.drugLicence ? ["drug_licence"] : []), "active"]}
      empty={{ title: "No users yet", text: "Add sales reps, managers and distributors by uploading a users sheet.", action: "Upload users", onAction: () => go("import") }} />
    {admin && <div className="scroll"><table><thead><tr><th>User</th><th>Actions</th></tr></thead><tbody>{rows.filter(r => r.id !== s.user.id && !/@invalid$/.test(r.email)).map(r => <tr key={r.id}><td>{r.name}</td><td className="row-btns">
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) }))}>{r.active ? "Disable" : "Enable"}</button>
      <button className="sm ghost" onClick={() => act(async () => setCode({ ...(await api(s, `/api/users/${r.id}/reset-code`, { method: "POST" })), email: r.email }))}>Reset code</button>
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ resetDevice: true }) }))}>Reset device</button>
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ resetTotp: true }) }))}>Reset 2-step</button>
      <button className="sm ghost" onClick={() => confirm(`Delete ${r.name}? Their personal data is anonymised.`) && act(() => api(s, `/api/users/${r.id}`, { method: "DELETE" }))}>Delete</button></td></tr>)}</tbody></table></div>}</>;
}

export function SecurityPage({ s }: ViewProps) {
  const [cfg, setCfg] = useState<any>(null); const [log, setLog] = useState<any[] | null>(null); const [alerts, setAlerts] = useState(false); const [confirmCode, setConfirm] = useState("");
  useEffect(() => { api(s, "/api/company/security").then(setCfg); }, []);
  useEffect(() => { setLog(null); api(s, `/api/audit-log${alerts ? "?alerts=1" : ""}`).then(setLog); }, [alerts]);
  if (!cfg) return <Loading />;
  return <><h2>Security & privacy</h2>
    <form className="card" onSubmit={async e => { e.preventDefault(); try { setCfg(await api(s, "/api/company/security", { method: "PUT", body: JSON.stringify(cfg) })); } catch (x: any) { toast(x.message, "err"); } }}>
      <label><input type="checkbox" checked={cfg.requireTotp} onChange={e => setCfg({ ...cfg, requireTotp: e.target.checked })} /> Require two-step sign-in (authenticator app) for everyone</label>
      <label><input type="checkbox" checked={cfg.deviceBinding} onChange={e => setCfg({ ...cfg, deviceBinding: e.target.checked })} /> Lock each sales rep to one phone (reset from Users)</label>
      <Field label="Sign out after inactivity (minutes)"><input type="number" min={5} max={720} value={cfg.idleMinutes} onChange={e => setCfg({ ...cfg, idleMinutes: Number(e.target.value) })} /></Field>
      <button>Save</button></form>
    <h3>Activity log</h3>
    <label><input type="checkbox" checked={alerts} onChange={e => setAlerts(e.target.checked)} /> Show only sign-in alerts (new device/IP, failures, lockouts)</label>
    <Table rows={log} cols={["at", "action", "target", "by_user", "ip"]} empty={{ title: "No activity yet" }} />
    <h3>Your data</h3>
    <div className="row-btns"><button className="sm" onClick={() => raw(s, "/api/company/export").then(b => save(b, "company-export.json"))}>Export all (JSON)</button>
      {["users", "shops", "orders", "invoices"].map(t => <button key={t} className="sm ghost" onClick={() => raw(s, `/api/company/export?format=csv&table=${t}`).then(b => save(b, `${t}.csv`))}>{t} (CSV)</button>)}</div>
    <details><summary>Delete company</summary><p className="muted">Anonymises all users and outlet contact details and signs everyone out. This cannot be undone.</p>
      <Field label={`Type your company code (${s.user.companyCode}) to confirm`}><input value={confirmCode} onChange={e => setConfirm(e.target.value)} /></Field>
      <button className="danger" onClick={async () => { try { await api(s, "/api/company", { method: "DELETE", body: JSON.stringify({ confirm: confirmCode }) }); localStorage.removeItem("ff"); location.reload(); } catch (x: any) { toast(x.message, "err"); } }}>Delete company</button></details></>;
}

export function MyAccount({ s, onSignedOut }: { s: Session; onSignedOut: () => void }) {
  const [me, setMe] = useState<any>(null); const [pw, setPw] = useState({ current: "", password: "" }); const [setup, setSetup] = useState<any>(null); const [code, setCode] = useState("");
  useEffect(() => { api(s, "/api/me").then(setMe); }, []);
  const run = async (fn: () => Promise<any>) => { try { const r = await fn(); if (r?.signInAgain) { toast("Done — please sign in again"); onSignedOut(); } } catch (x: any) { toast(x.message, "err"); } };
  if (!me) return <Loading />;
  return <><h2>My account</h2>
    <form className="card" onSubmit={e => { e.preventDefault(); run(() => api(s, "/api/me/password", { method: "POST", body: JSON.stringify(pw) })); }}>
      <h3>Change password</h3>
      <Field label="Current password"><input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></Field>
      <Field label="New password" help="At least 8 characters, with a letter and a number."><input type="password" autoComplete="new-password" value={pw.password} onChange={e => setPw({ ...pw, password: e.target.value })} /></Field>
      <button>Change password</button><p className="muted small">Signs you out on all devices.</p></form>
    <div className="card"><h3>Two-step sign-in</h3>
      {me.totp_enabled ? <><p>On. To turn off, enter a current code.</p><input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} />
        <button className="ghost" onClick={() => run(async () => { await api(s, "/api/me/totp/disable", { method: "POST", body: JSON.stringify({ code }) }); setMe({ ...me, totp_enabled: false }); })}>Turn off</button></>
        : setup ? <><p>Scan with Google Authenticator, Microsoft Authenticator or similar, then enter the 6-digit code.</p><img src={setup.qr} alt="QR code" width={180} height={180} /><p className="muted small">Or type: <code>{setup.secret}</code></p>
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /><button onClick={() => run(() => api(s, "/api/me/totp/enable", { method: "POST", body: JSON.stringify({ code }) }))}>Turn on</button></>
        : <button onClick={() => run(async () => setSetup(await api(s, "/api/me/totp/setup", { method: "POST" })))}>Set up</button>}</div></>;
}

export function ResetPassword({ onDone }: { onDone: () => void }) {
  const q = new URLSearchParams(location.search);
  const [f, setF] = useState({ companyCode: q.get("company") || "", email: q.get("email") || "", code: q.get("reset") || "", password: "" }); const [err, setErr] = useState("");
  return <div className="login-wrap"><form className="card login" onSubmit={async e => { e.preventDefault(); setErr(""); try { await api(null, "/api/auth/reset", { method: "POST", body: JSON.stringify(f) }); toast("Password changed — sign in now"); history.replaceState(null, "", "/"); onDone(); } catch (x: any) { setErr(x.message); } }}>
    <h1>Set a new password</h1><p className="muted">Use the one-time code from your administrator.</p>
    <Field label="Company code"><input value={f.companyCode} onChange={e => setF({ ...f, companyCode: e.target.value })} /></Field>
    <Field label="Email"><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
    <Field label="Reset code"><input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} /></Field>
    <Field label="New password" help="At least 8 characters, with a letter and a number."><input type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
    {err && <p className="err">{err}</p>}<button className="block">Save new password</button><p className="center"><a href="#" onClick={e => { e.preventDefault(); history.replaceState(null, "", "/"); onDone(); }}>Back to sign in</a></p></form></div>;
}

/** Client-side idle logout (the server enforces it too). */
export function useIdleLogout(minutes: number, onIdle: () => void) {
  useEffect(() => {
    let last = Date.now(); const bump = () => { last = Date.now(); };
    const ev = ["pointerdown", "keydown", "scroll", "visibilitychange"]; ev.forEach(e => addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => { if (Date.now() - last > minutes * 60_000) onIdle(); }, 30_000);
    return () => { clearInterval(t); ev.forEach(e => removeEventListener(e, bump)); };
  }, [minutes]);
}
export const deviceId = () => { let d = localStorage.getItem("ff-device"); if (!d) { d = crypto.randomUUID(); localStorage.setItem("ff-device", d); } return d; };
