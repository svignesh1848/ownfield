import React, { useEffect, useState } from "react";
import { api, Table, type Session, type Cfg } from "./main";
import { download } from "./po";
import { t } from "./i18n";
import { Term, Empty, fmtDate } from "./ui";
import { gstinError, gstinInfo, GST_STATES } from "./gstin";

type P = { s: Session; cfg: Cfg };
const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const authed = (s: Session, url: string) => fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r; });
export const openPrint = async (s: Session, id: number) => {
  const html = await (await authed(s, `/api/invoices/${id}/print`)).text();
  window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
};
const month0 = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);

export function Invoices({ s, cfg }: P) {
  const einv = !!cfg?.settings.features.eInvoice;
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); setMsg(ok); load(); } catch (e: any) { setMsg(e.message); } };
  const [rows, setRows] = useState<any[]>([]); const [cn, setCn] = useState<any>(null); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/invoices").then(setRows); useEffect(() => { load(); }, []);
  const startCn = async (id: number) => { const inv = await api(s, `/api/invoices/${id}`); setCn({ inv, qty: {}, reason: "", restock: true }); };
  return <><h2>{t("Invoices & credit notes")}</h2>
    <Table rows={rows.map(r => ({ ...r, type: r.kind === "invoice" ? t("Invoice") : t("Credit note"), tax_type: r.intra_state ? "CGST+SGST" : "IGST", taxable: inr(r.taxable), tax: inr(r.tax), total: inr(r.total) }))}
      cols={["number", "type", "doc_date", ...(s.user.role !== "distributor" ? ["seller"] : []), "shop_name", "tax_type", "taxable", "tax", "total"]} />
    {rows.map(r => <span key={r.id} className="chips"><button className="sm ghost" onClick={() => openPrint(s, r.id).catch(e => setMsg(e.message))}>{t("Print")}{" "}{r.number}</button>
      {r.kind === "invoice" && <button className="sm ghost" onClick={() => startCn(r.id)}>{t("Return / credit note")}</button>}
      {einv && <>{!r.irn && <button className="sm" onClick={() => act(() => api(s, `/api/invoices/${r.id}/einvoice`, { method: "POST" }), `E-invoice registered for ${r.number}`)}>{t("Register e-invoice")}</button>}
        <button className="sm ghost" onClick={() => download(s, `/api/invoices/${r.id}/einvoice/json`, `${r.number.replace(/\W+/g, "-")}-einvoice.json`).catch(e => setMsg(e.message))}>{t("Download e-invoice file")}</button>
        {r.irn && <span className={`pill ${r.einv_status === "cancelled" ? "rejected" : "accepted"}`}><Term k="IRN">{t("e-invoice")}</Term> {r.einv_status === "cancelled" ? "cancelled" : "registered"}{r.einv_provider === "TEST" ? t(" (TEST)") : ""}</span>}
        {r.einv_status === "generated" && <button className="sm ghost" onClick={() => { const remark = prompt(t("Why cancel this e-invoice? (allowed only within 24 hours)")); if (remark) act(() => api(s, `/api/invoices/${r.id}/einvoice/cancel`, { method: "POST", body: JSON.stringify({ reason: "2", remark }) }), "E-invoice cancelled"); }}>{t("Cancel e-invoice")}</button>}</>}</span>)}
    {cn && <div className="card sub"><h3>{t("Credit note against")}{" "}{cn.inv.number}</h3>
      {cn.inv.lines.map((l: any) => <div className="line" key={l.id}><span>{l.description} <span className="muted">invoiced {l.base_qty} {l.uom === "" ? "" : t("(base units)")}</span></span>
        <input inputMode="numeric" placeholder="0" value={cn.qty[l.id] || ""} onChange={e => setCn({ ...cn, qty: { ...cn.qty, [l.id]: e.target.value.replace(/\D/g, "") } })} /></div>)}
      <input placeholder={t("Reason (e.g. damaged, expired, wrong item)")} value={cn.reason} onChange={e => setCn({ ...cn, reason: e.target.value })} />
      <label className="chk"><input type="checkbox" checked={cn.restock} onChange={e => setCn({ ...cn, restock: e.target.checked })} />{t("Put returned goods back into stock (same batches)")}</label>
      <button onClick={async () => { try { const r = await api(s, `/api/invoices/${cn.inv.id}/credit-note`, { method: "POST", body: JSON.stringify({ reason: cn.reason, restock: cn.restock, lines: Object.entries(cn.qty).map(([k, v]) => ({ invoiceLineId: Number(k), qty: Number(v) })) }) }); setMsg(t("Credit note {0} created ({1})", r.number, inr(r.total))); setCn(null); load(); } catch (e: any) { setMsg(e.message); } }}>{t("Create credit note")}</button>{" "}
      <button className="ghost" onClick={() => setCn(null)}>{t("Cancel")}</button></div>}
    <p>{msg}</p></>;
}

