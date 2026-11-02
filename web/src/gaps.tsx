// Screens for: Team & territories (org chart), New-outlet approval, Add outlet (rep), Sales returns,
// My account statement (retailer) and the single Product form (admin). Plain language, one task per screen.
import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps, type Session } from "./main";
import { t } from "./i18n";
import { Empty, Loading, Field, toast, inr, fmtDate, today } from "./ui";
import { compressPhoto, AuthImg } from "./phase3";

const blobToDataUrl = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(b); });
const photoData = async (f: File | null) => f ? blobToDataUrl(await compressPhoto(f, 1024, 0.6)) : undefined;
const ref = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gps = () => new Promise<{ lat: number; lng: number }>((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), e => no(new Error(e.message)), { enableHighAccuracy: true, timeout: 15000 }) : no(new Error(t("GPS unavailable"))));
const STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", partial: "Partly approved", rejected: "Rejected" };
const pill = (st: string) => <span className={`pill ${st === "pending" ? "placed" : st === "rejected" ? "rejected" : "fulfilled"}`}>{t(STATUS[st] || st)}</span>;
const openHtml = async (s: Session, url: string) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }); if (!r.ok) return toast(t((await r.json().catch(() => ({}))).error || r.statusText), "err");
  window.open(URL.createObjectURL(new Blob([await r.text()], { type: "text/html" })), "_blank");
};

