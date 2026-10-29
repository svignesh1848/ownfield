// Phase 3 screens: store audits, expenses, leave & attendance, incentives, retailer app. Plain language, one task per screen.
import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps, type Session } from "./main";
import { Empty, Loading, Field, toast, inr0, fmtDate, today } from "./ui";

/** Shrink a photo on the phone before upload (max 1280px, JPEG ~70%) so uploads stay small. */
export async function compressPhoto(file: File, max = 1280, quality = 0.7): Promise<Blob> {
  try {
    const img = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("could not read photo")), "image/jpeg", quality));
  } catch { return file; }
}
export const uploadPhoto = async (s: Session, url: string, file: File, extra: Record<string, string> = {}) => {
  const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append("photo", await compressPhoto(file), "photo.jpg");
  return api(s, url, { method: "POST", body: fd });
};
/** Show a protected image (needs the login token). */
export function AuthImg({ s, src, alt }: { s: Session; src: string; alt: string }) {
  const [u, setU] = useState("");
  useEffect(() => { let url = ""; fetch(src, { headers: { Authorization: `Bearer ${s.token}` } }).then(r => r.ok ? r.blob() : null).then(b => { if (b) { url = URL.createObjectURL(b); setU(url); } }); return () => { if (url) URL.revokeObjectURL(url); }; }, [src]);
  return u ? <img className="thumb" src={u} alt={alt} /> : <span className="thumb" />;
}
const PhotoButton = ({ label, onFile }: { label: string; onFile: (f: File) => void }) =>
  <label className="photo-btn">📷 {label}<input type="file" accept="image/*" capture="environment" hidden onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} /></label>;

