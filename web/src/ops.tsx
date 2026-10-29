// Field operations screens: van sales, distributor inventory, claims, leads, coverage, surveys, messaging, location trail.
import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps, type Session } from "./main";
import { t } from "./i18n";
import { Field, toast, Loading, inr0, today } from "./ui";

export const run = async <T,>(fn: () => Promise<T>) => { try { return await fn(); } catch (e: any) { toast(e.message, "err"); return null; } };
export const ref = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
export function useData<T = any>(s: Session, url: string | null, deps: any[] = []) {
  const [d, setD] = useState<T | null>(null);
  const load = () => { if (url) api(s, url).then(setD).catch(e => toast(e.message, "err")); };
  useEffect(load, [url, ...deps]); return [d, load, setD] as const;
}

/** Product + qty rows with a product pick list and (when on) a barcode scan button. */
export function Lines({ s, lines, setLines, scan }: { s: Session; lines: { sku: string; qty: number }[]; setLines: (l: any[]) => void; scan?: boolean }) {
  const [prods] = useData<any[]>(s, "/api/products");
  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const addSku = (code: string) => {
    const p = prods?.find(x => x.barcode === code || x.sku === code); if (!p) return toast(t("No product for {0}", code), "err");
    const i = lines.findIndex(l => l.sku === p.sku);
    setLines(i >= 0 ? lines.map((l, j) => j === i ? { ...l, qty: Number(l.qty) + 1 } : l) : [...lines.filter(l => l.sku), { sku: p.sku, qty: 1 }]);
  };
  return <div>
    <datalist id="skus">{prods?.map(p => <option key={p.id} value={p.sku}>{p.item_name} {Object.values(p.attrs || {}).join(" ")}</option>)}</datalist>
    {lines.map((l, i) => <div key={i} className="row-btns">
      <input list="skus" placeholder={t("Product code")} value={l.sku} onChange={e => set(i, "sku", e.target.value)} />
      <input type="number" min={0} style={{ width: 80 }} value={l.qty} onChange={e => set(i, "qty", Number(e.target.value))} />
      <button type="button" className="sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></div>)}
    <div className="row-btns"><button type="button" className="sm ghost" onClick={() => setLines([...lines, { sku: "", qty: 1 }])}>{t("+ Product")}</button>
      {scan && <ScanButton onCode={addSku} />}</div>
  </div>;
}

/** Camera barcode/QR scanning with the browser's BarcodeDetector; falls back to typing the code. */
export function ScanButton({ onCode, label = t("📷 Scan") }: { onCode: (c: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>{<button type="button" className="sm" onClick={() => setOpen(true)}>{label}</button>}{open && <Scanner onCode={c => { setOpen(false); onCode(c); }} onClose={() => setOpen(false)} />}</>;
}
export function Scanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const vid = React.useRef<HTMLVideoElement>(null); const [msg, setMsg] = useState(t("Point the camera at a barcode or QR code")); const [typed, setTyped] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false;
    const BD = (window as any).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) { setMsg(t("This phone's browser can't scan. Type the code instead.")); return; }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = vid.current!; v.srcObject = stream; await v.play();
        const det = new BD({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code", "itf"] });
        while (!stop) { const r = await det.detect(v).catch(() => []); if (r[0]?.rawValue) { onCode(r[0].rawValue); break; } await new Promise(ok => setTimeout(ok, 250)); }
      } catch { setMsg(t("Camera not available. Type the code instead.")); }
    })();
    return () => { stop = true; stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  return <div className="card scanner"><p className="muted">{msg}</p><video ref={vid} playsInline muted style={{ width: "100%", maxHeight: 260, background: "#000" }} />
    <form className="row-btns" onSubmit={e => { e.preventDefault(); if (typed.trim()) onCode(typed.trim()); }}><input placeholder={t("or type the code")} value={typed} onChange={e => setTyped(e.target.value)} /><button className="sm">{t("Use")}</button>
      <button type="button" className="sm ghost" onClick={onClose}>{t("Close")}</button></form></div>;
}

// ---------- Van sales ----------
export function VanRep({ s, cfg }: ViewProps) {
  const [van, load] = useData<any>(s, "/api/van/today");
  const [shops] = useData<any[]>(s, "/api/shops");
  const [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]), [shop, setShop] = useState(""), [counts, setCounts] = useState<Record<string, number>>({}), [last, setLast] = useState<any>(null);
  const [pay, setPay] = useState({ mode: "cash", amount: "", reference: "" }), [cash, setCash] = useState("");
  const scan = !!cfg.settings.features.barcode;
  return <><h2>{t("My van")}</h2>
    {!van ? <div className="card"><p>{t("Load your van for today.")}</p><Lines s={s} lines={lines} setLines={setLines} scan={scan} />
      <button onClick={async () => { if (await run(() => api(s, "/api/van/load", { method: "POST", body: JSON.stringify({ lines: lines.filter(l => l.sku) }) }))) { setLines([{ sku: "", qty: 1 }]); load(); } }}>{t("Load van")}</button></div>
      : <>
        <Table rows={van.lines} cols={["sku", "name", "loaded", "sold", "unloaded", "left"]} />
        <button className="sm ghost" onClick={async () => { if (confirm(t("Put everything left on the van back into stock?")) && await run(() => api(s, "/api/van/unload", { method: "POST", body: JSON.stringify({}) }))) load(); }}>{t("Unload van")}</button>
        <div className="card"><h3>{t("Sell now")}</h3>
          <Field label={t("Outlet")}><select value={shop} onChange={e => setShop(e.target.value)}><option value="">{t("Pick an outlet")}</option>{shops?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Lines s={s} lines={lines} setLines={setLines} scan={scan} />
          <Field label={t("Payment")}><select value={pay.mode} onChange={e => setPay({ ...pay, mode: e.target.value })}><option value="cash">{t("Cash")}</option><option value="upi">{t("UPI")}</option>{cfg.settings.features.invoicing && <option value="credit">{t("Credit (pay later)")}</option>}</select></Field>
          {pay.mode !== "credit" && <div className="row-btns"><input type="number" min={0} placeholder={t("Amount paid (blank = full bill)")} value={pay.amount} onChange={e => setPay({ ...pay, amount: e.target.value })} />
            {pay.mode === "upi" && <input placeholder={t("UPI reference")} value={pay.reference} onChange={e => setPay({ ...pay, reference: e.target.value })} />}</div>}
          <button onClick={async () => { const r: any = await run(() => api(s, "/api/van/sale", { method: "POST", body: JSON.stringify({ clientRef: ref(), shopId: Number(shop), lines: lines.filter(l => l.sku), payment: { mode: pay.mode, amount: pay.amount === "" ? null : Number(pay.amount), reference: pay.reference || null } }) })); if (r) { setLast(r); setLines([{ sku: "", qty: 1 }]); load(); } }}>{t("Sell")}{cfg.settings.features.invoicing ? t(" and invoice") : ""}</button>
          {last?.invoice && <p>{t("Invoice")}{" "}<b>{last.invoice.number}</b> · {inr0(last.invoice.total)} · <a href="#" onClick={async e => { e.preventDefault(); const r = await fetch(`/api/invoices/${last.invoice.id}/print`, { headers: { Authorization: `Bearer ${s.token}` } }); const w = window.open(""); w?.document.write(await r.text()); }}>{t("Print")}</a></p>}</div>
        <div className="card"><h3>{t("Day end")}</h3><p className="muted">{t("Count what is left on the van. Leave blank if it matches.")}</p>
          {van.lines.map((l: any) => <Field key={l.sku} label={t("{0} (expected {1})", l.sku, l.left)}><input type="number" min={0} value={counts[l.sku] ?? ""} onChange={e => setCounts({ ...counts, [l.sku]: Number(e.target.value) })} /></Field>)}
          <p>{t("Cash {0} · UPI {1} · Credit {2}", inr0(van.settlement?.cash), inr0(van.settlement?.upi), inr0(van.settlement?.credit))}</p>
          <Field label={t("Cash in hand (₹)")} help={t("Count the cash you are handing over. Your manager signs off any difference.")}><input type="number" min={0} value={cash} onChange={e => setCash(e.target.value)} /></Field>
          <button onClick={async () => { const r: any = await run(() => api(s, "/api/van/close", { method: "POST", body: JSON.stringify({ cashCounted: cash === "" ? null : Number(cash), counts: Object.entries(counts).map(([sku, qty]) => ({ sku, qty })) }) })); if (r) { toast(t("Closed. Sales {0}", inr0(r.sales_total))); load(); } }}>{t("Close the day")}</button></div></>}</>;
}
export function VanAdmin({ s }: ViewProps) {
  const [day, setDay] = useState(today()); const [loads, reload] = useData<any[]>(s, `/api/van/loads?day=${day}`, [day]);
  const [reps] = useData<any[]>(s, "/api/reps"); const [rep, setRep] = useState(""); const [dists] = useData<any[]>(s, "/api/distributors"); const [src, setSrc] = useState("company"); const [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]);
  return <><h2>{t("Van sales")}</h2>
    <div className="card"><h3>{t("Load a van")}</h3><Field label={t("Sales rep")}><select value={rep} onChange={e => setRep(e.target.value)}><option value="">{t("Pick")}</option>{reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Field label={t("Take stock from")} help={t("Loading takes the stock out of this location; unloading puts it back.")}><select value={src} onChange={e => setSrc(e.target.value)}><option value="company">{t("Company warehouse")}</option>{dists?.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Lines s={s} lines={lines} setLines={setLines} /><button onClick={async () => { if (await run(() => api(s, "/api/van/load", { method: "POST", body: JSON.stringify({ repId: Number(rep), sourceId: src, lines: lines.filter(l => l.sku) }) }))) reload(); }}>{t("Load")}</button></div>
    <Field label={t("Day")}><input type="date" value={day} onChange={e => setDay(e.target.value)} /></Field>
    {!loads ? <Loading /> : loads.map(l => <div className="card" key={l.id}><b>{l.rep_name}</b> · {l.status} {t("· sales")}{" "}{inr0(l.sales_total)}
      <Table rows={l.lines} cols={["sku", "loaded", "sold", "unloaded", "expected", "counted", "variance"]} />
      <p>{t("Cash {0} · UPI {1} · Credit {2}", inr0(l.settlement.cash), inr0(l.settlement.upi), inr0(l.settlement.credit))}{l.settlement.cash_counted != null && <> · {t("Cash handed over {0}", inr0(l.settlement.cash_counted))} · <b className={l.settlement.cash_diff ? "err" : ""}>{t("Difference {0}", inr0(l.settlement.cash_diff))}</b></>}{l.settlement.stock_diff_units ? <> · <b className="err">{t("Stock difference {0} units", l.settlement.stock_diff_units)}</b></> : null}</p>
      {l.status === "closed" && (l.settlement.signed_off_by ? <p className="muted">✓ {t("Signed off by {0}", l.settlement.signed_off_by)}</p>
        : <button className="sm" onClick={async () => { const note = prompt(t("Note for the sign-off (optional)")) ?? ""; if (await run(() => api(s, `/api/van/loads/${l.id}/signoff`, { method: "POST", body: JSON.stringify({ note }) }))) reload(); }}>{t("Check and sign off")}</button>)}</div>)}
    {loads && !loads.length && <p className="muted">{t("No vans loaded on this day.")}</p>}</>;
}

// ---------- Distributor inventory ----------
export function Inventory({ s, cfg }: ViewProps) {
  const mgr = s.user.role !== "distributor";
  const [dists] = useData<any[]>(s, mgr ? "/api/distributors" : null);
  const [d, setD] = useState(""); const q = mgr && d ? `?distributorId=${d}` : "";
  const [inv, reload] = useData<any>(s, `/api/inventory${q}`, [d]); const [moves, reloadMoves] = useData<any[]>(s, `/api/inventory/moves${q}`, [d]);
  const [kind, setKind] = useState("in"), [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]), [batch, setBatch] = useState(""), [expiry, setExpiry] = useState(""), [note, setNote] = useState("");
  const b = cfg.settings.features.batches;
  return <><h2>{t("Inventory")}</h2>
    {mgr && <Field label={t("Location")}><select value={d} onChange={e => setD(e.target.value)}><option value="">{t("All")}</option><option value="company">{t("Company warehouse")}</option>{dists?.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
    {inv && <p className="muted">{t("Stock age:")}{" "}{Object.entries(inv.ageing).map(([k, v]) => `${k}: ${v}`).join(" · ") || t("no stock")}</p>}
    <Table rows={inv?.rows ?? null} cols={["distributor", "sku", "name", "batch_no", "expiry", "qty", "age_days"]} empty={{ title: t("No stock yet") }} />
    {(!mgr || d) && <div className="card"><h3>{t("Goods in / out")}</h3>
      <Field label={t("Type")}><select value={kind} onChange={e => setKind(e.target.value)}><option value="in">{t("Goods in (receipt / return)")}</option><option value="out">{t("Goods out (issue / damage)")}</option><option value="adjust">{t("Set counted quantity")}</option></select></Field>
      {b && <><Field label={t("Batch")}><input value={batch} onChange={e => setBatch(e.target.value)} /></Field><Field label={t("Expiry")}><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></Field></>}
      <Lines s={s} lines={lines} setLines={setLines} scan={!!cfg.settings.features.barcode} />
      <Field label={t("Note")}><input value={note} onChange={e => setNote(e.target.value)} /></Field>
      <button onClick={async () => { if (await run(() => api(s, "/api/inventory/moves", { method: "POST", body: JSON.stringify({ kind, distributorId: d || undefined, note, lines: lines.filter(l => l.sku).map(l => ({ ...l, batch_no: batch, expiry })) }) }))) { setLines([{ sku: "", qty: 1 }]); reload(); reloadMoves(); } }}>{t("Save")}</button></div>}
    <h3>{t("Movements")}</h3><Table rows={moves} cols={["created_at", "kind", "sku", "batch_no", "qty", "ref", "note"]} empty={{ title: t("No movements yet") }} /></>;
}

// ---------- Claims ----------
const openHtml = async (s: Session, url: string) => { const r = await fetch(url, { headers: { Authorization: `Bearer ${s.token}` } }); if (!r.ok) return toast(t("Could not open"), "err"); const w = window.open(""); w?.document.write(await r.text()); };
export function Claims({ s, cfg }: ViewProps) {
  const dist = s.user.role === "distributor";
  const [rows, reload] = useData<any[]>(s, "/api/claims");
  const [kind, setKind] = useState("damage"), [desc, setDesc] = useState(""), [amount, setAmount] = useState(""), [lines, setLines] = useState<any[]>([]);
  return <><h2>{t("Claims")}</h2>
    {dist && <div className="card"><h3>{t("New claim")}</h3>
      <Field label={t("Type")}><select value={kind} onChange={e => setKind(e.target.value)}><option value="damage">{t("Damaged goods")}</option><option value="expiry">{t("Expired goods")}</option><option value="scheme">{t("Scheme payout")}</option></select></Field>
      <Field label={t("What happened")}><input value={desc} onChange={e => setDesc(e.target.value)} /></Field>
      {kind !== "scheme" && <Lines s={s} lines={lines} setLines={setLines} scan={!!cfg.settings.features.barcode} />}
      <Field label={t("Amount (₹)")} help={kind !== "scheme" ? t("Leave blank to use product prices") : undefined}><input type="number" value={amount} onChange={e => setAmount(e.target.value)} /></Field>
      <button onClick={async () => { if (await run(() => api(s, "/api/claims", { method: "POST", body: JSON.stringify({ kind, description: desc, amount: amount || undefined, lines: lines.filter(l => l.sku) }) }))) { setDesc(""); setAmount(""); setLines([]); reload(); } }}>{t("Submit claim")}</button></div>}
    {!rows ? <Loading /> : !rows.length ? <p className="muted">{t("No claims yet.")}</p> : rows.map(c => <div key={c.id} className="card">
      <b>#{c.id} {c.kind}</b> · {c.distributor} · {inr0(c.amount)}{c.approved_amount != null && ` → ${inr0(c.approved_amount)}`} · <b>{c.status}</b>{c.credit_note_no && ` · ${c.credit_note_no}`}
      <div className="muted">{c.description}{c.reason && ` — ${c.reason}`}</div>
      <div className="row-btns">
        {!dist && c.status === "submitted" && <><button className="sm" onClick={async () => { const a = prompt(t("Approve amount (₹)"), String(c.amount)); if (a && await run(() => api(s, `/api/claims/${c.id}/decide`, { method: "POST", body: JSON.stringify({ approve: true, amount: Number(a) }) }))) reload(); }}>{t("Approve")}</button>
          <button className="sm ghost" onClick={async () => { const r = prompt(t("Reason for rejecting")); if (r && await run(() => api(s, `/api/claims/${c.id}/decide`, { method: "POST", body: JSON.stringify({ approve: false, reason: r }) }))) reload(); }}>{t("Reject")}</button></>}
        {!dist && c.status === "approved" && <button className="sm" onClick={async () => { if (await run(() => api(s, `/api/claims/${c.id}/settle`, { method: "POST" }))) reload(); }}>{t("Settle (credit note)")}</button>}
        {c.status === "settled" && <button className="sm ghost" onClick={() => openHtml(s, `/api/claims/${c.id}/print`)}>{t("Credit note")}</button>}</div></div>)}</>;
}

// ---------- Leads ----------
export function Leads({ s }: ViewProps) {
  const [due, setDue] = useState(false); const [rows, reload] = useData<any[]>(s, `/api/leads${due ? "?due=1" : ""}`, [due]);
  const [form, setForm] = useState<any>({ kind: "outlet" }); const [open, setOpen] = useState<any>(null); const [fu, reloadFu] = useData<any[]>(s, open ? `/api/leads/${open.id}/followups` : null, [open?.id]);
  const [note, setNote] = useState(""), [next, setNext] = useState("");
  const F = (k: string, l: string, type = "text") => <Field label={l}><input type={type} value={form[k] || ""} onChange={e => setForm({ ...form, [k]: e.target.value })} /></Field>;
  return <><h2>{t("Leads")}</h2>
    <details className="card"><summary><b>{t("+ New lead")}</b></summary>
      <Field label={t("Type")}><select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="outlet">{t("Outlet")}</option><option value="dealer">{t("Dealer / distributor")}</option></select></Field>
      {F("name", t("Business name"))}{F("owner_name", t("Owner"))}{F("phone", t("Phone"), "tel")}{F("city", t("Town / city"))}{F("next_follow_up", t("Follow up on"), "date")}{F("notes", t("Notes"))}
      <button onClick={async () => { if (await run(() => api(s, "/api/leads", { method: "POST", body: JSON.stringify(form) }))) { setForm({ kind: "outlet" }); reload(); } }}>{t("Save lead")}</button></details>
    <label className="chk"><input type="checkbox" checked={due} onChange={e => setDue(e.target.checked)} /> {t("Only follow-ups due today")}</label>
    {!rows ? <Loading /> : !rows.length ? <p className="muted">{t("No leads yet.")}</p> : rows.map(l => <div key={l.id} className="card" onClick={() => setOpen(l)}>
      <b>{l.name}</b> <span className="muted">· {l.kind} · {l.city || ""} · {l.status}{l.next_follow_up ? t(" · next {0}", l.next_follow_up) : ""}</span>
      {open?.id === l.id && <div onClick={e => e.stopPropagation()}>
        {l.phone && <p><a href={`tel:${l.phone}`}>📞 {l.phone}</a></p>}
        {fu?.map(f => <div key={f.id} className="muted small">{String(f.created_at).slice(0, 10)} {f.by_name}: {f.note}</div>)}
        {!["converted", "lost"].includes(l.status) && <><Field label={t("Follow-up note")}><input value={note} onChange={e => setNote(e.target.value)} /></Field><Field label={t("Next date")}><input type="date" value={next} onChange={e => setNext(e.target.value)} /></Field>
          <div className="row-btns"><button className="sm" onClick={async () => { if (await run(() => api(s, `/api/leads/${l.id}/followups`, { method: "POST", body: JSON.stringify({ note, next_date: next || undefined }) }))) { setNote(""); reloadFu(); reload(); } }}>{t("Add follow-up")}</button>
            <button className="sm" onClick={async () => { if (confirm(t("Make {0} an outlet?", l.name)) && await run(() => api(s, `/api/leads/${l.id}/convert`, { method: "POST", body: "{}" }))) reload(); }}>{t("Convert to outlet")}</button>
            <button className="sm ghost" onClick={async () => { const r = prompt(t("Why lost?")); if (r != null && await run(() => api(s, `/api/leads/${l.id}`, { method: "PATCH", body: JSON.stringify({ status: "lost", lost_reason: r }) }))) reload(); }}>{t("Mark lost")}</button></div></>}</div>}
    </div>)}</>;
}

// ---------- Location trail ----------
/** While the rep app is open, take a GPS fix every few minutes and send them in small batches (kept offline until sent). */
export function useTracking(s: Session, on: boolean) {
  useEffect(() => {
    if (!on || !navigator.geolocation) return;
    let every = 180_000; const KEY = "ff-pings";
    const flush = () => { const q = JSON.parse(localStorage.getItem(KEY) || "[]"); if (!q.length || !navigator.onLine) return;
      api(s, "/api/track/pings", { method: "POST", body: JSON.stringify({ points: q.slice(0, 100) }) }).then(() => localStorage.setItem(KEY, JSON.stringify(q.slice(100)))).catch(() => {}); };
    const take = () => navigator.geolocation.getCurrentPosition(p => {
      const q = JSON.parse(localStorage.getItem(KEY) || "[]"); q.push({ at: new Date().toISOString(), lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) });
      localStorage.setItem(KEY, JSON.stringify(q.slice(-300))); if (q.length >= 5) flush();
    }, () => {}, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 });
    let t: any; api(s, "/api/track/settings").then((c: any) => { every = c.intervalSec * 1000; take(); t = setInterval(() => { take(); }, every); }).catch(() => {});
    const f = setInterval(flush, 300_000); window.addEventListener("online", flush);
    return () => { clearInterval(t); clearInterval(f); window.removeEventListener("online", flush); flush(); };
  }, [on]);
}
function Plot({ pts, visits }: { pts: any[]; visits: any[] }) {
  if (pts.length < 2) return <p className="muted">{t("Not enough points for a trail.")}</p>;
  const xs = pts.map(p => p.lng), ys = pts.map(p => p.lat), [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 320, H = 240, k = Math.min(W / ((x1 - x0) || 1e-4), H / ((y1 - y0) || 1e-4)) * 0.9, X = (x: number) => 16 + (x - x0) * k, Y = (y: number) => H - 16 - (y - y0) * k;
  return <svg viewBox={`0 0 ${W + 32} ${H}`} style={{ width: "100%", maxWidth: 420, background: "#f4f6f8", borderRadius: 8 }}>
    <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={pts.map(p => `${X(p.lng)},${Y(p.lat)}`).join(" ")} />
    <circle cx={X(pts[0].lng)} cy={Y(pts[0].lat)} r="5" fill="#16a34a" /><circle cx={X(pts[pts.length - 1].lng)} cy={Y(pts[pts.length - 1].lat)} r="5" fill="#dc2626" />
    {visits.filter(v => v.in_lat != null).map((v, i) => <circle key={i} cx={X(Number(v.in_lng))} cy={Y(Number(v.in_lat))} r="4" fill="#f59e0b"><title>{v.name}</title></circle>)}</svg>;
}
export function Trail({ s }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [reps] = useData<any[]>(s, "/api/reps"); const [rep, setRep] = useState(""); const [dists] = useData<any[]>(s, "/api/distributors"); const [src, setSrc] = useState("company"); const [day, setDay] = useState(today());
  const [tr] = useData<any>(s, rep ? `/api/track?repId=${rep}&day=${day}` : null, [rep, day]);
  const [cfg, , setCfg] = useData<any>(s, "/api/track/settings"); const [shops] = useData<any[]>(s, "/api/shops"); const [shop, setShop] = useState(""), [radius, setRadius] = useState("");
  return <><h2>{t("Location trail")}</h2>
    <div className="row-btns"><select value={rep} onChange={e => setRep(e.target.value)}><option value="">{t("Pick a rep")}</option>{reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select><input type="date" value={day} onChange={e => setDay(e.target.value)} /></div>
    {tr && <div className="card"><b>{tr.distance_km} km</b> {t("travelled ·")}{" "}{tr.points.length} {t("points ·")}{" "}{tr.visits.length} visits<Plot pts={tr.points} visits={tr.visits} />
      <p className="muted small">{t("Green = first point, red = last, orange = check-ins.")}</p></div>}
    {admin && cfg && <form className="card" onSubmit={async e => { e.preventDefault(); const r = await run(() => api(s, "/api/track/settings", { method: "PUT", body: JSON.stringify(cfg) })); if (r) setCfg(r); }}>
      <h3>{t("Settings")}</h3><div className="row-btns"><Field label={t("Working hours from")}><input type="time" value={cfg.start} onChange={e => setCfg({ ...cfg, start: e.target.value })} /></Field><Field label="to"><input type="time" value={cfg.end} onChange={e => setCfg({ ...cfg, end: e.target.value })} /></Field></div>
      <Field label={t("Ping every (seconds)")}><input type="number" min={60} max={900} value={cfg.intervalSec} onChange={e => setCfg({ ...cfg, intervalSec: Number(e.target.value) })} /></Field>
      <Field label={t("Check-in radius (metres)")}><input type="number" min={25} value={cfg.radiusM} onChange={e => setCfg({ ...cfg, radiusM: Number(e.target.value) })} /></Field>
      <label className="chk"><input type="checkbox" checked={cfg.enforceRadius} onChange={e => setCfg({ ...cfg, enforceRadius: e.target.checked })} /> {t("Refuse check-ins outside the radius")}</label><button>{t("Save")}</button></form>}
    <div className="card"><h3>{t("Radius for one outlet")}</h3><select value={shop} onChange={e => setShop(e.target.value)}><option value="">{t("Pick outlet")}</option>{shops?.map(x => <option key={x.id} value={x.id}>{x.name}{x.lat ? "" : t(" (not pinned yet)")}</option>)}</select>
      <input type="number" placeholder="metres" value={radius} onChange={e => setRadius(e.target.value)} />
      <button className="sm" onClick={() => { const x = shops?.find(y => String(y.id) === shop); if (x) run(() => api(s, `/api/shops/${x.id}/geofence`, { method: "PUT", body: JSON.stringify({ lat: x.lat, lng: x.lng, radiusM: radius }) })); }}>{t("Save")}</button>
      <p className="muted small">{t("An outlet is pinned at its first check-in with GPS.")}</p></div></>;
}

// ---------- Coverage ----------
export function Coverage({ s }: ViewProps) {
  const [from, setFrom] = useState(today()), [to, setTo] = useState(today());
  const [d] = useData<any>(s, `/api/coverage?from=${from}&to=${to}`, [from, to]); const [open, setOpen] = useState<number | null>(null);
  return <><h2>{t("Coverage")}</h2>
    <div className="row-btns"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /> to <input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
    <p className="muted small">{t("Planned calls come from beat plans. Productive = an order was taken at the outlet that day.")}</p>
    <Table rows={d?.reps.map((r: any) => ({ ...r, missed: r.missed_outlets.length, productivity: r.productivity_pct == null ? "–" : `${r.productivity_pct}%`, adherence: r.beat_adherence_pct == null ? "–" : `${r.beat_adherence_pct}%`, must_sell: r.must_sell_pct == null ? "–" : `${r.must_sell_pct}%` })) ?? null}
      cols={["rep_name", "planned_calls", "total_calls", "productive_calls", "non_productive_calls", "productivity", "adherence", "unplanned_calls", "missed", "must_sell"]} empty={{ title: t("No sales reps") }} />
    {d?.reps.some((r: any) => Object.keys(r.must_sell_missing || {}).length) && <div className="card"><h3>{t("Must-sell products missed in orders")}</h3>
      <Table rows={Object.entries(d.reps.reduce((a: any, r: any) => { for (const [k, n] of Object.entries(r.must_sell_missing || {})) a[k] = (a[k] || 0) + (n as number); return a; }, {})).map(([sku, orders]) => ({ sku, orders }))} cols={["sku", "orders"]} /></div>}
    {d?.reps.some((r: any) => Object.keys(r.no_order_reasons || {}).length) && <div className="card"><h3>{t("Why no order")}</h3>
      <Table rows={Object.entries(d.reps.reduce((a: any, r: any) => { for (const [k, n] of Object.entries(r.no_order_reasons || {})) a[k] = (a[k] || 0) + (n as number); return a; }, {})).map(([reason, calls]) => ({ reason: t(reason), calls }))} cols={["reason", "calls"]} /></div>}
    {d?.reps.filter((r: any) => r.missed_outlets.length).map((r: any) => <details key={r.rep_id} open={open === r.rep_id} onToggle={() => setOpen(r.rep_id)}><summary>{t("Missed outlets —")}{" "}{r.rep_name} ({r.missed_outlets.length})</summary>
      <Table rows={r.missed_outlets} cols={["day", "shop_name"]} /></details>)}</>;
}

// ---------- Surveys (custom forms incl. competitor price) ----------
const QT: Record<string, string> = { text: t("Text"), number: t("Number"), yesno: t("Yes / No"), select: t("Choice"), price: t("Competitor price ₹") };
export function Surveys({ s }: ViewProps) {
  const admin = s.user.role === "company_admin", rep = s.user.role === "sales_rep";
  const [forms, reload] = useData<any[]>(s, `/api/surveys/forms${admin ? "?all=1" : ""}`);
  const [shops] = useData<any[]>(s, "/api/shops");
  const [resp, reloadResp] = useData<any[]>(s, "/api/surveys/responses");
  const [prices] = useData<any[]>(s, rep ? null : "/api/surveys/competitor-prices");
  const [fid, setFid] = useState<number | null>(null), [shop, setShop] = useState(""), [ans, setAns] = useState<Record<string, any>>({});
  const [draft, setDraft] = useState<any>({ name: "", questions: [{ label: "", type: "price", brand: "" }] });
  const f = forms?.find(x => x.id === fid && x.active);
  const setQ = (i: number, p: any) => setDraft({ ...draft, questions: draft.questions.map((q: any, j: number) => j === i ? { ...q, ...p } : q) });
  return <><h2>{t("Surveys")}</h2>
    {!forms ? <Loading /> : <>
      <Field label={t("Survey")}><select value={fid ?? ""} onChange={e => { setFid(e.target.value ? Number(e.target.value) : null); setAns({}); }}><option value="">{t("Pick a survey…")}</option>{forms.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      {f && <div className="card">
        <Field label={t("Outlet")}><select value={shop} onChange={e => setShop(e.target.value)}><option value="">—</option>{shops?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        {f.questions.map((q: any) => <Field key={q.key} label={q.label + (q.required ? " *" : "")}>
          {q.type === "yesno" ? <select value={ans[q.key] ?? ""} onChange={e => setAns({ ...ans, [q.key]: e.target.value })}><option value="">—</option><option value="yes">{t("Yes")}</option><option value="no">{t("No")}</option></select>
            : q.type === "select" ? <select value={ans[q.key] ?? ""} onChange={e => setAns({ ...ans, [q.key]: e.target.value })}><option value="">—</option>{q.options.map((o: string) => <option key={o}>{o}</option>)}</select>
              : <input inputMode={q.type === "text" ? undefined : "decimal"} placeholder={q.type === "price" ? t("{0} price ₹", q.brand) : ""} value={ans[q.key] ?? ""} onChange={e => setAns({ ...ans, [q.key]: e.target.value })} />}</Field>)}
        <button onClick={async () => { const r: any = await run(() => api(s, "/api/surveys/responses", { method: "POST", body: JSON.stringify({ formId: f.id, shopId: shop ? Number(shop) : undefined, answers: ans, clientRef: ref() }) }));
          if (r) { toast(r.queued ? t("Saved offline — will send when online") : t("Survey saved")); setAns({}); reloadResp(); } }}>{t("Submit")}</button></div>}
    </>}
    {prices && prices.length > 0 && <><h3>{t("Competitor prices")}</h3>{prices.map(p => <div key={p.brand + p.question} className="card small"><b>{p.brand}</b>{p.brand !== p.question && <span className="muted"> · {p.question}</span>}
      <div>{t("Avg")}{" "}<b>{inr0(p.avg)}</b> {t("· min")}{" "}{inr0(p.min)} {t("· max")}{" "}{inr0(p.max)} <span className="muted">· {p.reports} {t("reports,")}{" "}{p.outlets} outlets</span></div></div>)}</>}
    <h3>{rep ? t("My recent responses") : t("Recent responses")}</h3>
    {!resp ? <Loading /> : !resp.length ? <p className="muted">{t("No responses yet.")}</p> : resp.slice(0, 30).map(r => <div key={r.id} className="card small"><b>{r.form_name}</b> <span className="muted">· {r.shop_name || t("no outlet")} · {r.user_name} · {String(r.created_at).slice(0, 10)}</span>
      <div className="muted">{Object.entries(r.answers).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v === true ? "yes" : v === false ? "no" : v}`).join(" · ")}</div></div>)}
    {admin && <details className="card"><summary><b>{t("+ Build a survey")}</b></summary>
      <Field label={t("Survey name")}><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder={t("e.g. Competitor price check")} /></Field>
      {draft.questions.map((q: any, i: number) => <div key={i} className="row">
        <input placeholder={t("Question {0}", i + 1)} value={q.label} onChange={e => setQ(i, { label: e.target.value })} />
        <select value={q.type} onChange={e => setQ(i, { type: e.target.value })}>{Object.entries(QT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {q.type === "select" && <input placeholder={t("Choices, comma separated")} value={q.options || ""} onChange={e => setQ(i, { options: e.target.value })} />}
        {q.type === "price" && <input placeholder={t("Competitor brand")} value={q.brand || ""} onChange={e => setQ(i, { brand: e.target.value })} />}
        <label className="chk"><input type="checkbox" checked={!!q.required} onChange={e => setQ(i, { required: e.target.checked })} /> required</label></div>)}
      <div className="row-btns"><button className="sm ghost" onClick={() => setDraft({ ...draft, questions: [...draft.questions, { label: "", type: "text" }] })}>{t("+ Question")}</button>
        <button className="sm" onClick={async () => { if (await run(() => api(s, "/api/surveys/forms", { method: "POST", body: JSON.stringify(draft) }))) { setDraft({ name: "", questions: [{ label: "", type: "price", brand: "" }] }); reload(); } }}>{t("Save survey")}</button></div>
      {forms?.map(x => <div key={x.id} className="muted small">{x.name} · {x.questions.length} {t("questions ·")}{" "}<a href="#" onClick={async e => { e.preventDefault(); await run(() => api(s, `/api/surveys/forms/${x.id}`, { method: "PUT", body: JSON.stringify({ active: !x.active }) })); reload(); }}>{x.active ? t("turn off") : t("turn on")}</a></div>)}
    </details>}</>;
}

// ---------- WhatsApp / SMS ----------
const TPL_NAME: Record<string, string> = { order_confirmed: t("Order received"), invoice_created: t("Invoice ready"), payment_received: t("Payment received"), payment_reminder: t("Payment reminder") };
export function Messages({ s }: ViewProps) {
  const admin = s.user.role === "company_admin";
  const [cfg, reloadCfg] = useData<any>(s, admin ? "/api/messages/settings" : null);
  const [log, reloadLog] = useData<any[]>(s, "/api/messages/log");
  const [c, setC] = useState<any>(null), [to, setTo] = useState(""), [min, setMin] = useState("0");
  useEffect(() => { if (cfg) setC(cfg); }, [cfg]);
  const http = c?.provider === "http";
  return <><h2>{t("WhatsApp / SMS")}</h2>
    {admin && c && <div className="card">
      <div className={http ? "usage warn" : "banner"}>{http ? t("Real messages are sent through your provider.") : t("Mock mode: messages are only written to the log below. Nothing is sent.")}</div>
      <Field label={t("Provider")}><select value={c.provider} onChange={e => setC({ ...c, provider: e.target.value })}>{Object.entries(c.providers).map(([k, v]: any) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label={t("Channel")}><select value={c.channel} onChange={e => setC({ ...c, channel: e.target.value })}><option value="whatsapp">{t("WhatsApp")}</option><option value="sms">{t("SMS")}</option></select></Field>
      {http && <><Field label={t("Provider URL (https)")}><input value={c.http.url} onChange={e => setC({ ...c, http: { ...c.http, url: e.target.value } })} placeholder="https://your-gateway.example.com/send" /></Field>
        <Field label={t("Key header")}><input value={c.http.authHeader} onChange={e => setC({ ...c, http: { ...c.http, authHeader: e.target.value } })} /></Field>
        <Field label={t("Key")}><input type="password" value={c.http.authValue} onChange={e => setC({ ...c, http: { ...c.http, authValue: e.target.value } })} /></Field>
        <Field label={t("Body ({to}, {text}, {channel})")}><textarea rows={2} value={c.http.body} onChange={e => setC({ ...c, http: { ...c.http, body: e.target.value } })} /></Field></>}
      {Object.keys(c.defaults).map(k => <div key={k}>
        {k !== "payment_reminder" && <label className="chk"><input type="checkbox" checked={!!c.auto[k]} onChange={e => setC({ ...c, auto: { ...c.auto, [k]: e.target.checked } })} /> {t("Send automatically")}</label>}
        <Field label={TPL_NAME[k]}><textarea rows={2} value={c.templates[k] ?? c.defaults[k]} onChange={e => setC({ ...c, templates: { ...c.templates, [k]: e.target.value } })} /></Field></div>)}
      <div className="row-btns"><button onClick={async () => { if (await run(() => api(s, "/api/messages/settings", { method: "PUT", body: JSON.stringify(c) }))) { toast(t("Saved")); reloadCfg(); } }}>{t("Save")}</button>
        <input placeholder={t("Test phone")} value={to} onChange={e => setTo(e.target.value)} style={{ maxWidth: 140 }} />
        <button className="sm ghost" onClick={async () => { if (await run(() => api(s, "/api/messages/test", { method: "POST", body: JSON.stringify({ to }) }))) { toast(t("Test queued")); reloadLog(); } }}>{t("Send test")}</button></div></div>}
    <div className="card"><b>{t("Payment reminders")}</b><Field label={t("Outlets owing more than ₹")}><input inputMode="decimal" value={min} onChange={e => setMin(e.target.value)} /></Field>
      <button className="sm" onClick={async () => { const r: any = await run(() => api(s, "/api/messages/reminders", { method: "POST", body: JSON.stringify({ minAmount: Number(min) }) })); if (r) { toast(t("{0} reminders queued{1}", r.queued, r.skipped ? `, ${r.skipped} outlets have no phone` : "")); reloadLog(); } }}>{t("Queue reminders")}</button></div>
    <h3>{t("Message log")}</h3>
    {!log ? <Loading /> : !log.length ? <p className="muted">{t("No messages yet.")}</p> : log.map(m => <div key={m.id} className="card small"><b>{TPL_NAME[m.template] || m.template}</b> <span className="muted">· {m.shop_name || m.to_phone || "—"} · {m.channel} · <b>{m.status === "mock" ? t("logged (mock)") : m.status}</b>{m.error ? ` · ${m.error}` : ""} · {String(m.created_at).slice(0, 16).replace("T", " ")}</span><div>{m.body}</div></div>)}</>;
}
