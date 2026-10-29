import React, { useEffect, useState } from "react";
import { api, Table, type Session } from "./main";

// ---------- Offline order queue (localStorage; retried on reconnect; server dedupes by clientRef) ----------
const QKEY = "ff-order-queue";
export const queue = { get: (): any[] => JSON.parse(localStorage.getItem(QKEY) || "[]"), set: (q: any[]) => localStorage.setItem(QKEY, JSON.stringify(q)) };
export async function flushQueue(s: Session) {
  for (const o of queue.get()) {
    try { await api(s, "/api/orders", { method: "POST", body: JSON.stringify(o) }); queue.set(queue.get().filter(x => x.clientRef !== o.clientRef)); }
    catch (e: any) { if (/fetch|network/i.test(e.message)) break; queue.set(queue.get().map(x => x.clientRef === o.clientRef ? { ...x, error: e.message } : x)); }
  }
}
export function OfflineBadge({ s }: { s: Session }) {
  const [n, setN] = useState(queue.get().length); const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const tick = async () => { setOn(navigator.onLine); if (navigator.onLine) await flushQueue(s); setN(queue.get().length); };
    const t = setInterval(tick, 5000); window.addEventListener("online", tick); tick();
    return () => { clearInterval(t); window.removeEventListener("online", tick); };
  }, []);
  if (!n && on) return null;
  return <div className="usage warn">{on ? "Online" : "Offline"} · {n} order(s) waiting to sync</div>;
}

const gps = () => new Promise<{ lat: number; lng: number }>((ok, no) =>
  navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), e => no(new Error(e.message)), { enableHighAccuracy: true, timeout: 15000 }) : no(new Error("GPS unavailable")));

export function Dashboard({ s }: { s: Session }) {
  const [rows, setRows] = useState<any[]>([]); const [days, setDays] = useState(7);
  useEffect(() => { api(s, `/api/dashboard?days=${days}`).then(setRows); }, [days]);
  const tot = rows.reduce((a, r) => ({ v: a.v + r.visits, o: a.o + r.orders, val: a.val + r.value }), { v: 0, o: 0, val: 0 });
  return <><h2>Team activity</h2>
    <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1, 7, 30].map(d => <option key={d} value={d}>Last {d} day(s)</option>)}</select>
    <div className="kpis"><div><b>{tot.v}</b>visits</div><div><b>{tot.o}</b>orders</div><div><b>₹{tot.val.toLocaleString("en-IN")}</b>value</div></div>
    <Table rows={rows.map(r => ({ ...r, value: `₹${r.value.toLocaleString("en-IN")}` }))} cols={["day", "rep", "visits", "orders", "value"]} /></>;
}

