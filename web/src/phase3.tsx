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


// ---------- 3) Leave & attendance ----------
const LSTATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", rejected: "Not approved" };
const pillOf = (st: string) => st === "pending" ? "placed" : st === "approved" ? "fulfilled" : "rejected";
const range = (l: any) => l.from_date === l.to_date ? fmtDate(l.from_date) : `${fmtDate(l.from_date)} to ${fmtDate(l.to_date)}`;
export function MyLeave({ s }: ViewProps) {
  const [list, setList] = useState<any[] | null>(null); const [f, setF] = useState({ from: today(), to: today(), kind: "Casual", reason: "" });
  const load = () => api(s, "/api/leaves").then(setList).catch(e => { setList([]); toast(e.message, "err"); }); useEffect(() => { load(); }, []);
  const apply = async () => { try { await api(s, "/api/leaves", { method: "POST", body: JSON.stringify(f) }); setF({ ...f, reason: "" }); load(); } catch (e: any) { toast(e.message, "err"); } };
  return <><h2>My leave</h2>
    <div className="card sub"><h3>Apply for leave</h3>
      <div className="two"><Field label="First day"><input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to })} /></Field>
        <Field label="Last day"><input type="date" min={f.from} value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></Field></div>
      <Field label="Type"><select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>{["Casual", "Sick", "Other"].map(k => <option key={k}>{k}</option>)}</select></Field>
      <Field label="Reason (optional)"><input value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></Field>
      <button className="block" onClick={apply}>Send to manager</button></div>
    {list == null ? <Loading /> : !list.length ? <Empty icon="🌴" title="No leave yet" text="Your leave requests show here." />
      : list.map(l => <div className="row" key={l.id}><b>{range(l)}</b> <span className="muted">· {l.kind} · {l.days} day{l.days > 1 ? "s" : ""}</span> <span className={`pill ${pillOf(l.status)}`}>{LSTATUS[l.status]}</span>
        {l.status === "pending" && <button className="link" onClick={() => api(s, `/api/leaves/${l.id}/cancel`, { method: "POST" }).then(load)}>Cancel</button>}</div>)}</>;
}
export function LeaveApprovals({ s }: ViewProps) {
  const [list, setList] = useState<any[] | null>(null); const [month, setMonth] = useState(month0()); const [att, setAtt] = useState<any>(null);
  const load = () => api(s, "/api/leaves").then(setList).catch(e => { setList([]); toast(e.message, "err"); });
  useEffect(() => { load(); }, []); useEffect(() => { api(s, `/api/attendance?month=${month}`).then(setAtt).catch(() => {}); }, [month, list]);
  const decide = (id: number, status: string) => api(s, `/api/leaves/${id}/decision`, { method: "POST", body: JSON.stringify({ status }) }).then(load).catch(e => toast(e.message, "err"));
  const pending = (list || []).filter(l => l.status === "pending");
  return <><h2>Leave & attendance</h2>
    <h3>Waiting for you ({pending.length})</h3>
    {list == null ? <Loading /> : !pending.length ? <p className="muted">No leave requests waiting.</p> : pending.map(l => <div className="row" key={l.id}><b>{l.rep_name}</b> · {range(l)} <span className="muted">· {l.kind}{l.reason ? ` · ${l.reason}` : ""}</span>
      <div className="row-btns"><button className="sm" onClick={() => decide(l.id, "approved")}>Approve</button><button className="sm ghost" onClick={() => decide(l.id, "rejected")}>Reject</button></div></div>)}
    <h3>Leave calendar</h3>
    {(list || []).filter(l => l.status === "approved").slice(0, 20).map(l => <div className="row" key={l.id}>🌴 <b>{l.rep_name}</b> · {range(l)} <span className="muted">· {l.kind}</span></div>)}
    <h3>Attendance</h3><Field label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
    {att && <Table rows={att.reps.map((r: any) => ({ rep_name: r.rep, days_worked: r.present, days_on_leave: r.leave }))} cols={["rep_name", "days_worked", "days_on_leave"]} empty={{ title: "No sales reps yet" }} />}
    <p className="muted small">Days worked = days with at least one outlet visit.</p></>;
}