// ---------- 1) Store audits ----------
const QTYPE: Record<string, string> = { yes_no: "Yes / No", number: "Number", text: "Text", photo: "Photo" };
export function AuditSetup({ s }: ViewProps) {
  const [list, setList] = useState<any[] | null>(null); const [name, setName] = useState("");
  const [qs, setQs] = useState<{ label: string; type: string; required: boolean }[]>([{ label: "", type: "yes_no", required: false }]);
  const load = () => api(s, "/api/audit-templates?all=1").then(setList).catch(e => { setList([]); toast(e.message, "err"); }); useEffect(() => { load(); }, []);
  const save = async () => { try { await api(s, "/api/audit-templates", { method: "POST", body: JSON.stringify({ name, questions: qs.filter(q => q.label.trim()) }) }); setName(""); setQs([{ label: "", type: "yes_no", required: false }]); load(); } catch (e: any) { toast(e.message, "err"); } };
  return <><h2>Store checklists</h2><p className="muted">Questions your sales reps answer at each outlet visit.</p>
    {list == null ? <Loading /> : list.map(t => <div className="row" key={t.id}><b>{t.name}</b> {!t.active && <span className="pill">hidden</span>}
      <div className="muted small">{t.questions.map((q: any) => `${q.label} (${QTYPE[q.type]})`).join(" · ")}</div>
      <button className="sm ghost" onClick={() => api(s, `/api/audit-templates/${t.id}`, { method: "PUT", body: JSON.stringify({ active: !t.active }) }).then(load)}>{t.active ? "Hide" : "Show again"}</button></div>)}
    <div className="card sub"><h3>New checklist</h3>
      <Field label="Checklist name"><input value={name} placeholder="e.g. Shelf check" onChange={e => setName(e.target.value)} /></Field>
      {qs.map((q, i) => <div className="qrow" key={i}><input placeholder={`Question ${i + 1}`} value={q.label} onChange={e => setQs(qs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
        <select value={q.type} onChange={e => setQs(qs.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>{Object.entries(QTYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label className="chk"><input type="checkbox" checked={q.required} onChange={e => setQs(qs.map((x, j) => j === i ? { ...x, required: e.target.checked } : x))} />Must answer</label></div>)}
      <button className="ghost sm" onClick={() => setQs([...qs, { label: "", type: "yes_no", required: false }])}>+ Add question</button>{" "}
      <button onClick={save} disabled={!name.trim()}>Save checklist</button></div></>;
}
export function AuditFill({ s, go }: ViewProps) {
  const [st, setSt] = useState<any>(null); const [tid, setTid] = useState(""); const [ans, setAns] = useState<Record<string, any>>({}); const [audit, setAudit] = useState<any>(null); const [photos, setPhotos] = useState(0);
  useEffect(() => { Promise.all([api(s, "/api/visits"), api(s, "/api/audit-templates")]).then(([v, t]) => { setSt({ visit: v.find((x: any) => !x.check_out_at), tpl: t }); if (t.length === 1) setTid(String(t[0].id)); }).catch(e => setSt({ err: e.message })); }, []);
  if (!st) return <Loading />;
  if (st.err) return <Empty icon="⚠️" title="Store checks are not available" text={st.err} />;
  if (!st.visit) return <Empty icon="📍" title="Start a visit first" text="Check in at an outlet, then fill its store check here." action="Go to today's beat" onAction={() => go("beat")} />;
  if (!st.tpl.length) return <Empty icon="✅" title="No checklist yet" text="Your administrator hasn't set up a store checklist." />;
  const t = st.tpl.find((x: any) => String(x.id) === tid);
  const save = async () => { try { setAudit(await api(s, `/api/visits/${st.visit.id}/audits`, { method: "POST", body: JSON.stringify({ templateId: t.id, answers: ans }) })); } catch (e: any) { toast(e.message, "err"); } };
  return <><h2>Store check</h2><p className="muted">At <b>{st.visit.shop_name}</b></p>
    {st.tpl.length > 1 && <Field label="Checklist"><select value={tid} onChange={e => setTid(e.target.value)}><option value="">Choose…</option>{st.tpl.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
    {t && t.questions.map((q: any) => <div className="qa" key={q.key}><div className="flabel">{q.label}{q.required ? " *" : ""}</div>
      {q.type === "yes_no" && <div className="seg">{["yes", "no"].map(v => <button key={v} className={ans[q.key] === v ? "" : "ghost"} onClick={() => setAns({ ...ans, [q.key]: v })}>{v === "yes" ? "Yes" : "No"}</button>)}</div>}
      {q.type === "number" && <input inputMode="numeric" value={ans[q.key] ?? ""} onChange={e => setAns({ ...ans, [q.key]: e.target.value.replace(/[^\d.]/g, "") })} />}
      {q.type === "text" && <input value={ans[q.key] ?? ""} onChange={e => setAns({ ...ans, [q.key]: e.target.value })} />}
      {q.type === "photo" && (audit ? <PhotoButton label="Take photo" onFile={f => uploadPhoto(s, `/api/audits/${audit.id}/photos`, f, { question: q.key }).then(() => setPhotos(photos + 1)).catch(e => toast(e.message, "err"))} />
        : <p className="muted small">Save your answers first, then add the photo.</p>)}</div>)}
    {t && <button className="block" onClick={save}>{audit ? "Update answers" : "Save answers"}</button>}
    {audit && <p className="muted">Saved. {photos ? `${photos} photo(s) added.` : ""} <button className="link" onClick={() => go("beat")}>Back to visit</button></p>}</>;
}
export function AuditReport({ s }: ViewProps) {
  const [d, setD] = useState<any>(null); const [from, setFrom] = useState(today().slice(0, 8) + "01"); const [to, setTo] = useState(today());
  useEffect(() => { setD(null); api(s, `/api/audits?from=${from}&to=${to}`).then(setD).catch(e => setD({ rows: [], err: e.message })); }, [from, to]);
  return <><h2>Store checks</h2>
    <div className="two"><Field label="From"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="To"><input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
    {!d ? <Loading /> : !d.rows.length ? <Empty icon="✅" title="No store checks in these dates" text={d.err || "They appear here when reps fill a checklist during a visit."} />
      : d.rows.map((r: any) => <div className="row" key={r.id}><b>{r.shop_name}</b> <span className="muted">· {r.rep_name} · {fmtDate(r.day)}</span> {r.score && <span className="pill">{r.score}</span>}
        <div className="muted small">{r.checklist}: {r.answers.filter((a: any) => a.value !== "").map((a: any) => `${a.label} ${a.value}`).join(" · ")}</div>
        <div className="thumbs">{r.photos.map((p: any) => <AuthImg key={p.id} s={s} src={`/api/audit-photos/${p.id}`} alt="Shelf photo" />)}</div></div>)}</>;
}
// ---------- 2) Expenses ----------
const month0 = () => today().slice(0, 7);
const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", rejected: "Rejected" };
export function MyExpenses({ s }: ViewProps) {
  const [list, setList] = useState<any[] | null>(null); const [cats, setCats] = useState<string[]>([]);
  const [f, setF] = useState({ amount: "", category: "", spentOn: today(), note: "" }); const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  const load = () => api(s, "/api/expenses").then(setList).catch(e => { setList([]); toast(e.message, "err"); });
  useEffect(() => { load(); api(s, "/api/expenses/categories").then(setCats); }, []);
  const submit = async () => {
    if (!file) return toast("Add a photo of the bill", "err");
    setBusy(true);
    try { const fd = new FormData(); Object.entries(f).forEach(([k, v]) => fd.append(k, v)); fd.append("receipt", await compressPhoto(file), "receipt.jpg");
      await api(s, "/api/expenses", { method: "POST", body: fd }); setF({ amount: "", category: "", spentOn: today(), note: "" }); setFile(null); load(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  };
  return <><h2>My expenses</h2>
    <div className="card sub"><h3>New claim</h3>
      <Field label="Amount (₹)"><input inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} /></Field>
      <Field label="What for?"><select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">Choose…</option>{cats.map(c => <option key={c}>{c}</option>)}</select></Field>
      <Field label="Date"><input type="date" max={today()} value={f.spentOn} onChange={e => setF({ ...f, spentOn: e.target.value })} /></Field>
      <Field label="Note (optional)"><input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></Field>
      <PhotoButton label={file ? "Bill photo added ✓" : "Photo of the bill"} onFile={setFile} />
      <button className="block" disabled={busy || !f.amount || !f.category} onClick={submit}>{busy ? "Sending…" : "Send claim"}</button></div>
    {list == null ? <Loading /> : !list.length ? <Empty icon="🧾" title="No claims yet" text="Your expense claims and their status show here." />
      : list.map(e => <div className="row" key={e.id}><b>{inr0(e.amount)}</b> {e.category} <span className="muted">· {fmtDate(e.spent_on)}</span> <span className={`pill ${e.status === "pending" ? "placed" : e.status === "approved" ? "fulfilled" : "rejected"}`}>{STATUS[e.status]}</span>
        {e.reason && <div className="muted small">Reason: {e.reason}</div>}</div>)}</>;
}
export function ExpenseApprovals({ s }: ViewProps) {
  const [month, setMonth] = useState(month0()); const [list, setList] = useState<any[] | null>(null); const [rep, setRep] = useState<any>(null); const [open, setOpen] = useState<number | null>(null);
  const load = () => { api(s, `/api/expenses?month=${month}`).then(setList).catch(e => { setList([]); toast(e.message, "err"); }); api(s, `/api/expenses/report?month=${month}`).then(setRep).catch(() => {}); };
  useEffect(() => { load(); }, [month]);
  const decide = async (id: number, status: string) => { const reason = status === "rejected" ? prompt("Why are you rejecting this claim?") : ""; if (status === "rejected" && !reason) return;
    try { await api(s, `/api/expenses/${id}/decision`, { method: "POST", body: JSON.stringify({ status, reason }) }); load(); } catch (e: any) { toast(e.message, "err"); } };
  const pending = (list || []).filter(e => e.status === "pending");
  return <><h2>Expenses</h2>
    <Field label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
    <h3>Waiting for you ({pending.length})</h3>
    {list == null ? <Loading /> : !pending.length ? <p className="muted">No claims waiting.</p> : pending.map(e => <div className="row" key={e.id}><b>{e.rep_name}</b> · {inr0(e.amount)} {e.category} <span className="muted">· {fmtDate(e.spent_on)}{e.note ? ` · ${e.note}` : ""}</span>
      <div className="row-btns"><button className="sm" onClick={() => decide(e.id, "approved")}>Approve</button><button className="sm ghost" onClick={() => decide(e.id, "rejected")}>Reject</button>
        <button className="sm ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? "Hide bill" : "See bill"}</button></div>
      {open === e.id && <AuthImg s={s} src={`/api/expenses/${e.id}/receipt`} alt="Bill photo" />}</div>)}
    <h3>Month summary</h3>
    {rep && <Table rows={rep.reps.map((r: any) => ({ rep_name: r.rep, approved: inr0(r.approved), pending: inr0(r.pending), rejected: inr0(r.rejected), by_category: Object.entries(r.byCategory).map(([k, v]) => `${k} ${inr0(v)}`).join(", ") }))}
      cols={["rep_name", "approved", "pending", "rejected", "by_category"]} empty={{ title: "No claims this month" }} />}</>;
}

