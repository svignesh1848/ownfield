// Field operations screens: van sales, distributor inventory, claims, leads, coverage, surveys, messaging, location trail.
import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps, type Session } from "./main";
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
    const p = prods?.find(x => x.barcode === code || x.sku === code); if (!p) return toast(`No product for ${code}`, "err");
    const i = lines.findIndex(l => l.sku === p.sku);
    setLines(i >= 0 ? lines.map((l, j) => j === i ? { ...l, qty: Number(l.qty) + 1 } : l) : [...lines.filter(l => l.sku), { sku: p.sku, qty: 1 }]);
  };
  return <div>
    <datalist id="skus">{prods?.map(p => <option key={p.id} value={p.sku}>{p.item_name} {Object.values(p.attrs || {}).join(" ")}</option>)}</datalist>
    {lines.map((l, i) => <div key={i} className="row-btns">
      <input list="skus" placeholder="Product code" value={l.sku} onChange={e => set(i, "sku", e.target.value)} />
      <input type="number" min={0} style={{ width: 80 }} value={l.qty} onChange={e => set(i, "qty", Number(e.target.value))} />
      <button type="button" className="sm ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></div>)}
    <div className="row-btns"><button type="button" className="sm ghost" onClick={() => setLines([...lines, { sku: "", qty: 1 }])}>+ Product</button>
      {scan && <ScanButton onCode={addSku} />}</div>
  </div>;
}

/** Camera barcode/QR scanning with the browser's BarcodeDetector; falls back to typing the code. */
export function ScanButton({ onCode, label = "📷 Scan" }: { onCode: (c: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>{<button type="button" className="sm" onClick={() => setOpen(true)}>{label}</button>}{open && <Scanner onCode={c => { setOpen(false); onCode(c); }} onClose={() => setOpen(false)} />}</>;
}
export function Scanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const vid = React.useRef<HTMLVideoElement>(null); const [msg, setMsg] = useState("Point the camera at a barcode or QR code"); const [typed, setTyped] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false;
    const BD = (window as any).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) { setMsg("This phone's browser can't scan. Type the code instead."); return; }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = vid.current!; v.srcObject = stream; await v.play();
        const det = new BD({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code", "itf"] });
        while (!stop) { const r = await det.detect(v).catch(() => []); if (r[0]?.rawValue) { onCode(r[0].rawValue); break; } await new Promise(ok => setTimeout(ok, 250)); }
      } catch { setMsg("Camera not available. Type the code instead."); }
    })();
    return () => { stop = true; stream?.getTracks().forEach(t => t.stop()); };
  }, []);
  return <div className="card scanner"><p className="muted">{msg}</p><video ref={vid} playsInline muted style={{ width: "100%", maxHeight: 260, background: "#000" }} />
    <form className="row-btns" onSubmit={e => { e.preventDefault(); if (typed.trim()) onCode(typed.trim()); }}><input placeholder="or type the code" value={typed} onChange={e => setTyped(e.target.value)} /><button className="sm">Use</button>
      <button type="button" className="sm ghost" onClick={onClose}>Close</button></form></div>;
}

