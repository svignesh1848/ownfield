import { ScanButton } from "./ops";
import { t, t as i18n } from "./i18n";
import { Field } from "./ui";
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

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function Beats({ s }: { s: Session }) {
  const [beats, setBeats] = useState<any[]>([]); const [reps, setReps] = useState<any[]>([]); const [shops, setShops] = useState<any[]>([]);
  const blank = { name: "", repId: "", weekday: "", shopIds: [] as number[] };
  const [f, setF] = useState<{ name: string; repId: string; weekday: string; shopIds: number[] }>(blank); const [msg, setMsg] = useState(""); const [editId, setEditId] = useState<number | null>(null);
  const load = () => api(s, "/api/beats").then(setBeats);
  useEffect(() => { load(); api(s, "/api/reps").then(setReps); api(s, "/api/shops").then(setShops); }, []);
  const startEdit = (b: any) => { setEditId(b.id); setF({ name: b.name, repId: b.rep_id ? String(b.rep_id) : "", weekday: b.weekday == null ? "" : String(b.weekday), shopIds: b.shops.map((x: any) => x.id) }); window.scrollTo(0, document.body.scrollHeight); };
  const move = (id: number, d: number) => { const l = [...f.shopIds], i = l.indexOf(id), j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setF({ ...f, shopIds: l }); };
  return <><h2>{t("Beat plans")}</h2><p className="muted">A <Term k="Beat">{t("beat")}</Term> {t("is the route of outlets a rep visits.")}</p>{!beats.length && <Empty icon="🗺️" title={t("No beats yet")} text={t("Create one below: name it, pick a rep, tick the outlets in visiting order.")} />}
    {beats.map(b => <div className="row" key={b.id}><b>{b.name}</b> · {b.rep_name || "unassigned"} · {b.weekday == null ? t("Every working day") : t(DAYS[b.weekday])} <button className="sm ghost" onClick={() => startEdit(b)}>{t("Edit")}</button><div className="muted">{b.shops.map((x: any) => x.name).join(" → ")}</div></div>)}
    <form onSubmit={async e => { e.preventDefault(); try { const body = JSON.stringify({ ...f, repId: f.repId ? Number(f.repId) : null, weekday: f.weekday === "" ? null : Number(f.weekday) });
        if (editId) await api(s, `/api/beats/${editId}`, { method: "PUT", body }); else await api(s, "/api/beats", { method: "POST", body });
        setF(blank); setMsg(editId ? t("Changes saved") : t("Beat created")); setEditId(null); load(); } catch (x: any) { setMsg(x.message); } }}>
      <h3>{editId ? t("Edit") : t("New beat")}</h3><input placeholder={t("Beat name")} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required />
      <select value={f.repId} onChange={e => setF({ ...f, repId: e.target.value })}><option value="">{t("Assign rep…")}</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <select value={f.weekday} onChange={e => setF({ ...f, weekday: e.target.value })}><option value="">{t("Every working day")}</option>{DAYS.map((d, i) => <option key={d} value={i}>{t(d)}</option>)}</select>
      {f.shopIds.length > 0 && <div className="muted">{f.shopIds.map((id, i) => { const x = shops.find(y => y.id === id); return <span key={id} className="pill">{i + 1}. {x?.name} <a onClick={() => move(id, -1)}>↑</a> <a onClick={() => move(id, 1)}>↓</a></span>; })}</div>}
      {shops.map(x => <label key={x.id} className="chk"><input type="checkbox" checked={f.shopIds.includes(x.id)} onChange={e => setF({ ...f, shopIds: e.target.checked ? [...f.shopIds, x.id] : f.shopIds.filter(i => i !== x.id) })} />{x.name} <span className="muted">{x.city}</span></label>)}
      <button>{editId ? t("Save") : t("Create beat")}</button>{editId && <button type="button" className="ghost" onClick={() => { setEditId(null); setF(blank); }}>{t("Cancel")}</button>}<p>{msg}</p></form></>;
}

const OUTLET_FIELDS: [string, string, string?][] = [["code", "Outlet code"], ["name", "Name"], ["owner_name", "Owner"], ["phone", "Phone", "tel"], ["email", "Email", "email"],
  ["gstin", "GSTIN"], ["pan", "PAN"], ["address", "Address"], ["city", "City"], ["state", "State"], ["pincode", "PIN code"], ["latitude", "Latitude"], ["longitude", "Longitude"],
  ["channel", "Channel"], ["outlet_type", "Outlet type"], ["outlet_class", "Outlet class"], ["beat", "Beat"], ["credit_limit", "Credit limit", "number"], ["credit_days", "Credit days", "number"], ["payment_terms", "Payment terms"]];
