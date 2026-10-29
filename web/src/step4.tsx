import React, { useEffect, useState } from "react";
import { api, Table, type Session, type Cfg } from "./main";
import { download } from "./po";
import { t } from "./i18n";
import { Term, Empty, fmtDate } from "./ui";

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

export function GstSettings({ g, onChange }: { g: any; onChange: (g: any) => void }) {
  const f = (k: string, l: string, ph = "") => <label className="fld" key={k}><span>{l}</span><input placeholder={ph} value={g[k] ?? ""} onChange={e => onChange({ ...g, [k]: e.target.value })} /></label>;
  return <><h3>{t("GST invoicing")}</h3>
    {f("legalName", t("Legal name (supplier)"))}{f("gstin", "GSTIN", "15 characters")}{f("stateCode", t("State code"), "e.g. 33")}{f("address", t("Address"))}{f("city", t("City"))}{f("pincode", "PIN code")}
    {f("defaultRate", t("Default GST %"))}
    <label className="fld"><span>{t("GST % by HSN/SAC prefix (longest match wins), e.g. 6109=5, 3004=12")}</span><input value={typeof g.hsnRates === "string" ? g.hsnRates : (g.hsnRates || []).map((h: any) => `${h.prefix}=${h.rate}`).join(", ")} onChange={e => onChange({ ...g, hsnRates: e.target.value })} /></label>
    {f("invoicePrefix", t("Invoice prefix"))}{f("creditPrefix", t("Credit note prefix"))}{f("numberFormat", t("Number format — {prefix} {fy} {seq:4}; max 16 chars, restarts every April"))}
    <p className="muted small">{t("Sample rates only — verify the GST rate for each HSN/SAC code with your tax advisor.")}</p></>;
}
