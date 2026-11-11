import React, { useEffect, useState } from "react";
import { api, Table, label, ROLE, type ViewProps, type Session } from "./main";
import { t } from "./i18n";
import { Field, toast, Loading } from "./ui";

const raw = (s: Session, url: string) => fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }).then(async r => { if (!r.ok) throw new Error(t("Download failed")); return r.blob(); });
const save = (b: Blob, name: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };

export function UsersAdmin({ s, cfg, go }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [rows, setRows] = useState<any[] | null>(null); const [code, setCode] = useState<any>(null);
  const load = () => api(s, "/api/users").then(setRows).catch(e => toast(e.message, "err")); useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>) => { try { await fn(); load(); } catch (e: any) { toast(e.message, "err"); } };
  if (!rows) return <Loading />;
  return <><h2>{t("Users")}</h2>
    {admin && <AddUser s={s} bosses={rows.filter(r => r.active && ["company_admin", "manager", "sales_rep"].includes(r.role))} onAdded={(u, setup) => { load(); if (setup) setCode({ ...setup, email: u.email, invite: true }); }} />}
    {code?.invite && <div className="hint"><b>{t("{0} can set their own password with this one-time link (valid {1} min):", code.email, code.expiresInMin)}</b><br /><code>{location.origin + code.link}</code><br /><span className="muted">{t("Share it privately. It works once.")}</span></div>}
    {code && !code.invite && <div className="hint"><b>{t("One-time reset code for")}{" "}{code.email}:</b> <code>{code.code}</code> {t("(valid")}{" "}{code.expiresInMin} {t("min)")}<br />{t("Link:")}{" "}<code>{location.origin + code.link}</code><br /><span className="muted">{t("Share it privately. It works once.")}</span></div>}
    <Table rows={rows.map(r => ({ ...r, actions: r.id }))} cols={["name", "email", "role", ...(cfg.settings.features.drugLicence ? ["drug_licence"] : []), "active"]}
      empty={{ title: t("No users yet"), text: t("Add sales reps, managers and distributors by uploading a users sheet."), action: t("Upload users"), onAction: () => go("import") }} />
    {admin && <div className="scroll"><table><thead><tr><th>{t("User")}</th><th>{t("Actions")}</th></tr></thead><tbody>{rows.filter(r => r.id !== s.user.id && !/@invalid$/.test(r.email)).map(r => <tr key={r.id}><td>{r.name}</td><td className="row-btns">
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) }))}>{r.active ? t("Disable") : t("Enable")}</button>
      <button className="sm ghost" onClick={() => act(async () => setCode({ ...(await api(s, `/api/users/${r.id}/reset-code`, { method: "POST" })), email: r.email }))}>{t("Reset code")}</button>
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ resetDevice: true }) }))}>{t("Reset device")}</button>
      <button className="sm ghost" onClick={() => act(() => api(s, `/api/users/${r.id}`, { method: "PATCH", body: JSON.stringify({ resetTotp: true }) }))}>{t("Reset 2-step")}</button>
      <button className="sm ghost" onClick={() => confirm(t("Delete {0}? Their personal data is anonymised.", r.name)) && act(() => api(s, `/api/users/${r.id}`, { method: "DELETE" }))}>{t("Delete")}</button></td></tr>)}</tbody></table></div>}</>;
}

