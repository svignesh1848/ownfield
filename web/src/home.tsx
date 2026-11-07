// Role-based home screens with big task tiles, and the admin first-time setup checklist.
import React, { useEffect, useState } from "react";
import { api, type ViewProps } from "./main";
import { t } from "./i18n";
import { DayCard } from "./phase3";
import { inr0, today, Loading, Term, Icon } from "./ui";
import { DayBars, HBars, Progress } from "./charts";

const safe = (p: Promise<any>, d: any) => p.catch(() => d);
const hello = (name: string) => { const h = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date())); return `${h < 12 ? t("Good morning") : h < 17 ? t("Good afternoon") : t("Good evening")}, ${name.split(" ")[0]}`; };

const istDay = (v: any) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(v));
const longDate = () => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }).format(new Date());
/** KPI card: icon, label, big value, small context line. */
export const Kpi = ({ icon, label, value, sub, onClick, tone }: { icon: string; label: string; value: React.ReactNode; sub?: React.ReactNode; onClick?: () => void; tone?: "warn" | "bad" }) =>
  <button type="button" className={`kpi ${tone || ""}`} onClick={onClick} disabled={!onClick}>
    <span className="kpi-h"><span className="kpi-ic"><Icon name={icon} size={18} /></span>{label}</span>
    <b className="kpi-v num">{value}</b>{sub && <span className="kpi-s">{sub}</span>}</button>;
/** Compact action row with icon, title, one-line hint and a chevron. */
const Action = ({ icon, title, text, onClick, badge, primary }: { icon: string; title: string; text?: string; onClick: () => void; badge?: number; primary?: boolean }) =>
  <button type="button" className={`act ${primary ? "primary" : ""}`} onClick={onClick}>
    <span className="act-ic"><Icon name={icon} size={20} /></span><span className="act-t"><b>{title}</b>{text && <span>{text}</span>}</span>
    {!!badge && <span className="count">{badge}</span>}<Icon name="chev" size={18} className="chev" /></button>;

export function RepHome({ s, cfg, go }: ViewProps) {
  const f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/beats"), []), safe(api(s, "/api/visits"), []), f.invoicing ? safe(api(s, "/api/outstanding"), []) : [], f.incentives ? safe(api(s, "/api/incentives"), []) : [], safe(api(s, "/api/orders"), [])]).then(([beats, visits, out, inc, orders]) => {
    const t = today(), stops = beats.reduce((a: number, b: any) => a + b.shops.length, 0);
    const done = new Set(visits.filter((v: any) => v.check_out_at && istDay(v.check_in_at) === t).map((v: any) => v.shop_id)).size;
    const mine = orders.filter((o: any) => istDay(o.created_at) === t && !["rejected", "cancelled"].includes(o.status));
    setD({ stops, done, open: visits.find((v: any) => !v.check_out_at), due: out.reduce((a: number, r: any) => a + r.outstanding, 0), earned: inc[0]?.total ?? 0, next: inc[0]?.lines.find((l: any) => l.next)?.next,
      orders: mine.length, value: mine.reduce((a: number, o: any) => a + Number(o.total || 0), 0) });
  }); }, []);
  if (!d) return <Loading />;
  return <div className="home">
    <div className="page-h"><div><h2 className="hello">{hello(s.user.name)}</h2><p className="muted small">{longDate()}</p></div></div>
    {d.open ? <div className="hero-card live"><span className="eyebrow"><span className="pulse" />{t("Visit in progress")}</span><b>{d.open.shop_name}</b>
        <p>{t("Take the order, then check out before moving to the next shop.")}</p><button onClick={() => go("beat")}>{t("Continue visit")}</button></div>
      : <div className="hero-card"><span className="eyebrow">{t("Today's beat")}</span>
        <b>{d.stops ? t("{0} of {1} outlets visited", d.done, d.stops) : t("No beat assigned yet")}</b>
        {d.stops ? <Progress done={d.done} total={d.stops} /> : <p>{t("Ask your manager to assign a beat. You can still take orders.")}</p>}
        <button onClick={() => go(d.stops ? "beat" : "order")}>{d.stops ? (d.done ? t("Continue beat") : t("Start beat")) : t("Take an order")}</button></div>}
    <div className="kpi-grid">
      <Kpi icon="visits" label={t("Visits")} value={d.stops ? `${d.done}/${d.stops}` : d.done} sub={t("done today")} onClick={() => go("beat")} />
      <Kpi icon="orders" label={t("Orders")} value={d.orders} sub={t("placed today")} onClick={() => go("orders")} />
      <Kpi icon="order" label={t("Order value")} value={inr0(d.value)} sub={t("today")} onClick={() => go("orders")} />
      {f.invoicing ? <Kpi icon="collect" label={t("To collect")} value={inr0(d.due)} sub={d.due > 0 ? t("outstanding") : t("nothing due")} onClick={() => go("collect")} tone={d.due > 0 ? "warn" : undefined} />
        : f.incentives ? <Kpi icon="incentives" label={t("Earned")} value={inr0(d.earned)} sub={t("this month")} onClick={() => go("incentives")} /> : null}
    </div>
    <DayCard s={s} />
    <div className="sec-h">{t("Quick actions")}</div>
    <div className="acts">
      <Action icon="order" title={t("New order")} text={t("Pick a shop and take an order")} onClick={() => go("order")} primary />
      <Action icon="beat" title={t("Today's beat")} text={d.stops ? t("{0} outlets left", d.stops - d.done) : t("Not assigned")} onClick={() => go("beat")} />
      {f.invoicing && <Action icon="collect" title={t("Collect payment")} text={d.due > 0 ? t("{0} due", inr0(d.due)) : t("Nothing due")} onClick={() => go("collect")} />}
      {f.audits && d.open && <Action icon="audit" title={t("Store check")} text={t("Fill the checklist for this outlet")} onClick={() => go("audit")} />}
      <Action icon="orders" title={t("My orders")} text={t("Orders you placed")} onClick={() => go("orders")} />
      <Action icon="targets" title={t("My targets")} text={t("This month's progress")} onClick={() => go("targets")} />
      {f.incentives && f.invoicing && <Action icon="incentives" title={t("My incentives")} text={t("{0} earned this month", inr0(d.earned))} onClick={() => go("incentives")} />}
      {f.expenses && <Action icon="myexpenses" title={t("My expenses")} text={t("Claim travel, food and other costs")} onClick={() => go("myexpenses")} />}
      {f.leave && <Action icon="myleave" title={t("My leave")} text={t("Apply for a day off")} onClick={() => go("myleave")} />}
    </div></div>;
}