// ---------- 1) Team & territories (org chart) ----------
export function TeamPage({ s }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [h, setH] = useState<any>(null); const [nt, setNt] = useState({ name: "", level: "Area", parentId: "" });
  const load = () => api(s, "/api/hierarchy").then(setH).catch(e => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  if (!h) return <Loading />;
  const byBoss = new Map<number | null, any[]>();
  const ids = new Set(h.users.map((u: any) => u.id));
  for (const u of h.users) { const k = u.reports_to && ids.has(u.reports_to) ? u.reports_to : null; byBoss.set(k, [...(byBoss.get(k) || []), u]); }
  const set = async (id: number, body: any) => { try { await api(s, `/api/users/${id}/hierarchy`, { method: "PUT", body: JSON.stringify(body) }); load(); } catch (e: any) { toast(e.message, "err"); } };
  const Node = ({ u, depth }: { u: any; depth: number }): any => <>
    <div className="row org" style={{ marginLeft: depth * 18 }}><b>{u.name}</b> <span className="muted">{t(u.role === "sales_rep" ? "Sales rep" : u.role === "manager" ? "Manager" : "Admin")}{u.territory ? ` · ${u.territory} (${t(u.territory_level)})` : ""}</span>
      {admin && <div className="row-btns">
        <label className="small">{t("Reports to")} <select value={u.reports_to ?? ""} onChange={e => set(u.id, { reportsTo: e.target.value || null })}><option value="">{t("Nobody (top)")}</option>
          {h.users.filter((x: any) => x.id !== u.id && x.role !== "sales_rep").map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className="small">{t("Territory")} <select value={u.territory_id ?? ""} onChange={e => set(u.id, { territoryId: e.target.value || null })}><option value="">{t("None")}</option>
          {h.territories.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label></div>}</div>
    {(byBoss.get(u.id) || []).map((k: any) => <Node key={k.id} u={k} depth={depth + 1} />)}</>;
  const addT = async (e: any) => { e.preventDefault(); try { await api(s, "/api/territories", { method: "POST", body: JSON.stringify({ ...nt, parentId: nt.parentId || null }) }); setNt({ name: "", level: "Area", parentId: "" }); load(); } catch (x: any) { toast(x.message, "err"); } };
  const tree = (pid: number | null, d: number): any[] => h.territories.filter((x: any) => (x.parent_id ?? null) === pid).flatMap((x: any) => [<div key={x.id} className="row" style={{ marginLeft: d * 18 }}>{x.name} <span className="muted">{t(x.level)}</span></div>, ...tree(x.id, d + 1)]);
  return <><h2>{t("Team & territories")}</h2>
    <p className="muted">{h.scoped ? t("You see your own team: the people who report to you, directly or through others.") : t("Managers see only the people who report to them. A manager nobody reports to sees everyone.")}</p>
    <h3>{t("Org chart")}</h3>{!h.users.length ? <Empty title={t("No users yet")} /> : (byBoss.get(null) || []).map((u: any) => <Node key={u.id} u={u} depth={0} />)}
    <h3>{t("Territories")}</h3>{h.territories.length ? tree(null, 0) : <p className="muted">{t("No territories yet.")}</p>}
    {admin && <form className="card" onSubmit={addT}><b>{t("Add territory")}</b>
      <Field label={t("Name")}><input value={nt.name} onChange={e => setNt({ ...nt, name: e.target.value })} /></Field>
      <Field label={t("Level")}><select value={nt.level} onChange={e => setNt({ ...nt, level: e.target.value })}>{h.levels.map((l: string) => <option key={l} value={l}>{t(l)}</option>)}</select></Field>
      <Field label={t("Inside (parent)")}><select value={nt.parentId} onChange={e => setNt({ ...nt, parentId: e.target.value })}><option value="">{t("None")}</option>{h.territories.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <button>{t("Add territory")}</button></form>}
</>;
}

// ---------- 5) New-outlet approval (manager / admin) ----------
export function OutletApprovals({ s }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [st, setSt] = useState("pending"); const [list, setList] = useState<any[] | null>(null); const [rules, setRules] = useState<any>(null); const [open, setOpen] = useState<number | null>(null);
  const load = () => { setList(null); api(s, `/api/outlets/pending?status=${st}`).then(setList).catch(e => { setList([]); toast(e.message, "err"); }); };
  useEffect(() => { load(); }, [st]); useEffect(() => { api(s, "/api/outlet-rules").then(setRules).catch(() => {}); }, []);
  const decide = async (id: number, decision: string) => { const reason = decision === "reject" ? prompt(t("Why are you rejecting this outlet?")) : ""; if (decision === "reject" && !reason) return;
    try { await api(s, `/api/outlets/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, reason }) }); load(); } catch (e: any) { toast(e.message, "err"); } };
  const setRule = async (k: string, v: boolean) => { try { setRules(await api(s, "/api/outlet-rules", { method: "PUT", body: JSON.stringify({ [k]: v }) })); } catch (e: any) { toast(e.message, "err"); } };
  return <><h2>{t("New outlets")}</h2>
    <div className="row-btns">{["pending", "approved", "rejected"].map(x => <button key={x} className={`sm ${x === st ? "" : "ghost"}`} onClick={() => setSt(x)}>{t(STATUS[x])}</button>)}</div>
    {list == null ? <Loading /> : !list.length ? <Empty icon="🏪" title={t("No outlets here")} /> : list.map(o => <div className="row" key={o.id}>
      <b>{o.name}</b> {pill(o.approval_status)} <span className="muted">{o.code} · {t("Added by {0}", o.added_by_name)}{o.city ? ` · ${o.city}` : ""}{o.phone ? ` · ${o.phone}` : ""}</span>
      {o.lat != null && <div className="small"><a href={`https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lng}#map=17/${o.lat}/${o.lng}`} target="_blank" rel="noreferrer">📍 {Number(o.lat).toFixed(5)}, {Number(o.lng).toFixed(5)}</a></div>}
      {o.approval_reason && <div className="small muted">{t("Reason")}: {o.approval_reason}</div>}
      <div className="row-btns">{o.approval_status === "pending" && <><button className="sm" onClick={() => decide(o.id, "approve")}>{t("Approve")}</button><button className="sm ghost" onClick={() => decide(o.id, "reject")}>{t("Reject")}</button></>}
        {o.has_photo && <button className="sm ghost" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? t("Hide photo") : t("See photo")}</button>}</div>
      {open === o.id && <AuthImg s={s} src={`/api/outlets/${o.id}/photo`} alt={t("Outlet photo")} />}</div>)}
    {rules && <div className="card"><b>{t("Outlet rules")}</b>
      <label className="check"><input type="checkbox" disabled={!admin} checked={!!rules.pendingCanOrder} onChange={e => setRule("pendingCanOrder", e.target.checked)} /> {t("Outlets waiting for approval can take orders")}</label>
      <label className="check"><input type="checkbox" disabled={!admin} checked={!!rules.repOwnBeatsOnly} onChange={e => setRule("repOwnBeatsOnly", e.target.checked)} /> {t("Reps see only outlets on their own beats, plus the ones they added")}</label></div>}</>;
}

// ---------- 5) Add outlet (rep, works offline) ----------
export function AddOutlet({ s }: ViewProps) {
  const blank = { name: "", owner_name: "", phone: "", address: "", city: "", pincode: "", gstin: "", outlet_type: "", beatId: "" };
  const [f, setF] = useState(blank); const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null); const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [mine, setMine] = useState<any[] | null>(null); const [beats, setBeats] = useState<any[]>([]);
  const load = () => api(s, "/api/outlets/mine").then(setMine).catch(() => setMine([]));
  useEffect(() => { load(); api(s, "/api/beats").then(setBeats).catch(() => {}); }, []);
  const locate = () => gps().then(setPos).catch(e => toast(e.message, "err"));
  const save = async (e: any) => {
    e.preventDefault(); if (!f.name.trim()) return toast(t("Enter the outlet name"), "err"); if (!pos) return toast(t("Capture the GPS location first"), "err");
    setBusy(true);
    try { const r = await api(s, "/api/outlets/request", { method: "POST", body: JSON.stringify({ ...f, beatId: f.beatId || undefined, clientRef: ref(), lat: pos.lat, lng: pos.lng, photo: await photoData(photo) }) });
      toast(r.queued ? t("Saved offline — will sync when online") : t("Sent for approval")); setF(blank); setPos(null); setPhoto(null); load(); }
    catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); }
  };
  const inp = (k: keyof typeof blank, label: string, mode?: any) => <Field label={label}><input inputMode={mode} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>;
  return <><h2>{t("Add outlet")}</h2><p className="muted">{t("A new outlet waits for your manager's approval before it can take orders.")}</p>
    <form className="card" onSubmit={save}>
      {inp("name", t("Outlet name"))}{inp("owner_name", t("Owner name"))}{inp("phone", t("Phone"), "tel")}{inp("address", t("Address"))}{inp("city", t("City"))}{inp("pincode", t("PIN code"), "numeric")}{inp("gstin", t("GSTIN (optional)"))}{inp("outlet_type", t("Outlet type"))}
      {!!beats.length && <Field label={t("Add to my beat")}><select value={f.beatId} onChange={e => setF({ ...f, beatId: e.target.value })}><option value="">{t("None")}</option>{beats.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
      <Field label={t("GPS location")}><div className="row-btns"><button type="button" className="sm ghost" onClick={locate}>📍 {t("Capture location")}</button>{pos && <span className="small">{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</span>}</div></Field>
      <Field label={t("Photo (optional)")}><input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] || null)} /></Field>
      <button disabled={busy}>{busy ? t("Saving…") : t("Send for approval")}</button></form>
    <h3>{t("Outlets I added")}</h3>
    {mine == null ? <Loading /> : !mine.length ? <p className="muted">{t("None yet.")}</p> : mine.map(o => <div className="row" key={o.id}><b>{o.name}</b> {pill(o.approval_status)} <span className="muted">{o.code}{o.approval_reason ? ` · ${o.approval_reason}` : ""}</span></div>)}</>;
}

