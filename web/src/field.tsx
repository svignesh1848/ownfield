import { ScanButton } from "./ops";
import { t, t as i18n } from "./i18n";
import React, { useEffect, useState } from "react";
import { api, Table, label, type Session, type Cfg } from "./main";
import { CustomInputs, attrText } from "./config";
import { VisitPhotos, openPrint } from "./step4";
import { inr, inr0, fmtDate, Empty, toast, Term, Loading } from "./ui";

// ---------- Offline order queue (localStorage; retried on reconnect; server dedupes by clientRef) ----------
const QKEY = "ff-order-queue";
export const queue = { get: (): any[] => JSON.parse(localStorage.getItem(QKEY) || "[]"), set: (q: any[]) => localStorage.setItem(QKEY, JSON.stringify(q)) };
export async function flushQueue(s: Session) {
  for (const o of queue.get()) {
    try { const { _url, error, ...body } = o; await api(s, _url || "/api/orders", { method: "POST", body: JSON.stringify(body) }); queue.set(queue.get().filter(x => x.clientRef !== o.clientRef)); }
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
  return <div className="usage warn">{on ? t("online", "Online") : t("offline", "Offline")} · {n} {t("waiting", "waiting to sync")}</div>;
}

const gps = () => new Promise<{ lat: number; lng: number }>((ok, no) =>
  navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), e => no(new Error(e.message)), { enableHighAccuracy: true, timeout: 15000 }) : no(new Error("GPS unavailable")));

export function Dashboard({ s }: { s: Session }) {
  const [rows, setRows] = useState<any[]>([]); const [days, setDays] = useState(7);
  useEffect(() => { api(s, `/api/dashboard?days=${days}`).then(setRows); }, [days]);
  const tot = rows.reduce((a, r) => ({ v: a.v + r.visits, o: a.o + r.orders, val: a.val + r.value }), { v: 0, o: 0, val: 0 });
  return <><h2>{t("Team activity")}</h2><p className="muted">{t("Visits and orders by each sales rep.")}</p>
    <select value={days} onChange={e => setDays(Number(e.target.value))}>{[1, 7, 30].map(d => <option key={d} value={d}>{t("Last")}{" "}{d} {t("day(s)")}</option>)}</select>
    <div className="kpis"><div><b>{tot.v}</b>visits</div><div><b>{tot.o}</b>orders</div><div><b>₹{tot.val.toLocaleString("en-IN")}</b>value</div></div>
    <Table rows={rows.map(r => ({ ...r, value: inr(r.value) }))} cols={["day", "rep", "visits", "orders", "value"]} empty={{ title: t("No activity in this period"), text: t("Visits and orders appear here once reps start working.") }} /></>;
}

