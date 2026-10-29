// Role-based home screens with big task tiles, and the admin first-time setup checklist.
import React, { useEffect, useState } from "react";
import { api, type ViewProps } from "./main";
import { inr0, today, Loading, Term } from "./ui";

const Tile = ({ icon, title, text, badge, onClick, tone }: { icon: string; title: string; text?: string; badge?: string | number | null; onClick: () => void; tone?: "accent" | "warn" }) =>
  <button className={`tile ${tone || ""}`} onClick={onClick}><span className="tile-ic" aria-hidden>{icon}</span><span className="tile-t">{title}</span>{text && <span className="tile-s">{text}</span>}
    {badge != null && badge !== 0 && badge !== "" && <span className="badge">{badge}</span>}</button>;
const safe = (p: Promise<any>, d: any) => p.catch(() => d);
const hello = (name: string) => { const h = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date())); return `${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}, ${name.split(" ")[0]}`; };

export function RepHome({ s, cfg, go }: ViewProps) {
  const f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/beats"), []), safe(api(s, "/api/visits"), []), f.invoicing ? safe(api(s, "/api/outstanding"), []) : []]).then(([beats, visits, out]) => {
    const t = today(), stops = beats.reduce((a: number, b: any) => a + b.shops.length, 0);
    const done = new Set(visits.filter((v: any) => v.check_out_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(v.check_in_at)) === t).map((v: any) => v.shop_id)).size;
    setD({ stops, done, open: visits.find((v: any) => !v.check_out_at), due: out.reduce((a: number, r: any) => a + r.outstanding, 0) });
  }); }, []);
  if (!d) return <Loading />;
  return <><h2 className="hello">{hello(s.user.name)}</h2>
    <p className="muted">{d.stops ? `${d.done} of ${d.stops} outlets visited today` : "No beat assigned yet — ask your manager to assign one."}</p>
    {d.open && <div className="banner">You are in a visit at <b>{d.open.shop_name}</b>. <button className="sm" onClick={() => go("beat")}>Continue visit</button></div>}
    <div className="tiles">
      <Tile icon="🗺️" title="Today's beat" text={d.stops ? `${d.stops - d.done} outlets left` : "Not assigned"} onClick={() => go("beat")} />
      <Tile icon="📍" title="Start visit" text="Check in at an outlet" onClick={() => go("beat")} tone="accent" />
      <Tile icon="🛒" title="New order" text="Take an order" onClick={() => go("order")} tone="accent" />
      {f.invoicing && <Tile icon="💰" title="Collect payment" text={d.due > 0 ? `${inr0(d.due)} due` : "Nothing due"} onClick={() => go("collect")} />}
      {f.audits && d.open && <Tile icon="✅" title="Store check" text="Fill the checklist for this outlet" onClick={() => go("audit")} />}
      <Tile icon="🎯" title="My targets" text="This month's progress" onClick={() => go("targets")} />
      <Tile icon="📦" title="My orders" text="Orders you placed" onClick={() => go("orders")} />
      {f.expenses && <Tile icon="🧾" title="My expenses" text="Claim travel, food and other costs" onClick={() => go("myexpenses")} />}
      {f.leave && <Tile icon="🌴" title="My leave" text="Apply for a day off" onClick={() => go("myleave")} />}
    </div></>;
}

export function DistributorHome({ s, cfg, go }: ViewProps) {
  const f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/orders"), []), f.purchaseOrders ? safe(api(s, "/api/pos"), []) : [], f.invoicing && f.distributorBilling ? safe(api(s, "/api/outstanding"), []) : []]).then(([o, p, out]) =>
    setD({ placed: o.filter((x: any) => x.status === "placed").length, toBill: o.filter((x: any) => ["accepted", "fulfilled"].includes(x.status) && !x.invoice).length,
      po: p.filter((x: any) => ["draft", "approved", "partially_dispatched", "dispatched"].includes(x.status)).length, due: out.reduce((a: number, r: any) => a + r.outstanding, 0) })); }, []);
  if (!d) return <Loading />;
  return <><h2 className="hello">{hello(s.user.name)}</h2>
    <div className="tiles">
      <Tile icon="📥" title="New orders" text={d.placed ? `${d.placed} waiting for you` : "All caught up"} badge={d.placed} onClick={() => go("inbox")} tone={d.placed ? "warn" : undefined} />
      {f.invoicing && f.distributorBilling && <Tile icon="🧾" title="Invoices" text={d.toBill ? `${d.toBill} orders to bill` : "Bills you issued"} badge={d.toBill} onClick={() => go(d.toBill ? "inbox" : "invoices")} />}
      {f.stock && <Tile icon="🏬" title="Stock" text="What you have on hand" onClick={() => go("stock")} />}
      {f.invoicing && f.distributorBilling && <Tile icon="💰" title="Collections" text={d.due > 0 ? `${inr0(d.due)} to collect` : "Nothing due"} onClick={() => go("collections")} />}
      {f.purchaseOrders && <Tile icon="📋" title="Purchase orders" text={d.po ? `${d.po} open` : "Order stock from the company"} onClick={() => go("POs")} />}
      <Tile icon="🪪" title="My profile" text="GST details & terms" onClick={() => go("profile")} />
    </div></>;
}