const outletToForm = (x: any) => ({ code: x.code ?? "", name: x.name ?? "", owner_name: x.owner_name ?? "", contact_person: "", phone: x.phone ?? "", email: x.email ?? "", gstin: x.gstin ?? "", pan: x.pan ?? "",
  address: x.address ?? "", city: x.city ?? "", state: x.state_code ?? "", pincode: x.pincode ?? "", latitude: x.lat ?? "", longitude: x.lng ?? "", channel: x.channel ?? "", outlet_type: x.outlet_type ?? "",
  outlet_class: x.outlet_class ?? "", beat: "", credit_limit: x.credit_limit ?? "", credit_days: x.credit_days ?? "", payment_terms: x.payment_terms ?? "", active: x.active !== false, rep_id: x.rep_id ?? "", distributor_id: x.distributor_id ?? "", custom: x.custom || {} });

/** Add or edit one outlet with every field the retailer master upload has (same checks on the server). */
function OutletForm({ s, cfg, shop, reps, dists, done }: { s: Session; cfg: Cfg; shop: any | null; reps: any[]; dists: any[]; done: () => void }) {
  const [f, setF] = useState<any>(() => outletToForm(shop || {})); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    const body: any = { ...f, active: f.active ? "Yes" : "No", rep_email: reps.find(r => String(r.id) === String(f.rep_id))?.email, distributor_email: dists.find(d => String(d.id) === String(f.distributor_id))?.email };
    delete body.rep_id; delete body.distributor_id; delete body.credit_limit; delete body.credit_days;
    for (const k of Object.keys(body)) if (body[k] === "" || body[k] === undefined) delete body[k];
    try {
      const r = shop ? await api(s, `/api/shops/${shop.id}`, { method: "PATCH", body: JSON.stringify(body) }) : await api(s, "/api/shops", { method: "POST", body: JSON.stringify(body) });
      await api(s, `/api/shops/${r.id}`, { method: "PATCH", body: JSON.stringify({ creditLimit: f.credit_limit === "" ? null : f.credit_limit, creditDays: f.credit_days === "" ? null : f.credit_days }) });
      if (shop && String(f.distributor_id || "") !== String(shop.distributor_id || "")) await api(s, `/api/shops/${r.id}/distributor`, { method: "POST", body: JSON.stringify({ distributorId: f.distributor_id ? Number(f.distributor_id) : null }) });
      done();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return <form className="card" onSubmit={save}><h3>{shop ? t("Edit") : t("Add outlet")}</h3>
    {OUTLET_FIELDS.filter(([k]) => !(shop && k === "code")).map(([k, l, type]) => <Field key={k} label={t(l)}><input type={type || "text"} value={f[k]} required={k === "code" || k === "name"} onChange={e => setF({ ...f, [k]: e.target.value })} /></Field>)}
    <Field label={t("Sales rep")}><select value={f.rep_id} onChange={e => setF({ ...f, rep_id: e.target.value })}><option value="">{"—"}</option>{reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
    <Field label={t("Distributor")}><select value={f.distributor_id} onChange={e => setF({ ...f, distributor_id: e.target.value })}><option value="">{t("Company direct (no distributor)")}</option>{dists.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
    {cfg.settings.customFields.outlet.length > 0 && <CustomInputs defs={cfg.settings.customFields.outlet} value={f.custom} onChange={(c: any) => setF({ ...f, custom: c })} />}
    <label className="chk"><input type="checkbox" checked={f.active} onChange={e => setF({ ...f, active: e.target.checked })} />{t("Active")}</label>
    
    <button disabled={busy}>{shop ? t("Save") : t("Add outlet")}</button> <button type="button" className="ghost" onClick={done}>{t("Cancel")}</button><p className="err">{err}</p></form>;
}

export function ShopsMap({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [shops, setShops] = useState<any[]>([]); const [d, setD] = useState<any[]>([]); const [reps, setReps] = useState<any[]>([]);
  const [edit, setEdit] = useState<any | null | undefined>(undefined); const [q, setQ] = useState("");
  const mgr = ["company_admin", "manager"].includes(s.user.role), defs = cfg.settings.customFields.outlet;
  const load = () => api(s, "/api/shops").then(setShops);
  useEffect(() => { load(); if (mgr) { api(s, "/api/distributors").then(setD); api(s, "/api/reps").then(setReps); } }, []);
  const shown = shops.filter(x => !q || `${x.name} ${x.code} ${x.city ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return <><h2>{t("Outlets & distributor mapping")}</h2>
    {mgr && edit === undefined && <button className="sm" onClick={() => setEdit(null)}>{"+ " + t("Add outlet")}</button>}
    {mgr && edit !== undefined && <OutletForm s={s} cfg={cfg} shop={edit} reps={reps} dists={d} done={() => { setEdit(undefined); load(); }} />}
    {shops.length > 8 && <input placeholder={t("Search outlet name, code or city")} value={q} onChange={e => setQ(e.target.value)} />}
    {shown.map(x => <div className="row" key={x.id}><b>{x.name}</b> <span className="muted">{x.code} · {x.city}{x.active === false ? " · ✕" : ""}</span>
    <div className="muted">{cfg.settings.features.drugLicence && t("DL: {0} ", x.drug_licence || "—")}{defs.filter(f => x.custom?.[f.key] != null).map(f => `${f.label}: ${x.custom[f.key]}`).join(" · ")}</div>
    {mgr && <button className="sm ghost" onClick={() => setEdit(x)}>{t("Edit")}</button>}
    {mgr && <input className="sm-input" placeholder={t("Outlet type (e.g. Grocery)")} defaultValue={x.outlet_type ?? ""} onBlur={async e => { if (e.target.value !== (x.outlet_type ?? "")) { await api(s, `/api/shops/${x.id}/type`, { method: "PUT", body: JSON.stringify({ outletType: e.target.value }) }); load(); } }} />}
    {mgr && <select value={x.distributor_id ?? ""} onChange={async e => { await api(s, `/api/shops/${x.id}/distributor`, { method: "POST", body: JSON.stringify({ distributorId: e.target.value ? Number(e.target.value) : null }) }); load(); }}>
      <option value="">{t("Company direct (no distributor)")}</option>{d.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}</div>)}</>;
}

export function MyBeat({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [beats, setBeats] = useState<any[]>([]); const [visits, setVisits] = useState<any[]>([]); const [msg, setMsg] = useState(""); const [vc, setVc] = useState<Record<string, any>>({});
  const [flow, setFlow] = useState<any>(null); const [why, setWhy] = useState("");
  useEffect(() => { api(s, "/api/flow-settings").then(setFlow).catch(() => {}); }, []);
  const OV = "ff-open-visit", local = () => JSON.parse(localStorage.getItem(OV) || "null");
  const load = () => { api(s, "/api/beats").then(setBeats).catch(() => {}); api(s, "/api/visits").then(v => setVisits([...(local() ? [local()] : []), ...v])).catch(() => setVisits(local() ? [local()] : [])); };
  useEffect(load, []);
  // Offline visits: check-in is kept on the phone; check-out sends the whole visit (queued until online).
  const checkin = async (x: any, p: any) => {
    if (navigator.onLine) return api(s, "/api/visits/checkin", { method: "POST", body: JSON.stringify({ shopId: x.id, ...p }) });
    localStorage.setItem(OV, JSON.stringify({ id: "offline", offline: true, shop_id: x.id, shop_name: x.name, check_in_at: new Date().toISOString(), ...p, clientRef: `v${Date.now().toString(36)}` }));
  };
  const checkout = async (o: any, p: any) => {
    if (!o.offline) return api(s, `/api/visits/${o.id}/checkout`, { method: "POST", body: JSON.stringify({ ...p, custom: vc, noOrderReason: why || undefined }) });
    await api(s, "/api/visits/offline", { method: "POST", body: JSON.stringify({ clientRef: o.clientRef, shopId: o.shop_id, checkInAt: o.check_in_at, checkOutAt: new Date().toISOString(), lat: o.lat, lng: o.lng, outLat: p.lat, outLng: p.lng, custom: vc, noOrderReason: why || undefined }) });
    localStorage.removeItem(OV);
  };
  const open = visits.find(v => !v.check_out_at), gpsOn = cfg.settings.features.gps, vdefs = cfg.settings.customFields.visit;
  const act = async (fn: (p: { lat?: number; lng?: number }) => Promise<unknown>) => {
    try { let p = {}; if (gpsOn) { setMsg(t("Getting GPS…")); p = await gps(); } else p = await gps().catch(() => ({})); await fn(p); setMsg(""); setVc({}); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("My beat")}</h2>{beats.some(b => b.onLeaveToday) && <div className="banner">{t("🌴 You are on approved leave today. Visits are paused — enjoy your day off.")}</div>}{open && <div className="usage warn">{t("In visit:")}{" "}<b>{open.shop_name}</b> since {fmtDate(open.check_in_at, true).slice(11)}
      {cfg.settings.features.photos && !open.offline && <VisitPhotos s={s} visitId={open.id} canAdd />}
      {vdefs.length > 0 && <CustomInputs defs={vdefs} value={vc} onChange={setVc} />}
      {flow?.noOrderReasons?.length > 0 && <Field label={t("No order? Pick a reason")} help={t("Leave blank if you took an order in this visit.")}><select value={why} onChange={e => setWhy(e.target.value)}><option value="">{t("I took an order")}</option>{flow.noOrderReasons.map((r: string) => <option key={r} value={r}>{t(r)}</option>)}</select></Field>}
      <button className="sm" onClick={() => act(async p => { await checkout(open, p); setWhy(""); })}>{t("Check out")}</button></div>}
    {!beats.length && <Empty icon="🗺️" title={t("No beat assigned yet")} text={t("A beat is your list of outlets to visit. Ask your manager to assign one.")} />}
    {[...beats].sort((x, y) => Number(!!y.today) - Number(!!x.today)).map(b => <div key={b.id}><h3>{b.name} {b.today ? <span className="pill">{t("Today")}</span> : <span className="muted">{b.weekday != null ? t(DAYS[b.weekday]) : ""}</span>}</h3>{b.shops.map((x: any) => {
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
  const [must, setMust] = useState<string[]>([]);
  useEffect(() => { setMust([]); if (shopId) api(s, `/api/must-sell?shopId=${shopId}`).then(r => setMust(r.skus || [])).catch(() => {}); }, [shopId]);
  const [sug, setSug] = useState<any>(null); const [shelf, setShelf] = useState<Record<string, string>>({});
  const getSug = () => api(s, "/api/orders/suggest", { method: "POST", body: JSON.stringify({ shopId: Number(shopId) }) }).then(setSug).catch(e => toast(e.message, "err"));
  const useSug = () => { const nq = { ...qty }, nu = { ...unit };
    for (const l of sug.lines) { const n = Math.max(0, Math.ceil(l.avg - (Number(shelf[l.sku]) || 0))); const it = items.find(i => i.variants.some((v: any) => v.sku === l.sku)); if (!it) continue;
      const base = it.uoms.find((u: any) => u.factor === 1); if (base) nu[it.id] = base.code; nq[l.sku] = n ? String(n) : ""; }
    setUnit(nu); setQty(nq); setSug(null); toast(t("Suggested quantities added — check and edit before you place the order")); };
  const SugCard = () => !sug ? <button className="sm ghost" onClick={getSug}>💡 {t("Suggest order (last 3 orders)")}</button>
    : <div className="card"><b>💡 {t("Suggested order")}</b> <span className="muted small">{t("Average of the last {0} orders minus what is on the shelf.", sug.orders)}</span>
      {!sug.lines.length ? <p className="muted">{t("No past orders for this outlet yet.")}</p> : <>
        <div className="scroll"><table><thead><tr><th>{t("Product")}</th><th>{t("Average")}</th><th>{t("On shelf")}</th><th>{t("Suggested")}</th></tr></thead><tbody>
          {sug.lines.map((l: any) => <tr key={l.sku}><td>{l.name} <span className="muted small">{l.sku}</span></td><td>{l.avg}</td>
            <td><input inputMode="numeric" style={{ width: 70 }} value={shelf[l.sku] ?? ""} placeholder="0" onChange={e => setShelf({ ...shelf, [l.sku]: e.target.value.replace(/\D/g, "") })} /></td>
            <td><b>{Math.max(0, Math.ceil(l.avg - (Number(shelf[l.sku]) || 0)))}</b></td></tr>)}</tbody></table></div>
        <div className="row-btns"><button className="sm" onClick={useSug}>{t("Use these quantities")}</button><button className="sm ghost" onClick={() => setSug(null)}>{t("Close")}</button></div></>}</div>;
  const [ai, setAi] = useState<any>(null);
  useEffect(() => { setAi(null); if (shopId && step === "items" && navigator.onLine) api(s, "/api/ai/suggest", { method: "POST", body: JSON.stringify({ shopId: Number(shopId) }) }).then(setAi).catch(() => {}); }, [shopId, step]);
  const addAi = (ls: any[]) => { const nq = { ...qty }, nu = { ...unit };
    for (const l of ls) { const it = items.find(i => i.variants.some((v: any) => v.sku === l.sku)); if (!it) continue; const base = it.uoms.find((u: any) => u.factor === 1); if (base) nu[it.id] = base.code; nq[l.sku] = String(l.qty); }
    setUnit(nu); setQty(nq); toast(ls.length > 1 ? t("Added {0} suggested products", ls.length) : t("Added {0}", ls[0]?.name)); };
  const AiCard = () => { const ls = (ai?.lines || []).filter((l: any) => !(Number(qty[l.sku]) > 0)); if (!ls.length) return null;
    return <div className="card"><b>✨ {t("Suggested for this shop")}</b>
      {ls.map((l: any) => <div className="row" key={l.sku} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <div><b>{l.qty}</b> × {l.name} <span className="muted small">{l.sku}</span><br /><span className="muted small">{t(l.why.key, ...l.why.args)}{l.note ? " · " + t(l.note.key, ...l.note.args) : ""}</span></div>
        <button className="sm" onClick={() => addAi([l])} aria-label={t("Add")}>+ {t("Add")}</button></div>)}
      {ls.length > 1 && <div className="row-btns"><button className="sm ghost" onClick={() => addAi(ls)}>{t("Add all")}</button></div>}</div>; };
  const mustMissing = must.filter(k => !(Number(qty[k]) > 0));
  const MustBanner = () => must.length ? <div className={`banner ${mustMissing.length ? "warnb" : ""}`}>⭐ {mustMissing.length ? t("Must-sell not in this order yet: {0}", mustMissing.join(", ")) : t("All must-sell products are in this order")}</div> : null;
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
  const cell = (v: any) => <input inputMode="numeric" aria-label={t("Quantity {0}", v.sku)} className={`${Number(qty[v.sku]) > 0 ? "has" : ""} ${must.includes(v.sku) ? "must" : ""}`} value={qty[v.sku] || ""} placeholder="0" onChange={e => setQty({ ...qty, [v.sku]: e.target.value.replace(/\D/g, "").slice(0, 5) })} />;
  const shownTotal = pv ? pv.total : total;

  if (step === "done") return <div className="done-screen"><div className="big-ic">{result?.ok ? "✅" : "⚠️"}</div><h2>{result?.text}</h2>
    <p className="muted">{shop?.name}</p><button className="block" onClick={() => { setResult(null); setStep("shop"); setShopId(""); }}>{t("Take another order")}</button>
    {go && <button className="block ghost" onClick={() => go("orders")}>{t("See my orders")}</button>}</div>;

  if (step === "shop") {
    const list = shops.filter(x => !shopQ || `${x.name} ${x.code} ${x.city}`.toLowerCase().includes(shopQ.toLowerCase()));
    return <><Steps n={1} /><h2>{t("Which outlet is this order for?")}</h2>
      <input type="search" placeholder={t("Search outlet name, code or city")} value={shopQ} onChange={e => setShopQ(e.target.value)} />
      {!shops.length ? <Empty icon="🏪" title={t("No outlets yet")} text={t("Your administrator needs to upload outlets before you can take orders.")} />
        : list.map(x => <button key={x.id} className="pick" onClick={() => { setShopId(String(x.id)); setStep("items"); }}><b>{x.name}</b><span className="muted small">{[x.code, x.city].filter(Boolean).join(" · ")}</span>
          {x.approval_status === "pending" && <span className="pill placed">{t("Waiting for approval")}</span>}</button>)}</>;
  }

  if (step === "review") {
    const lines = pv?.lines || items.flatMap(i => i.variants.filter((v: any) => Number(qty[v.sku]) > 0).map((v: any) => ({ sku: v.sku, qty: Number(qty[v.sku]), uom: unitName(i), amount: Number(qty[v.sku]) * factor(i) * v.billing_price, name: `${i.name} ${attrText(v.attrs)}` })));
    const nameOf = (sku: string) => { for (const i of items) { const v = i.variants.find((x: any) => x.sku === sku); if (v) return `${i.name} ${attrText(v.attrs)}`.trim(); } return sku; };
    return <><Steps n={3} /><h2>{t("Review order")}</h2><p className="muted">{t("For")}{" "}<b>{shop?.name}</b> <button className="link" onClick={() => setStep("shop")}>change</button></p>
      {MustBanner()}
      <div className="review">{lines.map((l: any, k: number) => <div className="rline" key={k}><div><b>{nameOf(l.sku)}</b><div className="muted small">{l.qty} {l.uom}{l.free ? t(" · FREE") : ""}{l.scheme && !l.free ? t(" · offer: {0}", l.scheme) : ""}</div></div>
        <span>{l.free ? t("Free") : inr(l.amount)}</span></div>)}
        {pv?.savings > 0 && <div className="rline savings"><b>{t("You save")}</b><b>{inr(pv.savings)}</b></div>}
        <div className="rline total-line"><b>{t("Total (before GST)")}</b><b>{inr(shownTotal)}</b></div></div>
      {credit && !credit.ok && <div className={`banner ${credit.action === "block" ? "bad" : "warnb"}`}>{credit.action === "block" ? t("This outlet is on credit hold, so the order will be refused: ") : t("Heads-up: ")}{credit.reasons.join("; ")}</div>}
      {result && !result.ok && <p className="err">{result.text}</p>}
      <p className="muted small">{f.stock && t("Stock is checked when the order is sent. ")}{t("Offers are applied automatically.")}</p>
      <div className="cartbar"><button className="ghost" onClick={() => setStep("items")}>{t("← Edit")}</button><button disabled={busy} onClick={submit}>{busy ? t("Placing…") : t("Place order · {0}", inr0(shownTotal))}</button></div></>;
  }

  return <><Steps n={2} /><h2>{t("Add products")}</h2><p className="muted">{t("For")}{" "}<b>{shop?.name}</b> <button className="link" onClick={() => setStep("shop")}>change</button></p>{MustBanner()}{AiCard()}{SugCard()}
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

export const STATUS: Record<string, string> = { pending_approval: t("Waiting for approval"), placed: t("New"), accepted: t("Accepted"), dispatched: t("Dispatched"), fulfilled: t("Delivered"), rejected: t("Rejected"), cancelled: t("Cancelled"),
  edited: t("Edited"), approved: t("Approved"), partly_delivered: t("Part delivered"), "partly delivered": t("Part delivered") };
const History = ({ h }: { h: any[] }) => h?.length ? <details className="small"><summary className="muted">{t("History")}</summary>
  {h.map((e, i) => <div key={i} className="muted">{fmtDate(e.at, true)} · {STATUS[e.status] || e.status}{e.by ? ` · ${e.by}` : ""}{e.note ? ` · ${e.note}` : ""}</div>)}</details> : null;
/** Quantity editor shared by "Change quantities" (rep, while new) and "Part delivered" (distributor). */
const QtyEdit = ({ o, title, onSave, onClose }: { o: any; title: string; onSave: (q: Record<number, number>) => void; onClose: () => void }) => {
  const [q, setQ] = useState<Record<number, number>>(Object.fromEntries(o.lines.filter((l: any) => !l.free).map((l: any) => [l.id, l.qty])));
  return <div className="box">{o.lines.filter((l: any) => !l.free).map((l: any) => <label className="fld" key={l.id}><span>{l.item_name} {attrText(l.attrs)} ({l.uom})</span>
    <input type="number" min={0} inputMode="numeric" value={q[l.id]} onChange={e => setQ({ ...q, [l.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>)}
    <button className="sm" onClick={() => onSave(q)}>{title}</button> <button className="sm ghost" onClick={onClose}>{t("Close")}</button></div>;
};
export function Bell({ s, go }: { s: Session; go: (t: string) => void }) {
  const [rows, setRows] = useState<any[]>([]); const [open, setOpen] = useState(false);
  const load = () => api(s, "/api/notifications").then(setRows).catch(() => {});
  useEffect(() => { load(); const h = setInterval(load, 60000); return () => clearInterval(h); }, []);
  const unread = rows.filter(r => !r.read_at).length;
  const toggle = () => { setOpen(!open); if (!open && unread) api(s, "/api/notifications/read", { method: "POST", body: "{}" }).then(load).catch(() => {}); };
  return <span className="bell"><button className="sm ghost" aria-label={t("Updates")} onClick={toggle}>🔔{unread > 0 && <b className="badge">{unread}</b>}</button>
    {open && <div className="bell-list">{!rows.length ? <p className="muted small">{t("No updates yet")}</p> : rows.map(r => <div key={r.id} className={`row small ${r.read_at ? "" : "unread"}`}
      onClick={() => { setOpen(false); if (r.link) go(r.link.split("#")[0]); }}>{t(r.template, ...r.args.map((a: any) => typeof a === "string" ? (STATUS[a] || a) : a))}{r.note ? ` — ${r.note}` : ""}<div className="muted">{fmtDate(r.created_at, true)}</div></div>)}</div>}</span>;
}
const OrderCard = ({ o, children }: { o: any; children?: any }) => <div className="row"><b>#{o.id} {o.shop_name}</b> <span className={`pill ${o.status}`}>{STATUS[o.status] || o.status}</span>{o.partial && <span className="pill">{t("Part delivered")}</span>}{o.placed_by_role === "retailer" && <span className="pill">{t("🏪 From the shop")}</span>}
  {o.status_reason && ["rejected", "cancelled"].includes(o.status) && <div className="muted small">{t("Reason: {0}", o.status_reason)}</div>}
  <div className="muted">{o.placed_by || o.rep_name} · {fmtDate(o.created_at, true)} · {inr(o.total)}{Number(o.savings) > 0 ? t(" · saved {0}", inr(o.savings)) : ""}</div>
  {o.lines.map((l: any) => <div className="muted small" key={l.id}>{l.item_name} {attrText(l.attrs)} — {l.ordered_qty != null && l.ordered_qty !== l.qty ? t("{0} (ordered {1})", l.qty, l.ordered_qty) : l.qty} {l.uom}{l.free ? t(" FREE ({0})", l.scheme) : l.discount_pct > 0 ? ` (−${l.discount_pct}%${l.scheme ? ` ${l.scheme}` : ""})` : ""} = {inr(l.amount)}
    {l.allocations?.length > 0 && <span className="batches" title={t("Batches picked, nearest expiry first")}> {l.allocations.map((a: any) => `${a.batch_no || "stock"}${a.expiry ? ` exp ${fmtDate(a.expiry)}` : ""} ×${a.qty}`).join("; ")}</span>}</div>)}{children}<History h={o.history} /></div>;

export function Orders({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/orders").then(setRows); useEffect(() => { load(); }, []);
  const mgr = ["company_admin", "manager"].includes(s.user.role), admin = s.user.role === "company_admin";
  const go = async (fn: () => Promise<any>) => { try { await fn(); setMsg(""); setEdit(0); load(); } catch (e: any) { setMsg(e.message); } };
  const [edit, setEdit] = useState(0);
  // Company-direct orders (no distributor) are accepted and delivered here by an admin or the rep's manager.
  const move = (o: any, status: string, reason?: string) => go(() => api(s, `/api/orders/${o.id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) }));
  const canEdit = (o: any) => ["placed", "pending_approval"].includes(o.status) && (mgr || s.user.role === "retailer" || o.rep_id === s.user.id);
  const save = (o: any, q: Record<number, number>) => go(() => api(s, `/api/orders/${o.id}`, { method: "PUT", body: JSON.stringify({ lines: o.lines.filter((l: any) => !l.free).map((l: any) => ({ variantId: l.variant_id, uom: l.uom, qty: q[l.id] })) }) }));
  return <><h2>{t("Orders")}</h2>{!rows.length && <Empty icon="📦" title={t("No orders yet")} text={s.user.role === "sales_rep" ? t("Orders you take will show here.") : t("Orders from your sales reps will appear here as soon as they're placed.")} />}{rows.map(o => <OrderCard key={o.id} o={o}>
    {(admin || (mgr && !o.distributor_id)) && o.status === "placed" && <button className="sm" onClick={() => move(o, "accepted")}>{t("Accept")}</button>}
    {mgr && !o.distributor_id && o.status === "placed" && <button className="sm ghost" onClick={() => { const r = prompt(t("Why reject this order?")); if (r !== null) move(o, "rejected", r); }}>{t("Reject")}</button>}
    {mgr && !o.distributor_id && o.status === "accepted" && <button className="sm" onClick={() => move(o, "dispatched")}>{t("Out for delivery")}</button>}
    {mgr && !o.distributor_id && ["accepted", "dispatched"].includes(o.status) && <button className="sm" onClick={() => move(o, "fulfilled")}>{t("Mark delivered")}</button>}
    {mgr && cfg.settings.features.invoicing && ["accepted", "fulfilled"].includes(o.status) && !(cfg.settings.features.distributorBilling && o.distributor_id && !o.invoice) && (o.invoice
      ? <button className="sm ghost" onClick={() => openPrint(s, o.invoice.id).catch(e => setMsg(e.message))}>{t("Print")}{" "}{o.invoice.number}</button>
      : <button className="sm" onClick={() => go(() => api(s, `/api/orders/${o.id}/invoice`, { method: "POST", body: "{}" }))}>{t("Create GST invoice")}</button>)}
    {mgr && o.status === "pending_approval" && <><button className="sm" onClick={() => go(() => api(s, `/api/orders/${o.id}/approve`, { method: "POST", body: "{}" }))}>{t("Approve")}</button> <button className="sm ghost" onClick={() => { const reason = prompt(t("Why reject this order?")); if (reason !== null) go(() => api(s, `/api/orders/${o.id}/approve`, { method: "POST", body: JSON.stringify({ decision: "reject", reason }) })); }}>{t("Reject")}</button> </>}
    {canEdit(o) && edit !== o.id && <button className="sm ghost" onClick={() => setEdit(o.id)}>{t("Change quantities")}</button>}
    {edit === o.id && <QtyEdit o={o} title={t("Save changes")} onSave={q => save(o, q)} onClose={() => setEdit(0)} />}
    {(["placed", "pending_approval"].includes(o.status) || (mgr && ["accepted", "dispatched"].includes(o.status) && !o.invoice)) && <button className="sm ghost" onClick={() => { const reason = prompt(t("Why cancel this order?")); if (reason?.trim()) go(() => api(s, `/api/orders/${o.id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) })); }}>{t("Cancel order")}</button>}
  </OrderCard>)}<p className="err">{msg}</p></>;
}

export function Inbox({ s, cfg }: { s: Session; cfg: Cfg }) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/orders").then(setRows); useEffect(() => { load(); }, []);
  const set = async (id: number, status: string, reason?: string) => { try { await api(s, `/api/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status, reason }) }); load(); } catch (e: any) { setMsg(e.message); } };
  const [part, setPart] = useState(0);
  const partial = async (o: any, q: Record<number, number>) => { const reason = prompt(t("Why was less delivered? (optional)")) ?? ""; try { await api(s, `/api/orders/${o.id}/status`, { method: "POST", body: JSON.stringify({ status: "fulfilled", reason, lines: Object.entries(q).map(([id, qty]) => ({ id: Number(id), qty })) }) }); setPart(0); load(); } catch (e: any) { setMsg(e.message); } };
  const cancel = async (id: number) => { const reason = prompt(t("Why cancel this order?")); if (!reason?.trim()) return; try { await api(s, `/api/orders/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }); load(); } catch (e: any) { setMsg(e.message); } };
  return <><h2>{t("Order inbox")}</h2>{!rows.length && <Empty icon="📥" title={t("No orders for you yet")} text={t("When a sales rep takes an order at one of your outlets, it lands here for you to accept.")} />}
    {rows.map(o => <OrderCard key={o.id} o={o}>
      {o.status === "placed" && <><button className="sm" onClick={() => set(o.id, "accepted")}>{t("Accept")}</button> <button className="sm ghost" onClick={() => { const r = prompt(t("Why reject this order?")); if (r !== null) set(o.id, "rejected", r); }}>{t("Reject")}</button></>}
      {o.status === "accepted" && <><button className="sm" onClick={() => set(o.id, "dispatched")}>{t("Out for delivery")}</button> </>}
      {["accepted", "dispatched"].includes(o.status) && <><button className="sm" onClick={() => set(o.id, "fulfilled")}>{t("Mark delivered")}</button> {!o.invoice && <button className="sm ghost" onClick={() => setPart(o.id)}>{t("Part delivered")}</button>}{!o.invoice && <> <button className="sm ghost" onClick={() => cancel(o.id)}>{t("Cancel order")}</button></>}</>}
      {part === o.id && <QtyEdit o={o} title={t("Save delivered quantities")} onSave={q => partial(o, q)} onClose={() => setPart(0)} />}
      {cfg?.settings.features.invoicing && cfg.settings.features.distributorBilling && ["accepted", "fulfilled"].includes(o.status) && (o.invoice
        ? <button className="sm ghost" onClick={() => openPrint(s, o.invoice.id).catch(e => setMsg(e.message))}>{t("Print")}{" "}{o.invoice.number}</button>
        : <button className="sm ghost" onClick={async () => { try { await api(s, `/api/orders/${o.id}/invoice`, { method: "POST", body: "{}" }); load(); } catch (e: any) { setMsg(e.message); } }}>{t("Create GST invoice")}</button>)}</OrderCard>)}<p className="err">{msg}</p></>;
}