export function Targets({ s }: P) {
  const [month, setMonth] = useState(month0()); const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const mgr = s.user.role !== "sales_rep";
  const load = () => api(s, `/api/targets?month=${month}`).then(setRows).catch(e => setMsg(e.message)); useEffect(() => { load(); }, [month]);
  const set = async (repId: number, metric: string, cur: number | null) => { const v = prompt(t("Target for {0} ({1})", metric, month), cur == null ? "" : String(cur)); if (!v) return;
    try { await api(s, "/api/targets", { method: "PUT", body: JSON.stringify({ repId, month, metric, target: Number(v) }) }); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{mgr ? t("Targets vs achievement") : t("My targets")}</h2><input type="month" value={month} onChange={e => setMonth(e.target.value)} />
    {rows.map(r => <div className="row" key={r.repId}><b>{r.rep}</b>{r.metrics.map((m: any) => <div key={m.metric} className="tgt">
      <span>{m.metric}</span><span>{m.metric === "value" ? inr(m.actual) : m.actual} / {m.target == null ? "—" : m.metric === "value" ? inr(m.target) : m.target}</span>
      <div className="bar"><span style={{ width: `${Math.min(100, m.pct ?? 0)}%`, background: (m.pct ?? 0) >= 100 ? "#16a34a" : undefined }} /></div><span>{m.pct == null ? "" : `${m.pct}%`}</span>
      {mgr && <button className="sm ghost" onClick={() => set(r.repId, m.metric, m.target)}>{t("Set")}</button>}</div>)}</div>)}
    {mgr && <p className="muted small">{t("Bulk: Import → Targets (Rep Email, Month YYYY-MM, Metric value/orders/visits, Target).")}</p>}<p className="err">{msg}</p></>;
}

export function Reports({ s, cfg }: P) {
  const td = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const [from, setFrom] = useState(`${td.slice(0, 8)}01`); const [to, setTo] = useState(td); const [msg, setMsg] = useState("");
  const kinds = [["orders", t("Orders (line level)")], ["visits", t("Visits")], ...(cfg.settings.features.invoicing ? [["gst", "GST register (invoices + credit notes)"]] : []), ...(cfg.settings.features.invoicing ? [["ageing", t("Outstanding ageing (0-30/31-60/61-90/90+)")]] : []), ...(cfg.settings.features.schemes ? [["schemes", t("Scheme cost (discounts + free goods)")]] : []),
    ...(cfg.settings.features.stock ? [["stock", t("Stock (current)")]] : []), ["targets", t("Targets vs achievement (month of 'to')")]];
  const dl = async (k: string, fmt: string) => { try { const r = await authed(s, `/api/reports/${k}?from=${from}&to=${to}&format=${fmt}`); const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob()); a.download = `${k}-${from}-to-${to}.${fmt}`; a.click(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("Reports")}</h2><div className="dates"><label>{t("From")}<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{t("To")}<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>
    {kinds.map(([k, l]) => <div className="row line" key={k}><span>{t(l)}</span><span><button className="sm" onClick={() => dl(k, "xlsx")}>{t("Excel")}</button> <button className="sm ghost" onClick={() => dl(k, "csv")}>{t("CSV")}</button></span></div>)}<p className="err">{msg}</p></>;
}

function Photo({ s, id }: { s: Session; id: number }) {
  const [src, setSrc] = useState(""); useEffect(() => { authed(s, `/api/photos/${id}`).then(r => r.blob()).then(b => setSrc(URL.createObjectURL(b))).catch(() => {}); }, [id]);
  return src ? <a href={src} target="_blank"><img className="thumb" src={src} /></a> : <span className="thumb" />;
}
export function VisitPhotos({ s, visitId, canAdd }: { s: Session; visitId: number; canAdd?: boolean }) {
  const [list, setList] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, `/api/visits/${visitId}/photos`).then(setList); useEffect(() => { load(); }, [visitId]);
  const add = async (file: File) => {
    try { setMsg(t("Uploading…")); const fd = new FormData(); fd.append("photo", await shrink(file), "photo.jpg"); await api(s, `/api/visits/${visitId}/photos`, { method: "POST", body: fd }); setMsg(""); load(); }
    catch (e: any) { setMsg(e.message); } };
  return <div className="photos">{list.map(p => <Photo key={p.id} s={s} id={p.id} />)}
    {canAdd && <label className="addphoto">📷<input type="file" accept="image/*" capture="environment" onChange={e => e.target.files?.[0] && add(e.target.files[0])} /></label>}<span className="muted small">{msg}</span></div>;
}
/** Downscale to max 1280px JPEG before upload to save mobile data. */
async function shrink(file: File): Promise<Blob> {
  try {
    const img = await createImageBitmap(file); const k = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("encode failed")), "image/jpeg", 0.8));
  } catch { return file; }
}