export function ManagerHome(p: ViewProps) {
  const { s, cfg, go } = p, f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/dashboard?days=1"), []), safe(api(s, "/api/orders"), []), f.purchaseOrders ? safe(api(s, "/api/pos"), []) : [], f.invoicing ? safe(api(s, "/api/outstanding"), []) : []]).then(([dash, o, po, out]) =>
    setD({ visits: dash.reduce((a: number, r: any) => a + r.visits, 0), orders: dash.reduce((a: number, r: any) => a + r.orders, 0), value: dash.reduce((a: number, r: any) => a + r.value, 0),
      approve: o.filter((x: any) => x.status === "placed" && !x.distributor_id).length, pos: po.filter((x: any) => ["submitted", "approved", "partially_dispatched"].includes(x.status)).length,
      due: out.reduce((a: number, r: any) => a + r.outstanding, 0), overdue: out.reduce((a: number, r: any) => a + r.overdue, 0) })); }, []);
  return <>{s.user.role === "company_admin" && <SetupChecklist {...p} />}
    <h2 className="hello">{hello(s.user.name)}</h2>
    {!d ? <Loading /> : <>
      <h3>Today</h3>
      <div className="kpis"><button onClick={() => go("visits")}><b>{d.visits}</b>Visits</button><button onClick={() => go("orders")}><b>{d.orders}</b>Orders</button><button onClick={() => go("dashboard")}><b>{inr0(d.value)}</b>Order value</button>
        {f.invoicing && <button onClick={() => go("collections")}><b>{inr0(d.due)}</b>Outstanding{d.overdue > 0 && <em className="err"> {inr0(d.overdue)} overdue</em>}</button>}</div>
      <h3>Approvals pending</h3>
      <div className="tiles">
        <Tile icon="📦" title="Orders to accept" text={d.approve ? `${d.approve} company orders waiting` : "Nothing waiting"} badge={d.approve} tone={d.approve ? "warn" : undefined} onClick={() => go("orders")} />
        {f.purchaseOrders && <Tile icon="📋" title={"Purchase orders"} text={d.pos ? `${d.pos} to approve or dispatch` : "Nothing waiting"} badge={d.pos} tone={d.pos ? "warn" : undefined} onClick={() => go("POs")} />}
      </div>
      <h3>Shortcuts</h3>
      <div className="tiles">
        <Tile icon="📈" title="Reports" text="Download Excel / CSV" onClick={() => go("reports")} />
        <Tile icon="📊" title="Team activity" text="Visits & orders by rep" onClick={() => go("dashboard")} />
        {f.invoicing && <Tile icon="🧾" title="Invoices" text="GST invoices & credit notes" onClick={() => go("invoices")} />}
        <Tile icon="⚙️" title="Setup" text="Products, outlets, users, settings" onClick={() => go(s.user.role === "company_admin" ? "settings" : "catalog")} />
      </div></>}</>;
}

export function SetupChecklist({ s, cfg, go }: ViewProps) {
  const [c, setC] = useState<any>(null); const [hide, setHide] = useState(() => localStorage.getItem("ff-setup-hidden") === "1");
  useEffect(() => { Promise.all([safe(api(s, "/api/items"), []), safe(api(s, "/api/shops"), []), safe(api(s, "/api/users"), []), safe(api(s, "/api/beats"), [])]).then(([i, sh, u, b]) => setC({ i, sh, u, b })); }, []);
  if (!c) return null;
  const g = cfg.settings.gst || {};
  const steps = [
    { done: !!(g.gstin && g.legalName && g.stateCode), title: "Add company GST details", text: <>Legal name, <Term k="GSTIN" />, state, address</>, tab: "settings", btn: "Open settings" },
    { done: c.i.length > 0, title: "Upload products", text: "Excel/CSV with codes, prices, sizes or packs", tab: "import", btn: "Upload products" },
    { done: c.sh.length > 0, title: "Upload shops / outlets", text: "The outlets your reps visit", tab: "import", btn: "Upload outlets" },
    { done: c.u.length > 1, title: "Add users", text: "Sales reps, managers, distributors", tab: "import", btn: "Add users" },
    { done: c.b.some((b: any) => b.rep_id), title: "Assign beats", text: <>Give each rep a <Term k="Beat">beat</Term> (route of outlets)</>, tab: "beats", btn: "Plan beats" },
  ];
  const n = steps.filter(x => x.done).length, pct = Math.round(n / steps.length * 100);
  if (n === steps.length && hide) return null;
  return <div className="checklist">
    <div className="cl-h"><b>{n === steps.length ? "Setup complete 🎉" : "Get started"}</b><span className="muted small">{n} of {steps.length} done</span>
      {n === steps.length && <button className="ghost sm" onClick={() => { localStorage.setItem("ff-setup-hidden", "1"); setHide(true); }}>Hide</button>}</div>
    <div className="bar big"><span style={{ width: `${pct}%` }} /></div>
    {steps.map((x, i) => <div key={i} className={`step ${x.done ? "done" : ""}`}><span className="dot">{x.done ? "✓" : i + 1}</span><div><b>{x.title}</b><div className="muted small">{x.text}</div></div>
      {!x.done && <button className="sm" onClick={() => go(x.tab)}>{x.btn}</button>}</div>)}</div>;
}
