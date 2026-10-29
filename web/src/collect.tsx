// Step 5d: collections — outstanding per outlet/issuer, collect payment (FIFO or chosen invoices), receipts, cheque bounce, credit terms.
import { useEffect, useState } from "react";
import { api, Table, type Session } from "./main";
import { openHtml } from "./po";
import { t } from "./i18n";
import { Empty, fmtDate } from "./ui";

const money = (n: number) => `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Collections({ s }: { s: Session }) {
  const role = s.user.role, canBounce = role !== "sales_rep";
  const [rows, setRows] = useState<any[]>([]); const [pays, setPays] = useState<any[]>([]); const [sel, setSel] = useState<any>(null); const [msg, setMsg] = useState("");
  const blank = { amount: "", mode: "cash", reference: "", chequeDate: "", fifo: true, pick: {} as Record<number, string> };
  const [f, setF] = useState(blank);
  const load = () => { api(s, "/api/outstanding").then(setRows).catch(e => setMsg(e.message)); api(s, "/api/payments").then(setPays).catch(() => {}); };
  useEffect(load, []);
  const collect = async (e: any) => {
    e.preventDefault();
    try {
      const allocations = f.fifo ? undefined : Object.entries(f.pick).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ invoiceId: Number(k), amount: Number(v) }));
      const p = await api(s, "/api/payments", { method: "POST", body: JSON.stringify({ shopId: sel.shop_id, issuer: sel.issuer, amount: Number(f.amount), mode: f.mode, reference: f.reference || undefined, chequeDate: f.chequeDate || undefined, allocations }) });
      setMsg(t("Receipt {0} for {1} saved", p.number, money(p.amount))); setF(blank); setSel(null); load(); openHtml(s, `/api/payments/${p.id}/print`);
    } catch (x: any) { setMsg(x.message); }
  };
  const bounce = async (p: any) => { const reason = prompt(t("Bounce reason for {0}?", p.number)); if (!reason) return;
    try { await api(s, `/api/payments/${p.id}/bounce`, { method: "POST", body: JSON.stringify({ reason }) }); load(); } catch (x: any) { setMsg(x.message); } };
  return <><h2>{t("Collections")}</h2><p className="muted">{t("What each outlet owes, and payments received.")}</p>
    {rows.length === 0 && <Empty icon="🎉" title={t("Nothing to collect")} text={t("No outlet owes money right now. Unpaid invoices will show here.")} />}
    {rows.map(r => <div className="row" key={`${r.shop_id}|${r.issuer}`}>
      <b>{r.outlet}</b> <span className="muted">{t("billed by")}{" "}{r.issuer_name}</span>
      <div>{t("Outstanding")}{" "}<b>{money(r.outstanding)}</b>{r.overdue > 0 && <span className="pill rejected"> overdue {money(r.overdue)}</span>}{r.advance > 0 && <span className="muted"> {t("· advance")}{" "}{money(r.advance)}</span>}
        {(r.terms.days > 0 || r.terms.limit > 0) && <span className="muted small"> {t("· terms")}{" "}{r.terms.days || "–"} {t("days / limit")}{" "}{r.terms.limit ? money(r.terms.limit) : "–"}</span>}</div>
      {r.invoices.map((i: any) => <div className="muted small" key={i.id}>{i.number} · {fmtDate(i.doc_date)} · {i.age} {t("days old ·")}{" "}{money(i.outstanding)} of {money(i.total)}</div>)}
      <button className="sm" onClick={() => { setSel(r); setF(blank); }}>{t("Collect")}</button>
      {sel === r && <form onSubmit={collect}>
        <input inputMode="decimal" placeholder={t("Amount ₹")} value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} />
        <select value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}><option value="cash">{t("Cash")}</option><option value="upi">{t("UPI")}</option><option value="cheque">{t("Cheque")}</option><option value="neft">{t("NEFT")}</option></select>
        {f.mode !== "cash" && <input placeholder={f.mode === "cheque" ? t("Cheque no.") : t("UTR / reference")} value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} />}
        {f.mode === "cheque" && <label className="small">{t("Cheque date")}{" "}<input type="date" value={f.chequeDate} onChange={e => setF({ ...f, chequeDate: e.target.value })} /></label>}
        <label className="chk"><input type="checkbox" checked={f.fifo} onChange={e => setF({ ...f, fifo: e.target.checked })} />{t("Clear the oldest bills first")}</label>
        {!f.fifo && r.invoices.map((i: any) => <label className="fld" key={i.id}><span>{i.number} ({money(i.outstanding)})</span>
          <input inputMode="decimal" value={f.pick[i.id] || ""} onChange={e => setF({ ...f, pick: { ...f.pick, [i.id]: e.target.value } })} /></label>)}
        <button>{t("Save & print receipt")}</button></form>}
    </div>)}
    <h3>{t("Receipts")}</h3>
    <Table rows={pays.map(p => ({ ...p, amount: money(p.amount) }))} cols={["number", "pay_date", "shop_name", "mode", "reference", "amount", "status"]} />
    {pays.map(p => <span key={p.id}><button className="sm ghost" onClick={() => openHtml(s, `/api/payments/${p.id}/print`)}>{t("Print")}{" "}{p.number}</button>
      {canBounce && p.mode === "cheque" && p.status === "cleared" && <button className="sm ghost" onClick={() => bounce(p)}>{t("Bounce")}{" "}{p.number}</button>} </span>)}
    <p>{msg}</p></>;
}

export function CreditSettings({ c, onChange }: { c: any; onChange: (v: any) => void }) {
  return <><h3>{t("Outlet credit")}</h3><p className="muted small">{t("0 = not enforced. Outlet-level terms (Shops) override these.")}</p>
    <label className="fld"><span>{t("Credit days")}</span><input value={c.days} onChange={e => onChange({ ...c, days: e.target.value })} /></label>
    <label className="fld"><span>{t("Credit limit ₹")}</span><input value={c.limit} onChange={e => onChange({ ...c, limit: e.target.value })} /></label>
    <label className="fld"><span>{t("When breached")}</span><select value={c.onBreach} onChange={e => onChange({ ...c, onBreach: e.target.value })}><option value="warn">{t("Warn but allow the order")}</option><option value="block">{t("Block new orders")}</option></select></label></>;
}