/** Add one user (no upload needed). No password is typed: the admin gets a one-time link and the user sets their own password. */
function AddUser({ s, bosses, onAdded }: { s: Session; bosses: any[]; onAdded: (u: any, setup: any) => void }) {
  const blank = { name: "", email: "", phone: "", role: "sales_rep", reportsTo: "", shopCode: "" };
  const [open, setOpen] = useState(false); const [f, setF] = useState(blank); const [busy, setBusy] = useState(false);
  const inp = (k: keyof typeof blank, l: string, type = "text") => <Field label={l}><input type={type} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>;
  const submit = async (e: any) => {
    e.preventDefault(); setBusy(true);
    try {
      const body: any = { name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim(), role: f.role };
      if (["sales_rep", "manager"].includes(f.role) && f.reportsTo) body.reportsTo = f.reportsTo;
      if (f.role === "retailer") body.shopCode = f.shopCode.trim();
      const r = await api(s, "/api/users", { method: "POST", body: JSON.stringify(body) });
      setF(blank); setOpen(false); onAdded(r.user, r.setup);
    } catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); }
  };
  if (!open) return <button className="sm" onClick={() => setOpen(true)}>+ {t("Add user")}</button>;
  return <form className="card" onSubmit={submit}><b>{t("Add user")}</b>
    <p className="muted small">{t("No password needed. You get a one-time link to share, and they set their own password.")}</p>
    {inp("name", t("Name"))}{inp("email", t("Email"), "email")}{inp("phone", t("Phone"), "tel")}
    <Field label={t("Role")}><select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{["sales_rep", "manager", "distributor", "retailer", "company_admin"].map(r => <option key={r} value={r}>{ROLE[r]}</option>)}</select></Field>
    {["sales_rep", "manager"].includes(f.role) && <Field label={t("Reports to")}><select value={f.reportsTo} onChange={e => setF({ ...f, reportsTo: e.target.value })}><option value="">{t("Nobody (top)")}</option>
      {bosses.filter(b => b.role !== "sales_rep").map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
    {f.role === "retailer" && inp("shopCode", t("Outlet code"))}
    <div className="row-btns"><button disabled={busy || !f.name.trim() || !f.email.trim()}>{busy ? t("Saving…") : t("Add user")}</button><button type="button" className="ghost" onClick={() => setOpen(false)}>{t("Cancel")}</button></div></form>;
}

export function SecurityPage({ s }: ViewProps) {
  const [cfg, setCfg] = useState<any>(null); const [log, setLog] = useState<any[] | null>(null); const [alerts, setAlerts] = useState(false); const [confirmCode, setConfirm] = useState("");
  useEffect(() => { api(s, "/api/company/security").then(setCfg); }, []);
  useEffect(() => { setLog(null); api(s, `/api/audit-log${alerts ? "?alerts=1" : ""}`).then(setLog); }, [alerts]);
  if (!cfg) return <Loading />;
  return <><h2>{t("Security & privacy")}</h2>
    <form className="card" onSubmit={async e => { e.preventDefault(); try { setCfg(await api(s, "/api/company/security", { method: "PUT", body: JSON.stringify(cfg) })); } catch (x: any) { toast(x.message, "err"); } }}>
      <label><input type="checkbox" checked={cfg.requireTotp} onChange={e => setCfg({ ...cfg, requireTotp: e.target.checked })} /> {t("Require two-step sign-in (authenticator app) for everyone")}</label>
      <label><input type="checkbox" checked={!!cfg.requireTotpAdmins} onChange={e => setCfg({ ...cfg, requireTotpAdmins: e.target.checked })} /> {t("Require two-step sign-in for admins")}</label>
      <label><input type="checkbox" checked={cfg.deviceBinding} onChange={e => setCfg({ ...cfg, deviceBinding: e.target.checked })} /> {t("Lock each sales rep to one phone (reset from Users)")}</label>
      <Field label={t("Sign out after inactivity (minutes)")}><input type="number" min={5} max={720} value={cfg.idleMinutes} onChange={e => setCfg({ ...cfg, idleMinutes: Number(e.target.value) })} /></Field>
      <button>{t("Save")}</button></form>
    <h3>{t("Activity log")}</h3>
    <label><input type="checkbox" checked={alerts} onChange={e => setAlerts(e.target.checked)} /> {t("Show only sign-in alerts (new device/IP, failures, lockouts)")}</label>
    <Table rows={log} cols={["at", "action", "target", "by_user", "ip"]} empty={{ title: t("No activity yet") }} />
    <h3>{t("Your data")}</h3>
    <div className="row-btns"><button className="sm" onClick={() => raw(s, "/api/company/export").then(b => save(b, "company-export.json"))}>{t("Export all (JSON)")}</button>
      {["users", "shops", "orders", "invoices"].map(tb => <button key={tb} className="sm ghost" onClick={() => raw(s, `/api/company/export?format=csv&table=${tb}`).then(b => save(b, `${tb}.csv`))}>{t(label(tb))} {t("(CSV)")}</button>)}</div>
    <details><summary>{t("Delete company")}</summary><p className="muted">{t("Anonymises all users and outlet contact details and signs everyone out. This cannot be undone.")}</p>
      <Field label={t("Type your company code ({0}) to confirm", s.user.companyCode)}><input value={confirmCode} onChange={e => setConfirm(e.target.value)} /></Field>
      <button className="danger" onClick={async () => { try { await api(s, "/api/company", { method: "DELETE", body: JSON.stringify({ confirm: confirmCode }) }); localStorage.removeItem("ff"); location.reload(); } catch (x: any) { toast(x.message, "err"); } }}>{t("Delete company")}</button></details></>;
}

export function MyAccount({ s, onSignedOut }: { s: Session; onSignedOut: () => void }) {
  const [me, setMe] = useState<any>(null); const [pw, setPw] = useState({ current: "", password: "" }); const [setup, setSetup] = useState<any>(null); const [code, setCode] = useState("");
  useEffect(() => { api(s, "/api/me").then(setMe); }, []);
  const run = async (fn: () => Promise<any>) => { try { const r = await fn(); if (r?.signInAgain) { toast(t("Done — please sign in again")); onSignedOut(); } } catch (x: any) { toast(x.message, "err"); } };
  if (!me) return <Loading />;
  return <><h2>{t("My account")}</h2>
    <form className="card" onSubmit={e => { e.preventDefault(); run(() => api(s, "/api/me/password", { method: "POST", body: JSON.stringify(pw) })); }}>
      <h3>{t("Change password")}</h3>
      <Field label={t("Current password")}><input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></Field>
      <Field label={t("New password")} help={t("At least 8 characters, with a letter and a number.")}><input type="password" autoComplete="new-password" value={pw.password} onChange={e => setPw({ ...pw, password: e.target.value })} /></Field>
      <button>{t("Change password")}</button><p className="muted small">{t("Signs you out on all devices.")}</p></form>
    <div className="card"><h3>{t("Two-step sign-in")}</h3>
      {me.totp_enabled ? <><p>{t("On. To turn off, enter a current code.")}</p><input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} />
        <button className="ghost" onClick={() => run(async () => { await api(s, "/api/me/totp/disable", { method: "POST", body: JSON.stringify({ code }) }); setMe({ ...me, totp_enabled: false }); })}>{t("Turn off")}</button></>
        : setup ? <><p>{t("Scan with Google Authenticator, Microsoft Authenticator or similar, then enter the 6-digit code.")}</p><img src={setup.qr} alt={t("QR code")} width={180} height={180} /><p className="muted small">{t("Or type:")}{" "}<code>{setup.secret}</code></p>
          <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} /><button onClick={() => run(() => api(s, "/api/me/totp/enable", { method: "POST", body: JSON.stringify({ code }) }))}>{t("Turn on")}</button></>
        : <button onClick={() => run(async () => setSetup(await api(s, "/api/me/totp/setup", { method: "POST" })))}>{t("Set up")}</button>}</div></>;
}