export function DistributorHome({ s, cfg, go }: ViewProps) {
  const f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/orders"), []), f.purchaseOrders ? safe(api(s, "/api/pos"), []) : [], f.invoicing && f.distributorBilling ? safe(api(s, "/api/outstanding"), []) : []]).then(([o, p, out]) =>
    setD({ placed: o.filter((x: any) => x.status === "placed").length, toBill: o.filter((x: any) => ["accepted", "fulfilled"].includes(x.status) && !x.invoice).length,
      po: p.filter((x: any) => ["draft", "approved", "partially_dispatched", "dispatched"].includes(x.status)).length, due: out.reduce((a: number, r: any) => a + r.outstanding, 0) })); }, []);
  if (!d) return <Loading />;
  return <div className="home">
    <div className="page-h"><div><h2 className="hello">{hello(s.user.name)}</h2><p className="muted small">{longDate()}</p></div></div>
    <div className="kpi-grid">
      <Kpi icon="inbox" label={t("New orders")} value={d.placed} sub={d.placed ? t("waiting for you") : t("All caught up")} tone={d.placed ? "warn" : undefined} onClick={() => go("inbox")} />
      {f.invoicing && f.distributorBilling && <Kpi icon="invoices" label={t("To bill")} value={d.toBill} sub={d.toBill ? t(d.toBill === 1 ? "{0} order to bill" : "{0} orders to bill", d.toBill) : t("Nothing to bill")} onClick={() => go(d.toBill ? "inbox" : "invoices")} />}
      {f.invoicing && f.distributorBilling && <Kpi icon="collections" label={t("To collect")} value={inr0(d.due)} sub={d.due > 0 ? t("outstanding") : t("Nothing due")} tone={d.due > 0 ? "warn" : undefined} onClick={() => go("collections")} />}
      {f.purchaseOrders && <Kpi icon="POs" label={t("Purchase orders")} value={d.po} sub={d.po ? t("{0} open", d.po) : t("Order stock from the company")} onClick={() => go("POs")} />}
    </div>
    <div className="sec-h">{t("Quick actions")}</div>
    <div className="acts">
      <Action icon="inbox" title={t("New orders")} text={d.placed ? t("{0} waiting for you", d.placed) : t("All caught up")} badge={d.placed} onClick={() => go("inbox")} primary />
      {f.invoicing && f.distributorBilling && <Action icon="invoices" title={t("Invoices")} text={d.toBill ? t(d.toBill === 1 ? "{0} order to bill" : "{0} orders to bill", d.toBill) : t("Bills you issued")} badge={d.toBill} onClick={() => go(d.toBill ? "inbox" : "invoices")} />}
      {f.stock && <Action icon="stock" title={t("Stock")} text={t("What you have on hand")} onClick={() => go("stock")} />}
      {f.invoicing && f.distributorBilling && <Action icon="collections" title={t("Collections")} text={d.due > 0 ? t("{0} to collect", inr0(d.due)) : t("Nothing due")} onClick={() => go("collections")} />}
      {f.purchaseOrders && <Action icon="POs" title={t("Purchase orders")} text={d.po ? t("{0} open", d.po) : t("Order stock from the company")} onClick={() => go("POs")} />}
      <Action icon="profile" title={t("My profile")} text={t("GST details & terms")} onClick={() => go("profile")} />
    </div></div>;
}

