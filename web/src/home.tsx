// Role-based home screens with big task tiles, and the admin first-time setup checklist.
import React, { useEffect, useState } from "react";
import { api, type ViewProps } from "./main";
import { t } from "./i18n";
import { DayCard } from "./phase3";
import { inr0, today, Loading, Term } from "./ui";

const Tile = ({ icon, title, text, badge, onClick, tone }: { icon: string; title: string; text?: string; badge?: string | number | null; onClick: () => void; tone?: "accent" | "warn" }) =>
  <button className={`tile ${tone || ""}`} onClick={onClick}><span className="tile-ic" aria-hidden>{icon}</span><span className="tile-t">{title}</span>{text && <span className="tile-s">{text}</span>}
    {badge != null && badge !== 0 && badge !== "" && <span className="badge">{badge}</span>}</button>;
const safe = (p: Promise<any>, d: any) => p.catch(() => d);
const hello = (name: string) => { const h = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date())); return `${h < 12 ? t("Good morning") : h < 17 ? t("Good afternoon") : t("Good evening")}, ${name.split(" ")[0]}`; };

export function RepHome({ s, cfg, go }: ViewProps) {
  const f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/beats"), []), safe(api(s, "/api/visits"), []), f.invoicing ? safe(api(s, "/api/outstanding"), []) : [], f.incentives ? safe(api(s, "/api/incentives"), []) : []]).then(([beats, visits, out, inc]) => {
    const t = today(), stops = beats.reduce((a: number, b: any) => a + b.shops.length, 0);
    const done = new Set(visits.filter((v: any) => v.check_out_at && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(v.check_in_at)) === t).map((v: any) => v.shop_id)).size;
    setD({ stops, done, open: visits.find((v: any) => !v.check_out_at), due: out.reduce((a: number, r: any) => a + r.outstanding, 0), earned: inc[0]?.total ?? 0, next: inc[0]?.lines.find((l: any) => l.next)?.next });
  }); }, []);
  if (!d) return <Loading />;
  return <><h2 className="hello">{hello(s.user.name)}</h2>
    <p className="muted">{d.stops ? t("{0} of {1} outlets visited today", d.done, d.stops) : t("No beat assigned yet — ask your manager to assign one.")}</p>
    {f.incentives && <button className="earn-card" onClick={() => go("incentives")}><span>{t("🏆 Earned this month")}</span><b>{inr0(d.earned)}</b>{d.next && <span className="small">{t("Reach")}{" "}{d.next.minPct}{t("% of target to earn")}{" "}{inr0(d.next.amount)}</span>}</button>}
    <DayCard s={s} />
    {d.open && <div className="banner">{t("You are in a visit at")}{" "}<b>{d.open.shop_name}</b>. <button className="sm" onClick={() => go("beat")}>{t("Continue visit")}</button></div>}
    <div className="tiles">
      <Tile icon="🗺️" title={t("Today's beat")} text={d.stops ? t("{0} outlets left", d.stops - d.done) : t("Not assigned")} onClick={() => go("beat")} />
      <Tile icon="📍" title={t("Start visit")} text={t("Check in at an outlet")} onClick={() => go("beat")} tone="accent" />
      <Tile icon="🛒" title={t("New order")} text={t("Take an order")} onClick={() => go("order")} tone="accent" />
      {f.invoicing && <Tile icon="💰" title={t("Collect payment")} text={d.due > 0 ? t("{0} due", inr0(d.due)) : t("Nothing due")} onClick={() => go("collect")} />}
      {f.audits && d.open && <Tile icon="✅" title={t("Store check")} text={t("Fill the checklist for this outlet")} onClick={() => go("audit")} />}
      <Tile icon="🎯" title={t("My targets")} text={t("This month's progress")} onClick={() => go("targets")} />
      <Tile icon="📦" title={t("My orders")} text={t("Orders you placed")} onClick={() => go("orders")} />
      {f.expenses && <Tile icon="🧾" title={t("My expenses")} text={t("Claim travel, food and other costs")} onClick={() => go("myexpenses")} />}
      {f.leave && <Tile icon="🌴" title={t("My leave")} text={t("Apply for a day off")} onClick={() => go("myleave")} />}
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
      <Tile icon="📥" title={t("New orders")} text={d.placed ? t("{0} waiting for you", d.placed) : t("All caught up")} badge={d.placed} onClick={() => go("inbox")} tone={d.placed ? "warn" : undefined} />
      {f.invoicing && f.distributorBilling && <Tile icon="🧾" title={t("Invoices")} text={d.toBill ? t("{0} orders to bill", d.toBill) : t("Bills you issued")} badge={d.toBill} onClick={() => go(d.toBill ? "inbox" : "invoices")} />}
      {f.stock && <Tile icon="🏬" title={t("Stock")} text={t("What you have on hand")} onClick={() => go("stock")} />}
      {f.invoicing && f.distributorBilling && <Tile icon="💰" title={t("Collections")} text={d.due > 0 ? t("{0} to collect", inr0(d.due)) : t("Nothing due")} onClick={() => go("collections")} />}
      {f.purchaseOrders && <Tile icon="📋" title={t("Purchase orders")} text={d.po ? t("{0} open", d.po) : t("Order stock from the company")} onClick={() => go("POs")} />}
      <Tile icon="🪪" title={t("My profile")} text={t("GST details & terms")} onClick={() => go("profile")} />
    </div></>;
}

/** Admin-only banner when the server's free disk drops below the alert level (default 15%). */
export function DiskAlert({ s }: { s: any }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { safe(api(s, "/api/system/disk"), null).then(setD); }, []);
  return d?.low ? <div className="banner bad" role="alert">⚠️ {t("Low disk space on the server: only {0}% free. Delete old files or move photos to S3 storage (see README).", d.freePct)}</div> : null;
}