export function ResetPassword({ onDone }: { onDone: () => void }) {
  const q = new URLSearchParams(location.search);
  const [f, setF] = useState({ companyCode: q.get("company") || "", email: q.get("email") || "", code: q.get("reset") || "", password: "" }); const [err, setErr] = useState("");
  return <div className="login-wrap"><form className="card login" onSubmit={async e => { e.preventDefault(); setErr(""); try { await api(null, "/api/auth/reset", { method: "POST", body: JSON.stringify(f) }); toast(t("Password changed — sign in now")); history.replaceState(null, "", "/"); onDone(); } catch (x: any) { setErr(x.message); } }}>
    <h1>{t("Set a new password")}</h1><p className="muted">{t("Use the one-time code from your administrator.")}</p>
    <Field label={t("Company code")}><input value={f.companyCode} onChange={e => setF({ ...f, companyCode: e.target.value })} /></Field>
    <Field label={t("Email")}><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
    <Field label={t("Reset code")}><input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} /></Field>
    <Field label={t("New password")} help={t("At least 8 characters, with a letter and a number.")}><input type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>
    {err && <p className="err">{err}</p>}<button className="block">{t("Save new password")}</button><p className="center"><a href="#" onClick={e => { e.preventDefault(); history.replaceState(null, "", "/"); onDone(); }}>{t("Back to sign in")}</a></p></form></div>;
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