export function Beats({ s }: { s: Session }) {
  const [beats, setBeats] = useState<any[]>([]); const [reps, setReps] = useState<any[]>([]); const [shops, setShops] = useState<any[]>([]);
  const [f, setF] = useState<{ name: string; repId: string; shopIds: number[] }>({ name: "", repId: "", shopIds: [] }); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/beats").then(setBeats);
  useEffect(() => { load(); api(s, "/api/reps").then(setReps); api(s, "/api/shops").then(setShops); }, []);
  return <><h2>Beat plans</h2>
    {beats.map(b => <div className="row" key={b.id}><b>{b.name}</b> · {b.rep_name || "unassigned"}<div className="muted">{b.shops.map((x: any) => x.name).join(" → ")}</div></div>)}
    <form onSubmit={async e => { e.preventDefault(); try { await api(s, "/api/beats", { method: "POST", body: JSON.stringify({ ...f, repId: f.repId ? Number(f.repId) : null }) }); setF({ name: "", repId: "", shopIds: [] }); setMsg("Beat created"); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h3>New beat</h3><input placeholder="Beat name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
      <select value={f.repId} onChange={e => setF({ ...f, repId: e.target.value })}><option value="">Assign rep…</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      {shops.map(x => <label key={x.id} className="chk"><input type="checkbox" checked={f.shopIds.includes(x.id)} onChange={e => setF({ ...f, shopIds: e.target.checked ? [...f.shopIds, x.id] : f.shopIds.filter(i => i !== x.id) })} />{x.name} <span className="muted">{x.city}</span></label>)}
      <button>Create beat</button><p>{msg}</p></form></>;
}

export function ShopsMap({ s }: { s: Session }) {
  const [shops, setShops] = useState<any[]>([]); const [d, setD] = useState<any[]>([]);
  const load = () => api(s, "/api/shops").then(setShops);
  useEffect(() => { load(); api(s, "/api/distributors").then(setD); }, []);
  return <><h2>Shops & distributor mapping</h2>{shops.map(x => <div className="row" key={x.id}><b>{x.name}</b> <span className="muted">{x.code} · {x.city}</span>
    <select value={x.distributor_id ?? ""} onChange={async e => { await api(s, `/api/shops/${x.id}/distributor`, { method: "POST", body: JSON.stringify({ distributorId: e.target.value ? Number(e.target.value) : null }) }); load(); }}>
      <option value="">No distributor</option>{d.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>)}</>;
}

export function MyBeat({ s }: { s: Session }) {
  const [beats, setBeats] = useState<any[]>([]); const [visits, setVisits] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => { api(s, "/api/beats").then(setBeats); api(s, "/api/visits").then(setVisits); };
  useEffect(load, []);
  const open = visits.find(v => !v.check_out_at);
  const act = async (fn: (p: { lat: number; lng: number }) => Promise<unknown>) => { try { setMsg("Getting GPS…"); await fn(await gps()); setMsg(""); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>My beat</h2>{open && <div className="usage warn">In visit: <b>{open.shop_name}</b> since {new Date(open.check_in_at).toLocaleTimeString()}
      <button className="sm" onClick={() => act(p => api(s, `/api/visits/${open.id}/checkout`, { method: "POST", body: JSON.stringify(p) }))}>Check out</button></div>}
    {!beats.length && <p className="muted">No beat assigned yet.</p>}
    {beats.map(b => <div key={b.id}><h3>{b.name}</h3>{b.shops.map((x: any) => {
      const done = visits.some(v => v.shop_id === x.id && v.check_out_at && new Date(v.check_in_at).toDateString() === new Date().toDateString());
      return <div className="row" key={x.id}>{x.seq}. <b>{x.name}</b> <span className="muted">{x.city}</span> {done ? <span className="pill">visited</span>
        : !open && <button className="sm" onClick={() => act(p => api(s, "/api/visits/checkin", { method: "POST", body: JSON.stringify({ shopId: x.id, ...p }) }))}>Check in</button>}</div>;
    })}</div>)}<p className="err">{msg}</p></>;
}

export function OrderForm({ s }: { s: Session }) {
  const [shops, setShops] = useState<any[]>(() => JSON.parse(localStorage.getItem("ff-shops") || "[]"));
  const [products, setProducts] = useState<any[]>(() => JSON.parse(localStorage.getItem("ff-products") || "[]"));
  const [shopId, setShopId] = useState(""); const [qty, setQty] = useState<Record<string, string>>({}); const [msg, setMsg] = useState("");
  useEffect(() => {
    api(s, "/api/shops").then(r => { setShops(r); localStorage.setItem("ff-shops", JSON.stringify(r)); }).catch(() => {});
    api(s, "/api/products").then(r => { setProducts(r); localStorage.setItem("ff-products", JSON.stringify(r)); }).catch(() => {});
  }, []);
  const styles = [...new Set(products.map(p => p.style))];
  const total = products.reduce((a, p) => a + (Number(qty[p.sku]) || 0) * Number(p.billing_price), 0);
  const submit = async () => {
    const lines = Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([sku, q]) => ({ sku, qty: Number(q) }));
    if (!shopId || !lines.length) return setMsg("Pick a shop and enter quantities");
    const o = { clientRef: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, shopId: Number(shopId), lines };
    queue.set([...queue.get(), o]); await flushQueue(s);
    setMsg(queue.get().some(x => x.clientRef === o.clientRef) ? "Saved offline — will sync automatically" : "Order placed ✓"); setQty({});
  };
  return <><h2>Take order</h2>
    <select value={shopId} onChange={e => setShopId(e.target.value)}><option value="">Select shop…</option>{shops.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
    {styles.map(st => { const sizes = products.filter(p => p.style === st); return <div className="grid" key={st}>
      <div className="gh"><b>{st}</b> <span className="muted">₹{sizes[0].billing_price} · MRP ₹{sizes[0].mrp}</span></div>
      <div className="cells">{sizes.map(p => <label key={p.sku}><span>{p.size || p.sku}</span><input inputMode="numeric" value={qty[p.sku] || ""} placeholder="0" onChange={e => { setQty({ ...qty, [p.sku]: e.target.value.replace(/\D/g, "") }); }} /></label>)}</div></div>; })}
    <div className="total">Total ₹{total.toLocaleString("en-IN")}<button onClick={submit}>Place order</button></div><p>{msg}</p></>;
}

const OrderCard = ({ o, children }: { o: any; children?: any }) => <div className="row"><b>#{o.id} {o.shop_name}</b> <span className={`pill ${o.status}`}>{o.status}</span>
  <div className="muted">{o.rep_name} · {new Date(o.created_at).toLocaleString()} · ₹{Number(o.total).toLocaleString("en-IN")}</div>
  <div className="muted">{o.lines.map((l: any) => `${l.style} ${l.size}×${l.qty}`).join(", ")}</div>{children}</div>;

export function Orders({ s }: { s: Session }) {
  const [rows, setRows] = useState<any[]>([]); useEffect(() => { api(s, "/api/orders").then(setRows); }, []);
  return <><h2>Orders</h2>{!rows.length && <p className="muted">No orders yet.</p>}{rows.map(o => <OrderCard key={o.id} o={o} />)}</>;
}

export function Inbox({ s }: { s: Session }) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/orders").then(setRows); useEffect(() => { load(); }, []);
  const set = async (id: number, status: string) => { try { await api(s, `/api/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>Order inbox</h2>{!rows.length && <p className="muted">No orders routed to you yet.</p>}
    {rows.map(o => <OrderCard key={o.id} o={o}>
      {o.status === "placed" && <><button className="sm" onClick={() => set(o.id, "accepted")}>Accept</button> <button className="sm ghost" onClick={() => set(o.id, "rejected")}>Reject</button></>}
      {o.status === "accepted" && <button className="sm" onClick={() => set(o.id, "fulfilled")}>Mark fulfilled</button>}</OrderCard>)}<p className="err">{msg}</p></>;
}