export function ManagerHome(p: ViewProps) {
  const { s, cfg, go } = p, f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/dashboard?days=1"), []), safe(api(s, "/api/orders"), []), f.purchaseOrders ? safe(api(s, "/api/pos"), []) : [], f.invoicing ? safe(api(s, "/api/outstanding"), []) : []]).then(([dash, o, po, out]) =>
    setD({ visits: dash.reduce((a: number, r: any) => a + r.visits, 0), orders: dash.reduce((a: number, r: any) => a + r.orders, 0), value: dash.reduce((a: number, r: any) => a + r.value, 0),
      approve: o.filter((x: any) => x.status === "placed" && !x.distributor_id).length, pos: po.filter((x: any) => ["submitted", "approved", "partially_dispatched"].includes(x.status)).length,
      due: out.reduce((a: number, r: any) => a + r.outstanding, 0), overdue: out.reduce((a: number, r: any) => a + r.overdue, 0) })); }, []);
  return <>{s.user.role === "company_admin" && <><DiskAlert s={s} /><SetupChecklist {...p} /></>}
    <h2 className="hello">{hello(s.user.name)}</h2>
    {!d ? <Loading /> : <>
      <h3>{t("Today")}</h3>
      <div className="kpis"><button onClick={() => go("visits")}><b>{d.visits}</b>{t("Visits")}</button><button onClick={() => go("orders")}><b>{d.orders}</b>{t("Orders")}</button><button onClick={() => go("dashboard")}><b>{inr0(d.value)}</b>{t("Order value")}</button>
        {f.invoicing && <button onClick={() => go("collections")}><b>{inr0(d.due)}</b>{t("Outstanding")}{d.overdue > 0 && <em className="err"> {inr0(d.overdue)} overdue</em>}</button>}</div>
      <h3>{t("Approvals pending")}</h3>
      <div className="tiles">
        <Tile icon="📦" title={t("Orders to accept")} text={d.approve ? t("{0} company orders waiting", d.approve) : t("Nothing waiting")} badge={d.approve} tone={d.approve ? "warn" : undefined} onClick={() => go("orders")} />
        {f.purchaseOrders && <Tile icon="📋" title={t("Purchase orders")} text={d.pos ? t("{0} to approve or dispatch", d.pos) : t("Nothing waiting")} badge={d.pos} tone={d.pos ? "warn" : undefined} onClick={() => go("POs")} />}
      </div>
      <h3>{t("Shortcuts")}</h3>
      <div className="tiles">
        <Tile icon="📈" title={t("Reports")} text={t("Download Excel / CSV")} onClick={() => go("reports")} />
        <Tile icon="📊" title={t("Team activity")} text={t("Visits & orders by rep")} onClick={() => go("dashboard")} />
        {f.invoicing && <Tile icon="🧾" title={t("Invoices")} text={t("GST invoices & credit notes")} onClick={() => go("invoices")} />}
        <Tile icon="⚙️" title={t("Setup")} text={t("Products, outlets, users, settings")} onClick={() => go(s.user.role === "company_admin" ? "settings" : "catalog")} />
      </div></>}</>;
}

export function SetupChecklist({ s, cfg, go }: ViewProps) {
  const [c, setC] = useState<any>(null); const [hide, setHide] = useState(() => localStorage.getItem("ff-setup-hidden") === "1");
  useEffect(() => { Promise.all([safe(api(s, "/api/items"), []), safe(api(s, "/api/shops"), []), safe(api(s, "/api/users"), []), safe(api(s, "/api/beats"), [])]).then(([i, sh, u, b]) => setC({ i, sh, u, b })); }, []);
  if (!c) return null;
  const g = cfg.settings.gst || {};
  const steps = [
    { done: !!(g.gstin && g.legalName && g.stateCode), title: t("Add company GST details"), text: <>{t("Legal name,")}{" "}<Term k="GSTIN" />{t(", state, address")}</>, tab: "settings", btn: t("Open settings") },
    { done: c.i.length > 0, title: t("Upload products"), text: t("Excel/CSV with codes, prices, sizes or packs"), tab: "import", btn: t("Upload products") },
    { done: c.sh.length > 0, title: t("Upload shops / outlets"), text: t("The outlets your reps visit"), tab: "import", btn: t("Upload outlets") },
    { done: c.u.length > 1, title: t("Add users"), text: t("Sales reps, managers, distributors"), tab: "import", btn: t("Add users") },
    { done: c.b.some((b: any) => b.rep_id), title: t("Assign beats"), text: <>{t("Give each rep a")}{" "}<Term k="Beat">{t("beat")}</Term> {t("(route of outlets)")}</>, tab: "beats", btn: t("Plan beats") },
  ];
  const n = steps.filter(x => x.done).length, pct = Math.round(n / steps.length * 100);
  if (n === steps.length && hide) return null;
  return <div className="checklist">
    <div className="cl-h"><b>{n === steps.length ? t("Setup complete 🎉") : t("Get started")}</b><span className="muted small">{n} of {steps.length} done</span>
      {n === steps.length && <button className="ghost sm" onClick={() => { localStorage.setItem("ff-setup-hidden", "1"); setHide(true); }}>{t("Hide")}</button>}</div>
    <div className="bar big"><span style={{ width: `${pct}%` }} /></div>
    {steps.map((x, i) => <div key={i} className={`step ${x.done ? "done" : ""}`}><span className="dot">{x.done ? "✓" : i + 1}</span><div><b>{x.title}</b><div className="muted small">{x.text}</div></div>
      {!x.done && <button className="sm" onClick={() => go(x.tab)}>{x.btn}</button>}</div>)}</div>;
}