// ---------- 4) Sales returns ----------
export function Returns({ s }: ViewProps) {
  const role = s.user.role, rep = role === "sales_rep", decider = role === "distributor" || role === "company_admin" || role === "manager";
  const [list, setList] = useState<any[] | null>(null); const [st, setSt] = useState(rep ? "" : "pending"); const [damaged, setDamaged] = useState<any[] | null>(null);
  const load = () => { setList(null); api(s, `/api/returns${st ? `?status=${st}` : ""}`).then(setList).catch(e => { setList([]); toast(e.message, "err"); }); };
  useEffect(() => { load(); }, [st]); useEffect(() => { if (!rep) api(s, "/api/returns/damaged").then(setDamaged).catch(() => setDamaged([])); }, []);
  const [qty, setQty] = useState<Record<number, number>>({}); const [open, setOpen] = useState<number | null>(null);
  const decide = async (r: any, decision: string) => {
    const note = decision === "reject" ? prompt(t("Why are you rejecting this return?")) : ""; if (decision === "reject" && !note) return;
    try { const x = await api(s, `/api/returns/${r.id}/decision`, { method: "POST", body: JSON.stringify({ decision, note, lines: r.lines.map((l: any) => ({ id: l.id, approvedQty: qty[l.id] ?? l.qty })) }) });
      if (x.credit_note) toast(t("Credit note {0} for {1} created", x.credit_note.number, inr(x.credit_note.total))); load(); } catch (e: any) { toast(e.message, "err"); }
  };
  const canDecide = (r: any) => r.status === "pending" && (role === "distributor" || role === "company_admin" || (role === "manager" && !r.distributor_id));
  return <><h2>{t("Sales returns")}</h2>
    {rep && <BookReturn s={s} onDone={load} />}
    <div className="row-btns">{["", "pending", "approved", "partial", "rejected"].map(x => <button key={x} className={`sm ${x === st ? "" : "ghost"}`} onClick={() => setSt(x)}>{x ? t(STATUS[x]) : t("All")}</button>)}</div>
    {list == null ? <Loading /> : !list.length ? <Empty icon="↩️" title={t("No returns here")}  /> : list.map(r => <div className="row" key={r.id}>
      <b>#{r.id} {r.shop_name}</b> {pill(r.status)} <span className="muted">· {fmtDate(r.created_at)} · {t(r.reason)}{r.invoice_number ? ` · ${t("Invoice")} ${r.invoice_number}` : ` · ${t("No invoice")}`}{r.rep_name ? ` · ${r.rep_name}` : ""}{r.distributor_name ? ` · ${r.distributor_name}` : ""}</span>
      {r.note && <div className="small">{r.note}</div>}
      <table className="small"><thead><tr><th>{t("Product")}</th><th>{t("Condition")}</th><th>{t("Qty")}</th><th>{t("Approved")}</th></tr></thead><tbody>{r.lines.map((l: any) => <tr key={l.id}><td>{l.item_name} <span className="muted">{l.sku}</span></td><td>{t(l.condition === "damaged" ? "Damaged" : "Saleable")}</td><td>{l.qty}</td>
        <td>{canDecide(r) && decider ? <input type="number" min={0} max={l.qty} style={{ width: 64 }} value={qty[l.id] ?? l.qty} onChange={e => setQty({ ...qty, [l.id]: Math.max(0, Math.min(l.qty, Number(e.target.value) || 0)) })} /> : l.approved_qty ?? "—"}</td></tr>)}</tbody></table>
      {r.credit_note_number && <div className="small">{t("Credit note")}: <b>{r.credit_note_number}</b> · {inr(r.credit_total)} {!rep && <button className="sm ghost" onClick={() => openHtml(s, `/api/invoices/${r.credit_note_id}/print`)}>{t("Print")}</button>}</div>}
      {r.decision_note && <div className="small muted">{t("Note")}: {r.decision_note}</div>}
      <div className="row-btns">{canDecide(r) && <><button className="sm" onClick={() => decide(r, "approve")}>{t("Approve")}</button><button className="sm ghost" onClick={() => decide(r, "reject")}>{t("Reject")}</button></>}
        {r.has_photo && <button className="sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t("Hide photo") : t("See photo")}</button>}</div>
      {open === r.id && <AuthImg s={s} src={`/api/returns/${r.id}/photo`} alt={t("Return photo")} />}</div>)}
    {!rep && <><h3>{t("Damaged returned goods")}</h3>
      <Table rows={damaged} cols={["location", "sku", "item_name", "qty"]} empty={{ title: t("No damaged returns") }} /></>}</>;
}

function BookReturn({ s, onDone }: { s: Session; onDone: () => void }) {
  const [shops, setShops] = useState<any[]>([]); const [products, setProducts] = useState<any[]>([]); const [meta, setMeta] = useState<any>({ reasons: [], conditions: [] });
  const [shopId, setShopId] = useState(""); const [invs, setInvs] = useState<any[]>([]); const [invId, setInvId] = useState("");
  const [lines, setLines] = useState<any[]>([]); const [reason, setReason] = useState(""); const [note, setNote] = useState(""); const [photo, setPhoto] = useState<File | null>(null); const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState("");
  useEffect(() => { api(s, "/api/shops").then(setShops).catch(() => {}); api(s, "/api/products").then(setProducts).catch(() => {}); api(s, "/api/returns/reasons").then(setMeta).catch(() => {}); }, []);
  useEffect(() => { setInvId(""); setLines([]); setInvs([]); if (shopId) api(s, `/api/returns/invoices?shopId=${shopId}`).then(setInvs).catch(() => {}); }, [shopId]);
  const inv = invs.find(i => String(i.id) === invId);
  useEffect(() => { setLines(inv ? inv.lines.filter((l: any) => l.returnable > 0).map((l: any) => ({ invoiceLineId: l.id, label: l.description, max: l.returnable, qty: 0, condition: "saleable" })) : []); }, [invId]);
  const add = () => { const p = products.find(x => String(x.id) === pick); if (!p) return; setLines([...lines, { variantId: p.id, label: `${p.item_name} ${p.sku}`, qty: 1, condition: "saleable" }]); setPick(""); };
  const save = async (e: any) => {
    e.preventDefault(); const ls = lines.filter(l => l.qty > 0);
    if (!shopId) return toast(t("Pick the outlet"), "err"); if (!reason) return toast(t("Pick a reason"), "err"); if (!ls.length) return toast(t("Enter a quantity for at least one product"), "err");
    setBusy(true);
    try { const r = await api(s, "/api/returns", { method: "POST", body: JSON.stringify({ clientRef: ref(), shopId: Number(shopId), invoiceId: invId ? Number(invId) : undefined, reason, note, photo: await photoData(photo),
      lines: ls.map(l => ({ invoiceLineId: l.invoiceLineId, variantId: l.variantId, qty: l.qty, condition: l.condition })) }) });
      toast(r.queued ? t("Saved offline — will sync when online") : t("Sent for approval")); setLines([]); setInvId(""); setReason(""); setNote(""); setPhoto(null); onDone(); }
    catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); }
  };
  return <form className="card" onSubmit={save}><b>{t("Book a return")}</b>
    <Field label={t("Outlet")}><select value={shopId} onChange={e => setShopId(e.target.value)}><option value="">{t("Pick the outlet")}</option>{shops.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
    {shopId && <Field label={t("Against invoice")}><select value={invId} onChange={e => setInvId(e.target.value)}><option value="">{t("No invoice")}</option>{invs.map(i => <option key={i.id} value={i.id}>{i.number} · {fmtDate(i.doc_date)} · {inr(i.total)}</option>)}</select></Field>}
    {!invId && shopId && <div className="row-btns"><select value={pick} onChange={e => setPick(e.target.value)}><option value="">{t("Pick a product")}</option>{products.map(p => <option key={p.id} value={p.id}>{p.item_name} · {p.sku}</option>)}</select><button type="button" className="sm ghost" onClick={add}>{t("Add")}</button></div>}
    {lines.map((l, i) => <div className="row" key={i}>{l.label}{l.max != null && <span className="muted small"> · {t("up to {0}", l.max)}</span>}
      <div className="row-btns"><input type="number" min={0} max={l.max} style={{ width: 70 }} value={l.qty} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: Math.max(0, Math.min(x.max ?? 1e6, Number(e.target.value) || 0)) } : x))} aria-label={t("Qty")} />
        <select value={l.condition} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, condition: e.target.value } : x))}><option value="saleable">{t("Saleable")}</option><option value="damaged">{t("Damaged")}</option></select></div></div>)}
    <Field label={t("Reason")}><select value={reason} onChange={e => setReason(e.target.value)}><option value="">{t("Pick a reason")}</option>{meta.reasons.map((r: string) => <option key={r} value={r}>{t(r)}</option>)}</select></Field>
    <Field label={t("Note (optional)")}><input value={note} onChange={e => setNote(e.target.value)} /></Field>
    <Field label={t("Photo (optional)")}><input type="file" accept="image/*" capture="environment" onChange={e => setPhoto(e.target.files?.[0] || null)} /></Field>
    <button disabled={busy}>{busy ? t("Saving…") : t("Send for approval")}</button></form>;
}