// ---------- 4) Incentives ----------
const METRIC: Record<string, string> = { value: "sales value", orders: "number of orders", visits: "number of visits" };
export function IncentiveRules({ s }: ViewProps) {
  const [list, setList] = useState<any[] | null>(null); const [name, setName] = useState(""); const [metric, setMetric] = useState("value");
  const [slabs, setSlabs] = useState([{ minPct: "80", amount: "1000" }, { minPct: "100", amount: "2500" }]);
  const load = () => api(s, "/api/incentive-rules").then(setList).catch(e => { setList([]); toast(e.message, "err"); }); useEffect(() => { load(); }, []);
  const save = () => api(s, "/api/incentive-rules", { method: "POST", body: JSON.stringify({ name, metric, slabs: slabs.filter(x => x.minPct).map(x => ({ minPct: Number(x.minPct), amount: Number(x.amount) })) }) })
    .then(() => { setName(""); load(); }).catch(e => toast(e.message, "err"));
  return <><h2>Incentive rules</h2><p className="muted">Pay a bonus when a sales rep reaches a % of their monthly target. The highest step reached is paid.</p>
    {list == null ? <Loading /> : list.map(r => <div className="row" key={r.id}><b>{r.name}</b> {!r.active && <span className="pill">off</span>}
      <div className="muted small">On {METRIC[r.metric]} target: {r.slabs.map((x: any) => `${x.minPct}% → ${inr0(x.amount)}`).join(" · ")}</div>
      <button className="sm ghost" onClick={() => api(s, `/api/incentive-rules/${r.id}/active`, { method: "POST", body: JSON.stringify({ active: !r.active }) }).then(load)}>{r.active ? "Turn off" : "Turn on"}</button></div>)}
    <div className="card sub"><h3>New rule</h3>
      <Field label="Rule name"><input value={name} placeholder="e.g. Monthly sales bonus" onChange={e => setName(e.target.value)} /></Field>
      <Field label="Based on the target for"><select value={metric} onChange={e => setMetric(e.target.value)}>{Object.entries(METRIC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      {slabs.map((x, i) => <div className="two" key={i}><Field label="If they reach (%)"><input inputMode="numeric" value={x.minPct} onChange={e => setSlabs(slabs.map((y, j) => j === i ? { ...y, minPct: e.target.value.replace(/\D/g, "") } : y))} /></Field>
        <Field label="They earn (₹)"><input inputMode="numeric" value={x.amount} onChange={e => setSlabs(slabs.map((y, j) => j === i ? { ...y, amount: e.target.value.replace(/[^\d.]/g, "") } : y))} /></Field></div>)}
      <button className="ghost sm" onClick={() => setSlabs([...slabs, { minPct: "", amount: "" }])}>+ Add step</button>{" "}<button onClick={save} disabled={!name.trim()}>Save rule</button></div></>;
}
export function Incentives({ s }: ViewProps) {
  const [month, setMonth] = useState(month0()); const [d, setD] = useState<any[] | null>(null);
  useEffect(() => { setD(null); api(s, `/api/incentives?month=${month}`).then(setD).catch(e => { setD([]); toast(e.message, "err"); }); }, [month]);
  const rep = s.user.role === "sales_rep";
  return <><h2>{rep ? "My incentives" : "Incentives"}</h2><Field label="Month"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /></Field>
    {d == null ? <Loading /> : !d.length ? <Empty icon="🏆" title="No sales reps yet" /> : d.map(r => <div className="row" key={r.repId}>
      {rep ? <div className="earn">{inr0(r.total)}</div> : <><b>{r.rep}</b> · <b>{inr0(r.total)}</b></>}
      {!r.lines.length && <p className="muted">No incentive rules set up yet.</p>}
      {r.lines.map((l: any) => <div key={l.ruleId} className="muted small">{l.rule}: {l.target == null ? "no target set this month" : `${l.pct}% of ${METRIC[l.metric]} target → ${inr0(l.earned)}`}
        {l.next && ` · reach ${l.next.minPct}% to earn ${inr0(l.next.amount)}`}</div>)}</div>)}</>;
}