// ---------- Van sales ----------
export function VanRep({ s, cfg }: ViewProps) {
  const [van, load] = useData<any>(s, "/api/van/today");
  const [shops] = useData<any[]>(s, "/api/shops");
  const [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]), [shop, setShop] = useState(""), [counts, setCounts] = useState<Record<string, number>>({}), [last, setLast] = useState<any>(null);
  const scan = !!cfg.settings.features.barcode;
  return <><h2>My van</h2>
    {!van ? <div className="card"><p>Load your van for today.</p><Lines s={s} lines={lines} setLines={setLines} scan={scan} />
      <button onClick={async () => { if (await run(() => api(s, "/api/van/load", { method: "POST", body: JSON.stringify({ lines: lines.filter(l => l.sku) }) }))) { setLines([{ sku: "", qty: 1 }]); load(); } }}>Load van</button></div>
      : <>
        <Table rows={van.lines} cols={["sku", "name", "loaded", "sold", "left"]} />
        <div className="card"><h3>Sell now</h3>
          <Field label="Outlet"><select value={shop} onChange={e => setShop(e.target.value)}><option value="">Pick an outlet</option>{shops?.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Lines s={s} lines={lines} setLines={setLines} scan={scan} />
          <button onClick={async () => { const r: any = await run(() => api(s, "/api/van/sale", { method: "POST", body: JSON.stringify({ clientRef: ref(), shopId: Number(shop), lines: lines.filter(l => l.sku) }) })); if (r) { setLast(r); setLines([{ sku: "", qty: 1 }]); load(); } }}>Sell{cfg.settings.features.invoicing ? " and invoice" : ""}</button>
          {last?.invoice && <p>Invoice <b>{last.invoice.number}</b> · {inr0(last.invoice.total)} · <a href="#" onClick={async e => { e.preventDefault(); const r = await fetch(`/api/invoices/${last.invoice.id}/print`, { headers: { Authorization: `Bearer ${s.token}` } }); const w = window.open(""); w?.document.write(await r.text()); }}>Print</a></p>}</div>
        <div className="card"><h3>Day end</h3><p className="muted">Count what is left on the van. Leave blank if it matches.</p>
          {van.lines.map((l: any) => <Field key={l.sku} label={`${l.sku} (expected ${l.left})`}><input type="number" min={0} value={counts[l.sku] ?? ""} onChange={e => setCounts({ ...counts, [l.sku]: Number(e.target.value) })} /></Field>)}
          <button onClick={async () => { const r: any = await run(() => api(s, "/api/van/close", { method: "POST", body: JSON.stringify({ counts: Object.entries(counts).map(([sku, qty]) => ({ sku, qty })) }) })); if (r) { toast(`Closed. Sales ${inr0(r.sales_total)}`); load(); } }}>Close the day</button></div></>}</>;
}
export function VanAdmin({ s }: ViewProps) {
  const [day, setDay] = useState(today()); const [loads, reload] = useData<any[]>(s, `/api/van/loads?day=${day}`, [day]);
  const [reps] = useData<any[]>(s, "/api/reps"); const [rep, setRep] = useState(""); const [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]);
  return <><h2>Van sales</h2>
    <div className="card"><h3>Load a van</h3><Field label="Sales rep"><select value={rep} onChange={e => setRep(e.target.value)}><option value="">Pick</option>{reps?.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
      <Lines s={s} lines={lines} setLines={setLines} /><button onClick={async () => { if (await run(() => api(s, "/api/van/load", { method: "POST", body: JSON.stringify({ repId: Number(rep), lines: lines.filter(l => l.sku) }) }))) reload(); }}>Load</button></div>
    <Field label="Day"><input type="date" value={day} onChange={e => setDay(e.target.value)} /></Field>
    {!loads ? <Loading /> : loads.map(l => <div className="card" key={l.id}><b>{l.rep_name}</b> · {l.status} · sales {inr0(l.sales_total)}
      <Table rows={l.lines} cols={["sku", "loaded", "sold", "expected", "counted", "variance"]} /></div>)}
    {loads && !loads.length && <p className="muted">No vans loaded on this day.</p>}</>;
}

// ---------- Distributor inventory ----------
export function Inventory({ s, cfg }: ViewProps) {
  const mgr = s.user.role !== "distributor";
  const [dists] = useData<any[]>(s, mgr ? "/api/distributors" : null);
  const [d, setD] = useState(""); const q = mgr && d ? `?distributorId=${d}` : "";
  const [inv, reload] = useData<any>(s, `/api/inventory${q}`, [d]); const [moves, reloadMoves] = useData<any[]>(s, `/api/inventory/moves${q}`, [d]);
  const [kind, setKind] = useState("in"), [lines, setLines] = useState<any[]>([{ sku: "", qty: 1 }]), [batch, setBatch] = useState(""), [expiry, setExpiry] = useState(""), [note, setNote] = useState("");
  const b = cfg.settings.features.batches;
  return <><h2>Inventory</h2>
    {mgr && <Field label="Location"><select value={d} onChange={e => setD(e.target.value)}><option value="">All</option><option value="company">Company warehouse</option>{dists?.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
    {inv && <p className="muted">Stock age: {Object.entries(inv.ageing).map(([k, v]) => `${k}: ${v}`).join(" · ") || "no stock"}</p>}
    <Table rows={inv?.rows ?? null} cols={["distributor", "sku", "name", "batch_no", "expiry", "qty", "age_days"]} empty={{ title: "No stock yet" }} />
    {(!mgr || d) && <div className="card"><h3>Goods in / out</h3>
      <Field label="Type"><select value={kind} onChange={e => setKind(e.target.value)}><option value="in">Goods in (receipt / return)</option><option value="out">Goods out (issue / damage)</option><option value="adjust">Set counted quantity</option></select></Field>
      {b && <><Field label="Batch"><input value={batch} onChange={e => setBatch(e.target.value)} /></Field><Field label="Expiry"><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></Field></>}
      <Lines s={s} lines={lines} setLines={setLines} scan={!!cfg.settings.features.barcode} />
      <Field label="Note"><input value={note} onChange={e => setNote(e.target.value)} /></Field>
      <button onClick={async () => { if (await run(() => api(s, "/api/inventory/moves", { method: "POST", body: JSON.stringify({ kind, distributorId: d || undefined, note, lines: lines.filter(l => l.sku).map(l => ({ ...l, batch_no: batch, expiry })) }) }))) { setLines([{ sku: "", qty: 1 }]); reload(); reloadMoves(); } }}>Save</button></div>}
    <h3>Movements</h3><Table rows={moves} cols={["created_at", "kind", "sku", "batch_no", "qty", "ref", "note"]} empty={{ title: "No movements yet" }} /></>;
}