// ---------- 2) Retailer: my account statement ----------
export function RetailerAccount({ s }: ViewProps) {
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`); const [to, setTo] = useState(today()); const [a, setA] = useState<any>(null);
  const load = () => api(s, `/api/retailer/account?from=${from}&to=${to}`).then(setA).catch(e => toast(e.message, "err"));
  useEffect(() => { load(); }, [from, to]);
  if (!a) return <Loading />;
  const c = a.credit;
  return <><h2>{t("Account statement")}</h2><p className="muted">{a.shop.name} · {a.shop.code}</p>
    <div className="kpis"><div className="kpi"><span>{t("Outstanding")}</span><b>{inr(c.outstanding)}</b></div>
      <div className="kpi"><span>{t("Credit limit")}</span><b>{c.limit ? inr(c.limit) : t("No limit")}</b></div>
      <div className="kpi"><span>{t("Available credit")}</span><b>{c.available == null ? "—" : inr(c.available)}</b></div>
      <div className="kpi"><span>{t("Overdue")}</span><b>{inr(c.overdue)}</b></div></div>
    <h3>{t("Outstanding by age")}</h3>
    <Table rows={[{ "0-30": inr(a.ageing["0-30"]), "31-60": inr(a.ageing["31-60"]), "61-90": inr(a.ageing["61-90"]), "90+": inr(a.ageing["90+"]) }]} cols={["0-30", "31-60", "61-90", "90+"]} />
    <h3>{t("Statement")}</h3>
    <div className="row-btns"><Field label={t("From")}><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label={t("To")}><input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field></div>
    <div className="scroll"><table><thead><tr><th>{t("Date")}</th><th>{t("Type")}</th><th>{t("Number")}</th><th>{t("Details")}</th><th>{t("Debit")}</th><th>{t("Credit")}</th><th>{t("Balance")}</th></tr></thead><tbody>
      <tr><td colSpan={6}><i>{t("Opening balance")}</i></td><td>{inr(a.statement.opening)}</td></tr>
      {a.statement.lines.map((l: any, i: number) => <tr key={i}><td>{fmtDate(l.date)}</td><td>{t(l.type)}</td><td>{l.doc_id ? <a href="#" onClick={e => { e.preventDefault(); openHtml(s, `/api/retailer/invoices/${l.doc_id}/print`); }}>{l.number}</a> : l.number}</td><td>{l.detail}</td>
        <td>{l.debit ? inr(l.debit) : ""}</td><td>{l.credit ? inr(l.credit) : ""}</td><td>{inr(l.balance)}</td></tr>)}
      <tr><td colSpan={4}><b>{t("Closing balance")}</b></td><td>{inr(a.statement.debit)}</td><td>{inr(a.statement.credit)}</td><td><b>{inr(a.statement.closing)}</b></td></tr></tbody></table></div>
    <h3>{t("Invoices and credit notes")}</h3>
    {!a.documents.length ? <p className="muted">{t("No invoices yet.")}</p> : a.documents.map((d: any) => <div className="row" key={d.id}><b>{d.number}</b> <span className="muted">{t(d.kind === "invoice" ? "Invoice" : "Credit note")} · {fmtDate(d.doc_date)} · {inr(d.total)}{d.kind === "invoice" ? ` · ${t("Due")} ${inr(d.outstanding)}` : ""}</span>
      <div className="row-btns"><button className="sm ghost" onClick={() => openHtml(s, `/api/retailer/invoices/${d.id}/print`)}>{t("Open")}</button><button className="sm ghost" onClick={() => openHtml(s, `/api/retailer/invoices/${d.id}/print`)}>{t("Download PDF")}</button></div></div>)}
    <h3>{t("Payments")}</h3>
    <Table rows={a.payments.map((p: any) => ({ number: p.number, date: p.pay_date, mode: String(p.mode).toUpperCase(), reference: p.reference || "", amount: inr(p.amount), status: t(p.status === "bounced" ? "Bounced" : "Cleared") }))} cols={["number", "date", "mode", "reference", "amount", "status"]} empty={{ title: t("No payments yet") }} />
    <h3>{t("Returns")}</h3>
    {!a.returns.length ? <p className="muted">{t("No returns yet.")}</p> : a.returns.map((r: any) => <div className="row" key={r.id}>#{r.id} {pill(r.status)} <span className="muted">{fmtDate(r.created_at)} · {t(r.reason)}{r.credit_note ? ` · ${t("Credit note")} ${r.credit_note} ${inr(r.credit_total)}` : ""}</span></div>)}</>;
}

// ---------- 3) Product form (admin): add / edit one product with all its sizes ----------
export function ProductForm({ s, cfg }: ViewProps) {
  const attrs: string[] = cfg.settings.attributes || []; const pf = cfg.settings.customFields.product || [];
  const [items, setItems] = useState<any[] | null>(null); const [q, setQ] = useState(""); const [edit, setEdit] = useState<any>(null); const [busy, setBusy] = useState(false);
  const load = () => api(s, "/api/items").then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  const blankV = () => ({ sku: "", attrs: Object.fromEntries(attrs.map(a => [a, ""])), mrp: "", billing_price: "", barcode: "", active: true });
  const start = (i?: any) => setEdit(i ? { id: i.id, code: i.code, name: i.name, category: i.category || "", kind: i.kind, hsn: i.hsn || "", units: (i.uoms || []).map((u: any) => `${u.code}=${u.factor}`).join("|"), images: (i.images || []).join("\n"), active: i.active !== false, custom: i.custom || {},
    variants: i.variants.filter((v: any) => v.active !== false).map((v: any) => ({ ...v, attrs: { ...Object.fromEntries(attrs.map(a => [a, ""])), ...v.attrs }, barcode: v.barcode || "" })) }
    : { id: null, code: "", name: "", category: "", kind: "goods", hsn: "", units: "", images: "", active: true, custom: {}, variants: [blankV()] });
  const problems = (e: any) => { const p: string[] = [];
    if (!e.code.trim()) p.push(t("Style / item code is required")); if (!e.name.trim()) p.push(t("Product name is required"));
    if (e.hsn && !/^\d{4,8}$/.test(e.hsn)) p.push(t("HSN/SAC must be 4 to 8 digits"));
    const skus = e.variants.map((v: any) => v.sku.trim()); if (skus.some((x: string) => !x)) p.push(t("Every size needs a SKU")); if (new Set(skus).size !== skus.length) p.push(t("The same SKU is listed twice"));
    for (const v of e.variants) { const m = Number(v.mrp), b = Number(v.billing_price); if (!(m > 0) || !(b > 0)) p.push(t("{0}: MRP and billing price must be more than 0", v.sku || "?")); else if (b > m) p.push(t("{0}: billing price cannot be more than MRP", v.sku)); }
    return p; };
  const save = async (ev: any) => {
    ev.preventDefault(); const p = problems(edit); if (p.length) return toast(p[0], "err");
    setBusy(true);
    try { await api(s, edit.id ? `/api/products/item/${edit.id}` : "/api/products/item", { method: edit.id ? "PUT" : "POST", body: JSON.stringify({ ...edit, images: edit.images.split(/\s+/).filter(Boolean),
      variants: edit.variants.map((v: any) => ({ ...v, mrp: Number(v.mrp), billing_price: Number(v.billing_price) })) }) }); setEdit(null); load(); }
    catch (x: any) { toast(x.message, "err"); } finally { setBusy(false); }
  };
  const upload = async (f: File | null) => { if (!f) return; try { const fd = new FormData(); fd.append("photo", await compressPhoto(f), "p.jpg"); const r = await api(s, "/api/products/images", { method: "POST", body: fd }); setEdit({ ...edit, images: `${edit.images}\n${r.url}`.trim() }); } catch (e: any) { toast(e.message, "err"); } };
  if (edit) {
    const E = (k: string, label: string, help?: string) => <Field label={label} help={help}><input value={edit[k]} disabled={k === "code" && !!edit.id} onChange={e => setEdit({ ...edit, [k]: e.target.value })} /></Field>;
    const V = (i: number, k: string, v: any) => setEdit({ ...edit, variants: edit.variants.map((x: any, j: number) => j === i ? { ...x, [k]: v } : x) });
    return <><h2>{edit.id ? t("Edit product") : t("Add product")}</h2><form className="card" onSubmit={save}>
      {E("code", t("Style / item code"))}{E("name", t("Product name"))}{E("category", t("Category"))}
      <Field label={t("Type")}><select value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value })}><option value="goods">{t("Goods")}</option>{cfg.settings.features.services && <option value="service">{t("Service")}</option>}</select></Field>
      {E("hsn", t("HSN/SAC code"))}{E("units", t("Units"), t("e.g. PCS=1|BOX=6. Blank = company default."))}
      <Field label={t("Images")} help={t("One https:// link per line, up to 6, or upload a photo.")}><textarea rows={3} value={edit.images} onChange={e => setEdit({ ...edit, images: e.target.value })} /></Field>
      <input type="file" accept="image/*" onChange={e => upload(e.target.files?.[0] || null)} aria-label={t("Upload photo")} />
      <div className="row-btns">{edit.images.split(/\s+/).filter(Boolean).map((u: string) => <img key={u} src={u} alt="" style={{ height: 56, borderRadius: 6 }} />)}</div>
      {pf.map((c: any) => <Field key={c.key} label={c.label}><input value={edit.custom[c.key] ?? ""} onChange={e => setEdit({ ...edit, custom: { ...edit.custom, [c.key]: e.target.value } })} /></Field>)}
      <label className="check"><input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> {t("Active (reps and shops can order it)")}</label>
      <h3>{t("Sizes / variants")}</h3>
      <div className="scroll"><table><thead><tr><th>SKU</th>{attrs.map(a => <th key={a}>{t(a.replace(/_/g, " "))}</th>)}<th>MRP</th><th>{t("Billing price")}</th><th>{t("Barcode")}</th><th>{t("Active")}</th><th></th></tr></thead><tbody>
        {edit.variants.map((v: any, i: number) => <tr key={i}><td><input value={v.sku} onChange={e => V(i, "sku", e.target.value)} aria-label="SKU" /></td>
          {attrs.map(a => <td key={a}><input value={v.attrs[a] ?? ""} style={{ width: 70 }} onChange={e => V(i, "attrs", { ...v.attrs, [a]: e.target.value })} aria-label={a} /></td>)}
          <td><input type="number" step="0.01" style={{ width: 80 }} value={v.mrp} onChange={e => V(i, "mrp", e.target.value)} aria-label="MRP" /></td><td><input type="number" step="0.01" style={{ width: 80 }} value={v.billing_price} onChange={e => V(i, "billing_price", e.target.value)} aria-label={t("Billing price")} /></td>
          <td><input value={v.barcode} style={{ width: 120 }} onChange={e => V(i, "barcode", e.target.value)} aria-label={t("Barcode")} /></td><td><input type="checkbox" checked={v.active !== false} onChange={e => V(i, "active", e.target.checked)} aria-label={t("Active")} /></td>
          <td>{edit.variants.length > 1 && <button type="button" className="sm ghost" onClick={() => setEdit({ ...edit, variants: edit.variants.filter((_: any, j: number) => j !== i) })}>✕</button>}</td></tr>)}</tbody></table></div>
      <button type="button" className="sm ghost" onClick={() => setEdit({ ...edit, variants: [...edit.variants, blankV()] })}>+ {t("Add size")}</button>
      {problems(edit).length > 0 && <ul className="ferr">{problems(edit).map(p => <li key={p}>{p}</li>)}</ul>}
      <div className="row-btns"><button disabled={busy}>{busy ? t("Saving…") : t("Save product")}</button><button type="button" className="ghost" onClick={() => setEdit(null)}>{t("Cancel")}</button></div></form></>;
  }
  const shown = (items || []).filter(i => !q || `${i.code} ${i.name} ${i.category || ""} ${i.variants.map((v: any) => v.sku).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return <><h2>{t("Product form")}</h2>
    <div className="row-btns"><button onClick={() => start()}>+ {t("Add product")}</button><input placeholder={t("Search products")} value={q} onChange={e => setQ(e.target.value)} /></div>
    {items == null ? <Loading /> : !shown.length ? <Empty title={t("No products yet")} /> : shown.map(i => <div className="row" key={i.id}><b>{i.name}</b> <span className="muted">{i.code}{i.category ? ` · ${i.category}` : ""} · {t("{0} sizes", i.variants.filter((v: any) => v.active !== false).length)}{i.active === false ? ` · ${t("Inactive")}` : ""}</span>
      <div className="row-btns"><button className="sm ghost" onClick={() => start(i)}>{t("Edit")}</button></div></div>)}</>;
}
