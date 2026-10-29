import React, { useEffect, useState } from "react";
import { t } from "./i18n";
import { api, Table, type Session, type Cfg } from "./main";

type P = { s: Session; cfg: Cfg };
const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const raw = (s: Session, url: string) => fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }).then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r; });
export const openHtml = async (s: Session, url: string) => window.open(URL.createObjectURL(new Blob([await (await raw(s, url)).text()], { type: "text/html" })), "_blank");
export const download = async (s: Session, url: string, name: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(await (await raw(s, url)).blob()); a.download = name; a.click(); };

function PoDetail({ s, id, onChange }: { s: Session; id: number; onChange: () => void }) {
  const [po, setPo] = useState<any>(null); const [edit, setEdit] = useState<Record<number, any>>({}); const [msg, setMsg] = useState("");
  const load = () => api(s, `/api/pos/${id}`).then(setPo); useEffect(() => { load(); }, [id]);
  const act = async (path: string, body: any = {}) => { try { setPo(await api(s, `/api/pos/${id}/${path}`, { method: "POST", body: JSON.stringify(body) })); setMsg(""); onChange(); } catch (e: any) { setMsg(e.message); } };
  if (!po) return null;
  const mgr = s.user.role !== "distributor";
  return <div className="card sub"><h3>{po.number || t("Draft #{0}", po.id)} · {po.status}</h3><p className="muted">{po.distributor_name}{po.reject_reason ? t(" · Rejected: {0}", po.reject_reason) : ""}</p>
    <Table rows={po.lines.map((l: any) => ({ ...l, item: `${l.item_name} ${Object.values(l.attrs).join(" / ")}`, rate: inr(l.rate), total: inr(l.total) }))}
      cols={["sku", "item", "qty_requested", "qty_approved", "qty_dispatched", "qty_received", "rate", "gst_rate", "total"]} />
    <p><b>{t("Total")}{" "}{inr(po.total)}</b> <span className="muted">{t("(taxable")}{" "}{inr(po.taxable)} {t("+ GST")}{" "}{inr(po.tax)}{t(", quantities in base units)")}</span></p>
    {po.audit.map((a: any) => <div key={a.id} className="muted small">{t("Override by")}{" "}{a.user_name}: {inr(a.old_rate)} → {inr(a.new_rate)} ({a.reason})</div>)}
    {mgr && po.status === "submitted" && <>{po.lines.map((l: any) => <div className="line" key={l.id}><span>{l.sku} <span className="muted">computed {inr(l.computed_rate)}</span></span>
      <input placeholder={t("qty {0}", l.qty_requested)} value={edit[l.id]?.qty ?? ""} onChange={e => setEdit({ ...edit, [l.id]: { ...edit[l.id], qty: e.target.value } })} />
      <input placeholder={t("rate {0}", l.rate)} value={edit[l.id]?.rate ?? ""} onChange={e => setEdit({ ...edit, [l.id]: { ...edit[l.id], rate: e.target.value } })} />
      <input placeholder={t("override reason")} value={edit[l.id]?.reason ?? ""} onChange={e => setEdit({ ...edit, [l.id]: { ...edit[l.id], reason: e.target.value } })} /></div>)}
      <button onClick={() => act("approve", { lines: Object.entries(edit).map(([k, v]: any) => ({ lineId: Number(k), ...(v.qty ? { qty: Number(v.qty) } : {}), ...(v.rate ? { rate: Number(v.rate), reason: v.reason } : {}) })) })}>{t("Approve")}</button>{" "}
      <button className="ghost" onClick={() => { const r = prompt(t("Reason for rejection")); if (r) act("reject", { reason: r }); }}>{t("Reject")}</button></>}
    {mgr && ["approved", "partially_dispatched"].includes(po.status) && <button onClick={() => act("dispatch")}>{t("Dispatch all remaining")}</button>}
    {!mgr && po.status === "draft" && <button onClick={() => act("submit")}>{t("Submit PO")}</button>}
    {!mgr && po.dispatches.filter((d: any) => !d.received_at).map((d: any) => <button key={d.id} onClick={async () => {
      const f: any = await api(s, "/api/flow-settings").catch(() => ({}));
      if (!f?.grnConfirm) return act(`dispatches/${d.id}/receive`);
      const lines = []; for (const l of d.lines) { const v = prompt(t("GRN: how many did you actually receive? ({0} sent, batch {1})", l.qty, l.batch_no || "-"), String(l.qty)); if (v === null) return; lines.push({ dispatchLineId: l.id, qty: Number(v) }); }
      act(`dispatches/${d.id}/receive`, { lines }); }}>{t("Receive dispatch #")}{d.id} ({d.lines.map((l: any) => `${l.qty}${l.batch_no ? ` ${l.batch_no}` : ""}`).join(", ")})</button>)}
    {" "}<button className="sm ghost" onClick={() => openHtml(s, `/api/pos/${id}/print`)}>{t("Print")}</button> <button className="sm ghost" onClick={() => download(s, `/api/pos/${id}/export`, `${po.number || "draft"}.csv`)}>{t("CSV")}</button>
    <p className="err">{msg}</p></div>;
}