export function Beats({ s }: { s: Session }) {
  const [beats, setBeats] = useState<any[]>([]); const [reps, setReps] = useState<any[]>([]); const [shops, setShops] = useState<any[]>([]);
  const [f, setF] = useState<{ name: string; repId: string; shopIds: number[] }>({ name: "", repId: "", shopIds: [] }); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/beats").then(setBeats);
  useEffect(() => { load(); api(s, "/api/reps").then(setReps); api(s, "/api/shops").then(setShops); }, []);
  return <><h2>{t("Beat plans")}</h2><p className="muted">A <Term k="Beat">{t("beat")}</Term> {t("is the route of outlets a rep visits.")}</p>{!beats.length && <Empty icon="🗺️" title={t("No beats yet")} text={t("Create one below: name it, pick a rep, tick the outlets in visiting order.")} />}
    {beats.map(b => <div className="row" key={b.id}><b>{b.name}</b> · {b.rep_name || "unassigned"}<div className="muted">{b.shops.map((x: any) => x.name).join(" → ")}</div></div>)}
    <form onSubmit={async e => { e.preventDefault(); try { await api(s, "/api/beats", { method: "POST", body: JSON.stringify({ ...f, repId: f.repId ? Number(f.repId) : null }) }); setF({ name: "", repId: "", shopIds: [] }); setMsg(t("Beat created")); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h3>{t("New beat")}</h3><input placeholder={t("Beat name")} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
      <select value={f.repId} onChange={e => setF({ ...f, repId: e.target.value })}><option value="">{t("Assign rep…")}</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      {shops.map(x => <label key={x.id} className="chk"><input type="checkbox" checked={f.shopIds.includes(x.id)} onChange={e => setF({ ...f, shopIds: e.target.checked ? [...f.shopIds, x.id] : f.shopIds.filter(i => i !== x.id) })} />{x.name} <span className="muted">{x.city}</span></label>)}
      <button>{t("Create beat")}</button><p>{msg}</p></form></>;
}

export function ShopsMap({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [shops, setShops] = useState<any[]>([]); const [d, setD] = useState<any[]>([]);
  const mgr = ["company_admin", "manager"].includes(s.user.role), defs = cfg.settings.customFields.outlet;
  const load = () => api(s, "/api/shops").then(setShops);
  useEffect(() => { load(); if (mgr) api(s, "/api/distributors").then(setD); }, []);
  return <><h2>{t("Outlets & distributor mapping")}</h2>{shops.map(x => <div className="row" key={x.id}><b>{x.name}</b> <span className="muted">{x.code} · {x.city}</span>
    <div className="muted">{cfg.settings.features.drugLicence && t("DL: {0} ", x.drug_licence || "—")}{defs.filter(f => x.custom?.[f.key] != null).map(f => `${f.label}: ${x.custom[f.key]}`).join(" · ")}</div>
    {mgr && <select value={x.distributor_id ?? ""} onChange={async e => { await api(s, `/api/shops/${x.id}/distributor`, { method: "POST", body: JSON.stringify({ distributorId: e.target.value ? Number(e.target.value) : null }) }); load(); }}>
      <option value="">{t("Company direct (no distributor)")}</option>{d.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</div>)}</>;
}

export function MyBeat({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [beats, setBeats] = useState<any[]>([]); const [visits, setVisits] = useState<any[]>([]); const [msg, setMsg] = useState(""); const [vc, setVc] = useState<Record<string, any>>({});
  const OV = "ff-open-visit", local = () => JSON.parse(localStorage.getItem(OV) || "null");
  const load = () => { api(s, "/api/beats").then(setBeats).catch(() => {}); api(s, "/api/visits").then(v => setVisits([...(local() ? [local()] : []), ...v])).catch(() => setVisits(local() ? [local()] : [])); };
  useEffect(load, []);
  // Offline visits: check-in is kept on the phone; check-out sends the whole visit (queued until online).
  const checkin = async (x: any, p: any) => {
    if (navigator.onLine) return api(s, "/api/visits/checkin", { method: "POST", body: JSON.stringify({ shopId: x.id, ...p }) });
    localStorage.setItem(OV, JSON.stringify({ id: "offline", offline: true, shop_id: x.id, shop_name: x.name, check_in_at: new Date().toISOString(), ...p, clientRef: `v${Date.now().toString(36)}` }));
  };
  const checkout = async (o: any, p: any) => {
    if (!o.offline) return api(s, `/api/visits/${o.id}/checkout`, { method: "POST", body: JSON.stringify({ ...p, custom: vc }) });
    await api(s, "/api/visits/offline", { method: "POST", body: JSON.stringify({ clientRef: o.clientRef, shopId: o.shop_id, checkInAt: o.check_in_at, checkOutAt: new Date().toISOString(), lat: o.lat, lng: o.lng, custom: vc }) });
    localStorage.removeItem(OV);
  };
  const open = visits.find(v => !v.check_out_at), gpsOn = cfg.settings.features.gps, vdefs = cfg.settings.customFields.visit;
  const act = async (fn: (p: { lat?: number; lng?: number }) => Promise<unknown>) => {
    try { let p = {}; if (gpsOn) { setMsg(t("Getting GPS…")); p = await gps(); } else p = await gps().catch(() => ({})); await fn(p); setMsg(""); setVc({}); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("My beat")}</h2>{beats.some(b => b.onLeaveToday) && <div className="banner">{t("🌴 You are on approved leave today. Visits are paused — enjoy your day off.")}</div>}{open && <div className="usage warn">{t("In visit:")}{" "}<b>{open.shop_name}</b> since {fmtDate(open.check_in_at, true).slice(11)}
      {cfg.settings.features.photos && !open.offline && <VisitPhotos s={s} visitId={open.id} canAdd />}
      {vdefs.length > 0 && <CustomInputs defs={vdefs} value={vc} onChange={setVc} />}
      <button className="sm" onClick={() => act(p => checkout(open, p))}>{t("Check out")}</button></div>}
    {!beats.length && <Empty icon="🗺️" title={t("No beat assigned yet")} text={t("A beat is your list of outlets to visit. Ask your manager to assign one.")} />}
    {beats.map(b => <div key={b.id}><h3>{b.name}</h3>{b.shops.map((x: any) => {
      const done = visits.some(v => v.shop_id === x.id && v.check_out_at && new Date(v.check_in_at).toDateString() === new Date().toDateString());
      return <div className="row" key={x.id}>{x.seq}. <b>{x.name}</b> <span className="muted">{x.city}</span> {done ? <span className="pill">visited</span>
        : !open && <button className="sm" onClick={() => act(p => checkin(x, p))}>{t("Check in")}{gpsOn ? " 📍" : ""}</button>}</div>;
    })}</div>)}<p className="err">{msg}</p></>;
}

export function OrderForm({ s, cfg, go }: { s: Session; cfg: Cfg; go?: (t: string) => void }) {
  const cache = (k: string) => JSON.parse(localStorage.getItem(k) || "[]");
  const [shops, setShops] = useState<any[]>(() => cache("ff-shops")); const [items, setItems] = useState<any[]>(() => cache("ff-items"));
  const [loaded, setLoaded] = useState(!!cache("ff-items").length);
  const [shopId, setShopId] = useState(""); const [qty, setQty] = useState<Record<string, string>>({}); const [unit, setUnit] = useState<Record<number, string>>({});
  const [step, setStep] = useState<"shop" | "items" | "review" | "done">("shop"); const [q, setQ] = useState(""); const [shopQ, setShopQ] = useState(""); const [cat, setCat] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(s, "/api/shops").then(r => { setShops(r); localStorage.setItem("ff-shops", JSON.stringify(r)); }).catch(() => {});
    api(s, "/api/items").then(r => { setItems(r); setLoaded(true); localStorage.setItem("ff-items", JSON.stringify(r)); }).catch(() => setLoaded(true));
  }, []);
  const st = cfg.settings, f = st.features;
  const factor = (i: any) => (i.uoms.find((u: any) => u.code === unit[i.id]) ?? i.uoms.find((u: any) => u.factor === 1) ?? { factor: 1 }).factor;
  const unitName = (i: any) => unit[i.id] || i.uoms.find((u: any) => u.factor === 1)?.code || "PCS";
  const total = items.reduce((a, i) => a + i.variants.reduce((b: number, v: any) => b + (Number(qty[v.sku]) || 0) * factor(i) * v.billing_price, 0), 0);
  const cartLines = () => items.flatMap(i => i.variants.filter((v: any) => Number(qty[v.sku]) > 0).map((v: any) => ({ sku: v.sku, qty: Number(qty[v.sku]), ...(unit[i.id] ? { uom: unit[i.id] } : {}) })));
  const count = Object.values(qty).reduce((a, v) => a + (Number(v) || 0), 0);
  const [pv, setPv] = useState<any>(null);
  useEffect(() => { // live offer preview (online only; offline falls back to list prices)
    const lines = cartLines(); if (!f.schemes || !shopId || !lines.length || !navigator.onLine) return setPv(null);
    const t = setTimeout(() => api(s, "/api/orders/preview", { method: "POST", body: JSON.stringify({ shopId: Number(shopId), lines }) }).then(setPv).catch(() => setPv(null)), 400);
    return () => clearTimeout(t);
  }, [qty, unit, shopId]);
  const [credit, setCredit] = useState<any>(null);
  useEffect(() => { if (!shopId || !f.invoicing || !navigator.onLine) return setCredit(null);
    api(s, `/api/credit-check?shopId=${shopId}&amount=${pv ? pv.total : total}`).then(setCredit).catch(() => setCredit(null)); }, [shopId, pv, step]);
  const shop = shops.find(x => String(x.id) === shopId);
  const retailer = s.user.role === "retailer";
  useEffect(() => { if (retailer && step === "shop" && shops.length === 1) { setShopId(String(shops[0].id)); setStep("items"); } }, [shops, step]);
  const submit = async () => {
    const lines = cartLines(); if (!shopId || !lines.length) return;
    setBusy(true);
    const o = { clientRef: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, shopId: Number(shopId), lines };
    queue.set([...queue.get(), o]); await flushQueue(s);
    const r = queue.get().find(x => x.clientRef === o.clientRef);
    setBusy(false);
    if (r?.error) { queue.set(queue.get().filter(x => x.clientRef !== o.clientRef)); setResult({ ok: false, text: r.error }); toast(t("Order not placed: {0}", r.error), "err"); return; }
    setResult({ ok: true, text: !r ? t("Order placed") : t("Saved on this phone — it will be sent automatically when you're back online") }); setQty({}); setStep("done");
  };
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))] as string[];
  const needle = q.trim().toLowerCase();
  const shown = items.filter(i => (!cat || i.category === cat) && (!needle || [i.name, i.code, i.category, ...i.variants.map((v: any) => v.sku)].some(x => String(x || "").toLowerCase().includes(needle))));
  const cell = (v: any) => <input inputMode="numeric" aria-label={t("Quantity {0}", v.sku)} className={Number(qty[v.sku]) > 0 ? "has" : ""} value={qty[v.sku] || ""} placeholder="0" onChange={e => setQty({ ...qty, [v.sku]: e.target.value.replace(/\D/g, "").slice(0, 5) })} />;
  const shownTotal = pv ? pv.total : total;

  if (step === "done") return <div className="done-screen"><div className="big-ic">{result?.ok ? "✅" : "⚠️"}</div><h2>{result?.text}</h2>
    <p className="muted">{shop?.name}</p><button className="block" onClick={() => { setResult(null); setStep("shop"); setShopId(""); }}>{t("Take another order")}</button>
    {go && <button className="block ghost" onClick={() => go("orders")}>{t("See my orders")}</button>}</div>;

  if (step === "shop") {
    const list = shops.filter(x => !shopQ || `${x.name} ${x.code} ${x.city}`.toLowerCase().includes(shopQ.toLowerCase()));
    return <><Steps n={1} /><h2>{t("Which outlet is this order for?")}</h2>
      <input type="search" placeholder={t("Search outlet name, code or city")} value={shopQ} onChange={e => setShopQ(e.target.value)} />
      {!shops.length ? <Empty icon="🏪" title={t("No outlets yet")} text={t("Your administrator needs to upload outlets before you can take orders.")} />
        : list.map(x => <button key={x.id} className="pick" onClick={() => { setShopId(String(x.id)); setStep("items"); }}><b>{x.name}</b><span className="muted small">{[x.code, x.city].filter(Boolean).join(" · ")}</span></button>)}</>;
  }

  if (step === "review") {
    const lines = pv?.lines || items.flatMap(i => i.variants.filter((v: any) => Number(qty[v.sku]) > 0).map((v: any) => ({ sku: v.sku, qty: Number(qty[v.sku]), uom: unitName(i), amount: Number(qty[v.sku]) * factor(i) * v.billing_price, name: `${i.name} ${attrText(v.attrs)}` })));
    const nameOf = (sku: string) => { for (const i of items) { const v = i.variants.find((x: any) => x.sku === sku); if (v) return `${i.name} ${attrText(v.attrs)}`.trim(); } return sku; };
    return <><Steps n={3} /><h2>{t("Review order")}</h2><p className="muted">{t("For")}{" "}<b>{shop?.name}</b> <button className="link" onClick={() => setStep("shop")}>change</button></p>
      <div className="review">{lines.map((l: any, k: number) => <div className="rline" key={k}><div><b>{nameOf(l.sku)}</b><div className="muted small">{l.qty} {l.uom}{l.free ? t(" · FREE") : ""}{l.scheme && !l.free ? t(" · offer: {0}", l.scheme) : ""}</div></div>
        <span>{l.free ? t("Free") : inr(l.amount)}</span></div>)}
        {pv?.savings > 0 && <div className="rline savings"><b>{t("You save")}</b><b>{inr(pv.savings)}</b></div>}
        <div className="rline total-line"><b>{t("Total (before GST)")}</b><b>{inr(shownTotal)}</b></div></div>
      {credit && !credit.ok && <div className={`banner ${credit.action === "block" ? "bad" : "warnb"}`}>{credit.action === "block" ? t("This outlet is on credit hold, so the order will be refused: ") : t("Heads-up: ")}{credit.reasons.join("; ")}</div>}
      {result && !result.ok && <p className="err">{result.text}</p>}
      <p className="muted small">{f.stock && t("Stock is checked when the order is sent. ")}{t("Offers are applied automatically.")}</p>
      <div className="cartbar"><button className="ghost" onClick={() => setStep("items")}>{t("← Edit")}</button><button disabled={busy} onClick={submit}>{busy ? t("Placing…") : t("Place order · {0}", inr0(shownTotal))}</button></div></>;
  }

  return <><Steps n={2} /><h2>{t("Add products")}</h2><p className="muted">{t("For")}{" "}<b>{shop?.name}</b> <button className="link" onClick={() => setStep("shop")}>change</button></p>
    <div className="searchbar"><input type="search" placeholder={t("Search products or codes")} value={q} onChange={e => setQ(e.target.value)} />
      {f.barcode && <ScanButton onCode={c => { const v = items.flatMap(i => i.variants).find((v: any) => v.barcode === c || v.sku === c); if (!v) return toast(t("No product for {0}", c), "err"); setQty({ ...qty, [v.sku]: String((Number(qty[v.sku]) || 0) + 1) }); toast(t("Added {0}", v.sku)); }} />}</div>
    {cats.length > 1 && <div className="chiprow">{["", ...cats].map(c => <button key={c || "all"} className={`chip ${cat === c ? "on" : ""}`} onClick={() => setCat(c)}>{c || t("All")}</button>)}</div>}
    {!loaded ? <Loading text={t("Loading products…")} /> : !items.length ? <Empty icon="📚" title={t("No products yet")} text={t("Your administrator needs to upload the product list first.")} />
      : !shown.length ? <Empty icon="🔍" title={t("No products match")} text={t("Try another word or category.")} action={t("Clear search")} onAction={() => { setQ(""); setCat(""); }} /> : null}
    {shown.map(i => {
      // Attributes that actually vary across this item's variants decide the layout.
      const vary = st.attributes.filter(a => new Set(i.variants.map((v: any) => v.attrs[a] ?? "")).size > 1);
      const grid = f.sizeGrid && i.variants.length > 1 && vary.length >= 1;
      const colsA = vary[0], rowsA = vary[1];
      const colVals = grid ? [...new Set(i.variants.map((v: any) => v.attrs[colsA]))] as string[] : [];
      const rowVals = grid && rowsA ? [...new Set(i.variants.map((v: any) => v.attrs[rowsA]))] as string[] : [""];
      const v0 = i.variants[0];
      return <div className="grid prod" key={i.id}>
        <div className="gh"><b>{i.name}</b> {i.kind === "service" && <span className="pill">service</span>}<span className="muted small">{inr(v0.billing_price, 0)}{i.variants.length > 1 ? "+" : ""} {t("· MRP")}{" "}{inr(v0.mrp, 0)}</span>
          {i.uoms.length > 1 && <select className="unit" aria-label={t("Unit")} value={unit[i.id] || ""} onChange={e => setUnit({ ...unit, [i.id]: e.target.value })}>{i.uoms.map((u: any) => <option key={u.code} value={u.factor === 1 ? "" : u.code}>{u.code}{u.factor > 1 ? t(" of {0}", u.factor) : ""}</option>)}</select>}</div>
        {grid ? <div className="scroll"><table className="sg"><thead><tr><th>{rowsA ? label(rowsA) : ""}</th>{colVals.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>
            {rowVals.map(r => <tr key={r}><th>{r}</th>{colVals.map(c => { const v = i.variants.find((x: any) => x.attrs[colsA] === c && (!rowsA || x.attrs[rowsA] === r)); return <td key={c}>{v ? cell(v) : ""}</td>; })}</tr>)}</tbody></table></div>
          : i.variants.map((v: any) => <div className="line" key={v.sku}><span>{attrText(v.attrs) || v.sku} <span className="muted small">{inr(v.billing_price, 0)}</span></span>{cell(v)}</div>)}
      </div>; })}
    <div className="cartbar"><div><b>{inr0(shownTotal)}</b><span className="muted small"> · {count} {count === 1 ? "unit" : "units"}{pv?.savings > 0 ? t(" · saving {0}", inr0(pv.savings)) : ""}</span></div>
      <button disabled={!count} onClick={() => setStep("review")}>{t("Review order →")}</button></div></>;
}
const Steps = ({ n }: { n: number }) => <ol className="steps">{[t("Outlet"), t("Products"), t("Review")].map((t, i) => <li key={t} className={i + 1 === n ? "on" : i + 1 < n ? "done" : ""}>{i18n(t)}</li>)}</ol>;

const STATUS: Record<string, string> = { placed: t("New"), accepted: t("Accepted"), fulfilled: t("Delivered"), rejected: t("Rejected") };
const OrderCard = ({ o, children }: { o: any; children?: any }) => <div className="row"><b>#{o.id} {o.shop_name}</b> <span className={`pill ${o.status}`}>{STATUS[o.status] || o.status}</span>{o.placed_by_role === "retailer" && <span className="pill">{t("🏪 From the shop")}</span>}
  <div className="muted">{o.rep_name} · {fmtDate(o.created_at, true)} · {inr(o.total)}{Number(o.savings) > 0 ? t(" · saved {0}", inr(o.savings)) : ""}</div>
  {o.lines.map((l: any) => <div className="muted small" key={l.id}>{l.item_name} {attrText(l.attrs)} — {l.qty} {l.uom}{l.free ? t(" FREE ({0})", l.scheme) : l.discount_pct > 0 ? ` (−${l.discount_pct}%${l.scheme ? ` ${l.scheme}` : ""})` : ""} = {inr(l.amount)}
    {l.allocations?.length > 0 && <span className="batches" title={t("Batches picked, nearest expiry first")}> {l.allocations.map((a: any) => `${a.batch_no || "stock"}${a.expiry ? ` exp ${fmtDate(a.expiry)}` : ""} ×${a.qty}`).join("; ")}</span>}</div>)}{children}</div>;

export function Orders({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/orders").then(setRows); useEffect(() => { load(); }, []);
  const mgr = ["company_admin", "manager"].includes(s.user.role), admin = s.user.role === "company_admin";
  const go = async (fn: () => Promise<any>) => { try { await fn(); setMsg(""); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("Orders")}</h2>{!rows.length && <Empty icon="📦" title={t("No orders yet")} text={s.user.role === "sales_rep" ? t("Orders you take will show here.") : t("Orders from your sales reps will appear here as soon as they're placed.")} />}{rows.map(o => <OrderCard key={o.id} o={o}>
    {admin && o.status === "placed" && <button className="sm" onClick={() => go(() => api(s, `/api/orders/${o.id}/status`, { method: "POST", body: JSON.stringify({ status: "accepted" }) }))}>{t("Accept")}</button>}
    {mgr && cfg.settings.features.invoicing && ["accepted", "fulfilled"].includes(o.status) && !(cfg.settings.features.distributorBilling && o.distributor_id && !o.invoice) && (o.invoice
      ? <button className="sm ghost" onClick={() => openPrint(s, o.invoice.id).catch(e => setMsg(e.message))}>{t("Print")}{" "}{o.invoice.number}</button>
      : <button className="sm" onClick={() => go(() => api(s, `/api/orders/${o.id}/invoice`, { method: "POST", body: "{}" }))}>{t("Create GST invoice")}</button>)}
  </OrderCard>)}<p className="err">{msg}</p></>;
}

export function Inbox({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/orders").then(setRows); useEffect(() => { load(); }, []);
  const set = async (id: number, status: string) => { try { await api(s, `/api/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("Order inbox")}</h2>{!rows.length && <Empty icon="📥" title={t("No orders for you yet")} text={t("When a sales rep takes an order at one of your outlets, it lands here for you to accept.")} />}
    {rows.map(o => <OrderCard key={o.id} o={o}>
      {o.status === "placed" && <><button className="sm" onClick={() => set(o.id, "accepted")}>{t("Accept")}</button> <button className="sm ghost" onClick={() => set(o.id, "rejected")}>{t("Reject")}</button></>}
      {o.status === "accepted" && <button className="sm" onClick={() => set(o.id, "fulfilled")}>{t("Mark delivered")}</button>}
      {cfg?.settings.features.invoicing && cfg.settings.features.distributorBilling && ["accepted", "fulfilled"].includes(o.status) && (o.invoice
        ? <button className="sm ghost" onClick={() => openPrint(s, o.invoice.id).catch(e => setMsg(e.message))}>{t("Print")}{" "}{o.invoice.number}</button>
        : <button className="sm ghost" onClick={async () => { try { await api(s, `/api/orders/${o.id}/invoice`, { method: "POST", body: "{}" }); load(); } catch (e: any) { setMsg(e.message); } }}>{t("Create GST invoice")}</button>)}</OrderCard>)}<p className="err">{msg}</p></>;
}