export function Visits({ s, cfg }: P) {
  const [rows, setRows] = useState<any[]>([]); useEffect(() => { api(s, "/api/visits").then(r => setRows(r.slice(0, 50))); }, []);
  const defs = cfg.settings.customFields.visit;
  return <><h2>{t("Recent visits")}</h2>{!rows.length && <Empty icon="📍" title={t("No visits yet")} text={t("Visits appear here when reps check in at outlets.")} />}
    {rows.map(v => <div className="row" key={v.id}><b>{v.shop_name}</b> <span className="muted">{v.rep_name} · {fmtDate(v.check_in_at, true)}{v.check_out_at ? ` → ${new Date(v.check_out_at).toLocaleTimeString()}` : t(" (open)")}</span>
      <div className="muted small">{defs.filter(d => v.custom?.[d.key] != null).map(d => `${d.label}: ${v.custom[d.key]}`).join(" · ")}</div>
      {cfg.settings.features.photos && <VisitPhotos s={s} visitId={v.id} />}</div>)}</>;
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const readImg = (file: File | undefined, cb: (d: string) => void) => {
  if (!file) return; if (file.size > 150_000) { alert(t("Image too large (max 150 KB)")); return; }
  const r = new FileReader(); r.onload = () => cb(String(r.result)); r.readAsDataURL(file);
};
/** GSTIN input with live format/check-digit validation and auto-filled state. */
export function GstinInput({ value, onChange }: { value: string; onChange: (v: string, info?: { stateCode: string; state: string; pan: string }) => void }) {
  const v = String(value || "").toUpperCase(), err = v.length === 15 ? gstinError(v) : "";
  return <label className="fld"><span>GSTIN</span><input value={v} maxLength={15} placeholder="27AAPFU0939F1ZV" autoCapitalize="characters"
    onChange={e => { const n = e.target.value.toUpperCase().replace(/\s/g, ""); onChange(n, n.length === 15 && !gstinError(n) ? gstinInfo(n) : undefined); }} />
    {v.length === 15 && (err ? <small className="err">{err}</small> : <small className="ok">✓ {GST_STATES[v.slice(0, 2)]} · PAN {v.slice(2, 12)}</small>)}{v.length > 0 && v.length < 15 && <small className="muted">{v.length}/15</small>}</label>;
}
export function GstSettings({ g, onChange }: { g: any; onChange: (g: any) => void }) {
  const set = (o: any) => onChange({ ...g, ...o });
  const f = (k: string, l: string, ph = "", type = "text") => <label className="fld" key={k}><span>{l}</span><input type={type} placeholder={ph} value={g[k] ?? ""} onChange={e => set({ [k]: e.target.value })} /></label>;
  const ck = (k: string, l: string) => <label className="chk" key={k}><input type="checkbox" checked={!!g[k]} onChange={e => set({ [k]: e.target.checked })} />{l}</label>;
  const img = (k: string, l: string) => <div className="fld" key={k}><span>{l}</span>{g[k] && <img src={g[k]} alt="" className="thumb" />}
    <input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => readImg(e.target.files?.[0], d => set({ [k]: d }))} />{g[k] && <button type="button" className="sm ghost" onClick={() => set({ [k]: "" })}>{t("Remove")}</button>}</div>;
  const sec = (title: string, open: boolean, body: React.ReactNode) => <details className="sec" open={open}><summary>{title}</summary>{body}</details>;
  const br: any[] = g.branches || [], setBr = (i: number, o: any) => set({ branches: br.map((b, j) => j === i ? { ...b, ...o } : b) });
  return <><h3>{t("Company details & GST")}</h3>
    {sec(t("Business identity"), !g.gstin, <>
      {f("legalName", t("Legal name"))}{f("tradeName", t("Trade name"))}
      <label className="fld"><span>{t("GST registration type")}</span><select value={g.regType || "regular"} onChange={e => set({ regType: e.target.value })}>
        <option value="regular">{t("Regular")}</option><option value="composition">{t("Composition")}</option><option value="sez">{t("SEZ")}</option><option value="unregistered">{t("Unregistered")}</option></select></label>
      <GstinInput value={g.gstin} onChange={(v, i) => set(i ? { gstin: v, stateCode: i.stateCode, stateName: i.state, pan: i.pan } : { gstin: v })} />
      {f("pan", "PAN", "ABCDE1234F")}{f("tan", "TAN", "ABCD12345E")}{f("cin", "CIN / LLPIN", "U12345TN2020PTC123456")}
      {f("udyam", "Udyam / MSME no.", "UDYAM-TN-01-0001234")}
    </>)}
    {sec(t("Address & contact"), false, <>
      {f("address", t("Address"))}{f("city", t("City"))}{f("pincode", t("PIN code"), "600001")}
      <label className="fld"><span>{t("State")}</span><select value={g.stateCode || ""} onChange={e => set({ stateCode: e.target.value, stateName: GST_STATES[e.target.value] || "" })}><option value="">—</option>
        {Object.entries(GST_STATES).map(([c, n]) => <option key={c} value={c}>{c} – {n}</option>)}</select></label>
      {f("email", t("Email"), "", "email")}{f("phone", t("Phone"), "", "tel")}{f("website", t("Website"))}</>)}
    {sec(t("Branches"), false, <>
      {br.map((b, i) => <div key={i} className="card">{(["name", "address", "city", "pincode"] as const).map(k => <label key={k} className="fld"><span>{({ name: t("Branch name"), address: t("Address"), city: t("City"), pincode: t("PIN code") })[k]}</span><input value={b[k] || ""} onChange={e => setBr(i, { [k]: e.target.value })} /></label>)}
        <GstinInput value={b.gstin || ""} onChange={(v, x) => setBr(i, x ? { gstin: v, stateCode: x.stateCode } : { gstin: v })} />
        <button type="button" className="sm ghost" onClick={() => set({ branches: br.filter((_, j) => j !== i) })}>{t("Remove")}</button></div>)}
      <button type="button" className="sm ghost" onClick={() => set({ branches: [...br, { name: "" }] })}>+ {t("Add branch")}</button></>)}
    {sec(t("Bank & UPI (printed on invoices)"), false, <>
      {f("bankName", t("Bank name"))}{f("bankAccount", t("Account number"))}{f("bankIfsc", "IFSC", "HDFC0001234")}{f("bankBranch", t("Branch"))}{f("upiId", "UPI ID", "name@bank")}</>)}
    {sec(t("Logo & signatory"), false, <>
      {img("logo", t("Logo"))}{f("signatoryName", t("Signatory name"))}{f("signatoryDesignation", t("Designation"))}{img("signature", t("Signature"))}</>)}
    {sec(t("Invoice numbering & tax"), false, <>
      {f("invoicePrefix", t("Invoice prefix"))}{f("creditPrefix", t("Credit note prefix"))}{f("numberFormat", t("Number format — {prefix} {fy} {seq:4}; max 16 chars, restarts every April"))}
      <label className="fld"><span>{t("Financial year starts in (month)")}</span><select value={g.fyStartMonth || 4} onChange={e => set({ fyStartMonth: Number(e.target.value) })}>{MONTHS.map(i => <option key={i} value={i}>{new Date(2000, i - 1, 1).toLocaleString(document.documentElement.lang || "en", { month: "long" })}</option>)}</select></label>
      {f("defaultRate", t("Default GST %"))}{f("defaultHsn", t("Default HSN/SAC"), "e.g. 3004")}
      <label className="fld"><span>{t("GST % by HSN/SAC prefix (longest match wins), e.g. 6109=5, 3004=12")}</span><input value={typeof g.hsnRates === "string" ? g.hsnRates : (g.hsnRates || []).map((h: any) => `${h.prefix}=${h.rate}`).join(", ")} onChange={e => set({ hsnRates: e.target.value })} /></label>
      {ck("tcsApplicable", t("TCS applicable"))}{ck("tdsApplicable", t("TDS applicable"))}
      <p className="muted small">{t("Sample rates only — verify the GST rate for each HSN/SAC code with your tax advisor.")}</p></>)}
    {sec(t("E-invoice & e-way bill"), false, <>
      {ck("einvoiceApplicable", t("E-invoicing applicable"))}
      {g.einvoiceApplicable && <>{f("irpUsername", t("IRP / GSP username"))}{f("irpGspId", t("GSP client ID"))}<p className="muted small">{t("Do not enter passwords here — set them on the server.")}</p></>}
      {ck("ewayBill", t("E-way bill applicable"))}{g.ewayBill && f("ewayThreshold", t("E-way bill limit (₹)"), "50000")}</>)}
    {sec(t("Exports, terms & declaration"), false, <>
      {f("lutNo", t("LUT / bond no."))}{f("lutValidTill", t("LUT valid till"), "", "date")}
      <label className="fld"><span>{t("Invoice terms")}</span><textarea rows={3} value={g.terms || ""} onChange={e => set({ terms: e.target.value })} /></label>
      <label className="fld"><span>{t("Declaration")}</span><textarea rows={2} value={g.declaration || ""} onChange={e => set({ declaration: e.target.value })} /></label></>)}</>;
}