export function PurchaseOrders({ s }: P) {
  const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState<number | null>(null); const [prices, setPrices] = useState<any[]>([]); const [qty, setQty] = useState<Record<string, string>>({}); const [msg, setMsg] = useState("");
  const dist = s.user.role === "distributor";
  const load = () => api(s, "/api/pos").then(setRows); useEffect(() => { load(); if (dist) api(s, "/api/po-price").then(setPrices); }, []);
  const create = async () => { try { const po = await api(s, "/api/pos", { method: "POST", body: JSON.stringify({ lines: Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([sku, q]) => ({ sku, qty: Number(q) })) }) }); setQty({}); setOpen(po.id); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("Purchase orders")}</h2>
    <Table rows={rows.map(r => ({ ...r, number: r.number || `Draft #${r.id}`, total: inr(r.total) }))} cols={["number", "distributor_name", "status", "total"]} />
    {rows.map(r => <button key={r.id} className="sm ghost" onClick={() => setOpen(r.id)}>{t("Open")}{" "}{r.number || t("draft #{0}", r.id)}</button>)}
    {open && <PoDetail s={s} id={open} onChange={load} />}
    {dist && <div className="card sub"><h3>{t("New PO")}</h3>{prices.map(p => <div className="line" key={p.sku}><span>{p.name} {Object.values(p.attrs).join(" / ")} <span className="muted">{inr(p.rate)} + {p.gst}{t("% GST")}</span></span>
      <input inputMode="numeric" placeholder="0" value={qty[p.sku] || ""} onChange={e => setQty({ ...qty, [p.sku]: e.target.value.replace(/\D/g, "") })} /></div>)}
      <button onClick={create}>{t("Save draft")}</button><p className="err">{msg}</p></div>}</>;
}

export function DistributorTerms({ s, cfg }: P) {
  const [ds, setDs] = useState<any[]>([]); const [sel, setSel] = useState<number | null>(s.user.role === "distributor" ? s.user.id : null); const [p, setP] = useState<any>({}); const [msg, setMsg] = useState("");
  const dist = s.user.role === "distributor";
  useEffect(() => { if (!dist) api(s, "/api/distributors").then(setDs); }, []);
  useEffect(() => { if (sel) api(s, `/api/distributors/${sel}/profile`).then(setP); }, [sel]);
  const f = (k: string, l: string, show = true) => show && <label className="fld" key={k}><span>{l}</span><input value={p[k] ?? ""} onChange={e => setP({ ...p, [k]: e.target.value })} /></label>;
  return <><h2>{dist ? t("My GST & billing profile") : t("Distributor terms")}</h2>
    {!dist && <select value={sel ?? ""} onChange={e => setSel(Number(e.target.value) || null)}><option value="">{t("Select distributor…")}</option>{ds.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
    {sel && <>{!dist && <>{f("margin_pct", `Margin % (blank = company default ${cfg.settings.po?.marginPct ?? 0}%)`)}{f("discount_pct", t("Distributor discount %"))}{f("credit_days", t("Credit days for outlets"))}{f("credit_limit", t("Credit limit per outlet (₹)"))}</>}
      {f("legal_name", t("Legal name"))}{f("gstin", "GSTIN")}{f("state_code", t("State code"))}{f("address", t("Address"))}{f("city", t("City"))}{f("pincode", "PIN code")}
      {f("invoice_prefix", t("Invoice prefix (own numbering)"))}{f("credit_prefix", t("Credit note prefix"))}{f("number_format", t("Number format, e.g. {prefix}/{fy}/{seq:4}"))}
      <button onClick={async () => { try { setP(await api(s, `/api/distributors/${sel}/profile`, { method: "PUT", body: JSON.stringify(p) })); setMsg(t("Saved")); } catch (e: any) { setMsg(e.message); } }}>{t("Save")}</button><p>{msg}</p></>}</>;
}

export function PoSettings({ po, onChange }: { po: any; onChange: (v: any) => void }) {
  return <><h3>{t("Purchase order pricing")}</h3>
    <label className="fld"><span>{t("Price base")}</span><select value={po.priceBase} onChange={e => onChange({ ...po, priceBase: e.target.value })}><option value="billing">{t("Billing price")}</option><option value="mrp">{t("MRP")}</option></select></label>
    <label className="fld"><span>{t("Default distributor margin %")}</span><input value={po.marginPct} onChange={e => onChange({ ...po, marginPct: e.target.value })} /></label>
    <label className="fld"><span>{t("Product / category discounts — one per line: item:CODE=5 or category:Name=3")}</span>
      <textarea rows={3} value={typeof po.productDiscounts === "string" ? po.productDiscounts : (po.productDiscounts || []).map((d: any) => `${d.scope}:${d.key}=${d.pct}`).join("\n")} onChange={e => onChange({ ...po, productDiscounts: e.target.value })} /></label>
    <p className="muted small">{t("Applied in order: price base → margin (distributor override) → product/category discount → distributor discount; GST on the final rate.")}</p></>;
}
export const poForSave = (po: any) => ({ ...po, marginPct: Number(po.marginPct), productDiscounts: typeof po.productDiscounts === "string"
  ? po.productDiscounts.split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const m = l.match(/^(item|category):(.+)=([\d.]+)$/i); return m ? { scope: m[1].toLowerCase(), key: m[2].trim(), pct: Number(m[3]) } : { scope: "bad", key: l, pct: 0 }; })
  : po.productDiscounts });