/** Admin-only banner when the server's free disk drops below the alert level (default 15%). */
export function DiskAlert({ s }: { s: any }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { safe(api(s, "/api/system/disk"), null).then(setD); }, []);
  return d?.low ? <div className="banner bad" role="alert">{t("Low disk space on the server: only {0}% free. Delete old files or move photos to S3 storage (see README).", d.freePct)}</div> : null;
}

/** Daily summary: built-in rules on order history (an optional LLM only rewords it). */
export function DailySummary({ s }: { s: any }) {
  const [d, setD] = useState<any>(null); const [risk, setRisk] = useState(false);
  useEffect(() => { safe(api(s, "/api/ai/summary"), null).then(setD); }, []);
  if (!d) return null;
  return <section className="panel"><div className="panel-h"><b>{t("Insights")}</b><span className="muted small">{t("from your order history")}</span></div>
    <ul className="insights">{d.lines.slice(0, 4).map((l: any, i: number) => <li key={i} className={`ins ${l.tone || ""}`}><span className="ins-dot" aria-hidden />{t(l.key, ...l.args)}</li>)}</ul>
    {d.atRisk?.length > 0 && <><button className="sm ghost" onClick={() => setRisk(!risk)}>{risk ? t("Hide") : t("Shops at risk ({0})", d.atRisk.length)}</button>
      {risk && <ul style={{ paddingLeft: 4, listStyle: "none" }}>{d.atRisk.map((r: any) => <li key={r.shopId} style={{ margin: "6px 0" }}><b>{r.shop}</b> <span className="muted small">{r.city || ""}</span><br /><span className="small">{t(r.why.key, ...r.why.args)}</span></li>)}</ul>}</>}
  </section>;
}

const shortDay = (k: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" }).format(new Date(k + "T12:00:00+05:30"));
const inrK = (n: number) => n >= 1e7 ? `₹${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `₹${(n / 1e3).toFixed(1)}K` : inr0(n);

export function ManagerHome(p: ViewProps) {
  const { s, cfg, go } = p, f = cfg.settings.features;
  const [d, setD] = useState<any>(null);
  useEffect(() => { Promise.all([safe(api(s, "/api/dashboard?days=7"), []), safe(api(s, "/api/orders"), []), f.purchaseOrders ? safe(api(s, "/api/pos"), []) : [], f.invoicing ? safe(api(s, "/api/outstanding"), []) : [], safe(api(s, "/api/outlets/pending"), [])]).then(([dash, o, po, out, outlets]) => {
    const t0 = today(), td = dash.filter((r: any) => r.day === t0), sum = (rows: any[], k: string) => rows.reduce((a: number, r: any) => a + Number(r[k] || 0), 0);
    const days = [...Array(7)].map((_, i) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - (6 - i) * 864e5)));
    const reps = new Map<string, { label: string; value: number; orders: number; visits: number }>();
    for (const r of dash) { const x = reps.get(r.rep) || { label: r.rep, value: 0, orders: 0, visits: 0 }; x.value += r.value; x.orders += r.orders; x.visits += r.visits; reps.set(r.rep, x); }
    setD({ visits: sum(td, "visits"), orders: sum(td, "orders"), value: sum(td, "value"), week: sum(dash, "value"), weekOrders: sum(dash, "orders"),
      trend: days.map(k => ({ label: shortDay(k), value: sum(dash.filter((r: any) => r.day === k), "value") })),
      reps: [...reps.values()].sort((a, b) => b.value - a.value).slice(0, 6),
      approve: o.filter((x: any) => x.status === "placed" && !x.distributor_id).length, waiting: o.filter((x: any) => x.status === "pending_approval").length, outlets: outlets.length, pos: po.filter((x: any) => ["submitted", "approved", "partially_dispatched"].includes(x.status)).length,
      due: sum(out, "outstanding"), overdue: sum(out, "overdue") });
  }); }, []);
  return <div className="home">{s.user.role === "company_admin" && <><DiskAlert s={s} /><SetupChecklist {...p} /></>}
    <div className="page-h"><div><h2 className="hello">{hello(s.user.name)}</h2><p className="muted small">{longDate()} · {t("your team")}</p></div>
      <button className="ghost sm" onClick={() => go("reports")}><Icon name="reports" size={16} /> {t("Reports")}</button></div>
    {!d ? <Loading /> : <>
      <div className="kpi-grid">
        <Kpi icon="order" label={t("Order value")} value={inr0(d.value)} sub={t("today")} onClick={() => go("dashboard")} />
        <Kpi icon="orders" label={t("Orders")} value={d.orders} sub={t("today")} onClick={() => go("orders")} />
        <Kpi icon="visits" label={t("Visits")} value={d.visits} sub={t("today")} onClick={() => go("visits")} />
        {f.invoicing ? <Kpi icon="collections" label={t("Outstanding")} value={inr0(d.due)} sub={d.overdue > 0 ? t("{0} overdue", inr0(d.overdue)) : t("nothing overdue")} tone={d.overdue > 0 ? "bad" : undefined} onClick={() => go("collections")} />
          : <Kpi icon="dashboard" label={t("Last 7 days")} value={inr0(d.week)} sub={t("{0} orders", d.weekOrders)} onClick={() => go("dashboard")} />}
      </div>
      <div className="dash-grid">
        <section className="panel"><div className="panel-h"><b>{t("Order value, last 7 days")}</b><span className="muted small num">{inr0(d.week)}</span></div>
          {d.week > 0 ? <DayBars data={d.trend} fmt={inrK} /> : <p className="muted small empty-line">{t("No orders in the last 7 days yet. The chart fills in as reps place orders.")}</p>}</section>
        <section className="panel"><div className="panel-h"><b>{t("Top reps, last 7 days")}</b><button className="link" onClick={() => go("dashboard")}>{t("See all")}</button></div>
          {d.reps.length ? <HBars data={d.reps.map((r: any) => ({ label: r.label, value: r.value, sub: t("{0} orders · {1} visits", r.orders, r.visits) }))} fmt={inr0} sub />
            : <p className="muted small empty-line">{t("No rep activity in the last 7 days.")}</p>}</section>
        <section className="panel"><div className="panel-h"><b>{t("Needs your action")}</b></div>
          <div className="acts flat">
            <Action icon="orders" title={t("Orders to accept")} text={d.approve ? t("{0} company orders waiting", d.approve) : t("Nothing waiting")} badge={d.approve} onClick={() => go("orders")} />
            {d.waiting > 0 && <Action icon="clock" title={t("Waiting for approval")} text={t("{0} waiting for you", d.waiting)} badge={d.waiting} onClick={() => go("orders")} />}
            <Action icon="outletapprovals" title={t("New outlets")} text={d.outlets ? t("{0} waiting for you", d.outlets) : t("Nothing waiting")} badge={d.outlets} onClick={() => go("outletapprovals")} />
            {f.purchaseOrders && <Action icon="POs" title={t("Purchase orders")} text={d.pos ? t("{0} to approve or dispatch", d.pos) : t("Nothing waiting")} badge={d.pos} onClick={() => go("POs")} />}
            {f.invoicing && d.overdue > 0 && <Action icon="collections" title={t("Overdue payments")} text={t("{0} overdue", inr0(d.overdue))} onClick={() => go("collections")} />}
          </div></section>
        <DailySummary s={s} />
      </div>
      <div className="sec-h">{t("Shortcuts")}</div>
      <div className="acts grid2">
        <Action icon="dashboard" title={t("Team activity")} text={t("Visits & orders by rep")} onClick={() => go("dashboard")} />
        <Action icon="reports" title={t("Reports")} text={t("Download Excel / CSV")} onClick={() => go("reports")} />
        {f.invoicing && <Action icon="invoices" title={t("Invoices")} text={t("GST invoices & credit notes")} onClick={() => go("invoices")} />}
        <Action icon="settings" title={t("Setup")} text={t("Products, outlets, users, settings")} onClick={() => go(s.user.role === "company_admin" ? "settings" : "catalog")} />
      </div></>}</div>;
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
    <div className="cl-h"><b>{n === steps.length ? t("Setup complete") : t("Get started")}</b><span className="muted small">{n} of {steps.length} done</span>
      {n === steps.length && <button className="ghost sm" onClick={() => { localStorage.setItem("ff-setup-hidden", "1"); setHide(true); }}>{t("Hide")}</button>}</div>
    <div className="bar big"><span style={{ width: `${pct}%` }} /></div>
    {steps.map((x, i) => <div key={i} className={`step ${x.done ? "done" : ""}`}><span className="dot">{x.done ? <Icon name="check" size={16} /> : i + 1}</span><div><b>{x.title}</b><div className="muted small">{x.text}</div></div>
      {x.done ? <button className="sm ghost" onClick={() => go(x.tab)}>{x.tab === "settings" ? t("Edit") : t("View")}</button> : <button className="sm" onClick={() => go(x.tab)}>{x.btn}</button>}</div>)}</div>;
}
