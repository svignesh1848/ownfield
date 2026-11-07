// Design system: formatting (₹, dd-mm-yyyy), toasts, empty states, loading, tooltips for jargon, icons.
import React, { useEffect, useState } from "react";
import { t } from "./i18n";

// ---------- Formatting ----------
export const inr = (n: unknown, dp = 2) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
export const inr0 = (n: unknown) => `₹${Math.round(Number(n || 0)).toLocaleString("en-IN")}`;
const two = (n: number) => String(n).padStart(2, "0");
/** dd-mm-yyyy (dates) or dd-mm-yyyy hh:mm (timestamps), shown in India time. */
export function fmtDate(v: unknown, withTime = false) {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
  const d = new Date(s); if (isNaN(+d)) return s;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)?.value || "";
  return `${g("day")}-${g("month")}-${g("year")}${withTime ? ` ${g("hour")}:${g("minute")}` : ""}`;
}
export const isDateLike = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v);
export const fmtCell = (v: unknown) => isDateLike(v) ? fmtDate(v, String(v).includes("T")) : typeof v === "boolean" ? (v ? t("Yes") : t("No")) : String(v ?? "");
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
void two;

// ---------- Toasts ----------
type Toast = { id: number; text: string; kind: "ok" | "err" };
let push: (t: Omit<Toast, "id">) => void = () => {};
export const toast = (text: string, kind: "ok" | "err" = "ok") => push({ text, kind });
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { push = t => { const id = Date.now() + Math.random(); setList(l => [...l, { ...t, id }]); setTimeout(() => setList(l => l.filter(x => x.id !== id)), 3500); }; }, []);
  return <div className="toasts" role="status" aria-live="polite">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.kind === "ok" ? <L.CircleCheck size={18} aria-hidden /> : <L.TriangleAlert size={18} aria-hidden />}<span>{t.text}</span></div>)}</div>;
}

// ---------- Empty / loading / tooltips ----------
export function Empty({ icon = "📭", title, text, action, onAction }: { icon?: string; title: string; text?: string; action?: string; onAction?: () => void }) {
  return <div className="empty"><div className="empty-ic"><Icon name={icon} size={28} /></div><b>{title}</b>{text && <p>{text}</p>}{action && onAction && <button onClick={onAction}>{action}</button>}</div>;
}
export const Loading = ({ text = t("Loading…") }: { text?: string }) => <div className="loading"><span className="spin" />{text}</div>;

export const GLOSSARY: Record<string, string> = {
  FEFO: t("First Expiry, First Out — stock with the nearest expiry date is used first."),
  IRN: t("Invoice Reference Number — the unique number the GST portal gives an e-invoice."),
  GSTIN: t("15-character GST registration number of a business."),
  HSN: t("HSN/SAC — the GST product/service code printed on invoices; it decides the tax rate."),
  PO: t("Purchase order — a distributor's request to buy stock from the company."),
  Beat: t("A planned route: the list of outlets a sales rep visits on a day."),
  Scheme: t("A trade offer such as % off, buy X get Y free, or quantity slabs."),
  "Credit note": t("A document that reduces what an outlet owes, e.g. for returned goods."),
  Ageing: t("How long invoices have been unpaid, grouped as 0-30, 31-60, 61-90 and 90+ days."),
  UQC: t("Unit code used by GST (PCS, BOX, CTN …)."),
};
/** A jargon word with a tap/hover explanation. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className="term" tabIndex={0} title={t(GLOSSARY[k])} onClick={e => { e.stopPropagation(); setOpen(!open); }} onBlur={() => setOpen(false)}>
    {children ?? t(k)}<sup>?</sup>{open && <span className="tip">{t(GLOSSARY[k])}</span>}</span>;
}

/** Labelled form field with helper text and inline error. */
export function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: React.ReactNode }) {
  return <label className={`field ${error ? "bad" : ""}`}><span className="flabel">{label}</span>{children}{error ? <span className="ferr">{error}</span> : help ? <span className="fhelp">{help}</span> : null}</label>;
}

import * as L from "lucide-react";
type LI = React.ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
/** Tab id -> line icon. */
const TAB_IC: Record<string, LI> = {
  team: L.Network, outletapprovals: L.Store, addoutlet: L.CirclePlus, returns: L.Undo2, statement: L.BookOpen, productform: L.FilePen,
  home: L.House, beat: L.Route, visit: L.MapPin, order: L.ShoppingCart, orders: L.Package, collect: L.Wallet, collections: L.Wallet, targets: L.Target, catalog: L.Shirt, inbox: L.Inbox,
  invoices: L.ReceiptText, stock: L.Warehouse, POs: L.ClipboardList, profile: L.IdCard, dashboard: L.ChartColumn, beats: L.Route, visits: L.MapPin, reports: L.ChartLine, shops: L.Store, schemes: L.Tag,
  distributors: L.Truck, surveys: L.ClipboardCheck, messages: L.MessageSquare, users: L.Users, settings: L.Settings, import: L.Upload, more: L.Menu, setup: L.CircleCheck, audit: L.ClipboardCheck, audits: L.ClipboardCheck, checklists: L.ListChecks, expenses: L.Receipt, myexpenses: L.Receipt, leave: L.CalendarDays, myleave: L.CalendarDays, incentives: L.Trophy, rules: L.Trophy, integrations: L.Plug, van: L.Truck, vans: L.Truck, inventory: L.Boxes, claims: L.FileText, leads: L.Sprout, trail: L.Navigation, coverage: L.ChartPie, fieldrules: L.Ruler, data: L.Table2, security: L.ShieldCheck, account: L.CircleUser, chev: L.ChevronRight, bell: L.Bell, search: L.Search, check: L.Check, alert: L.TriangleAlert, clock: L.Clock, pin: L.MapPin, phone: L.Phone, plus: L.Plus, minus: L.Minus, logout: L.LogOut, filter: L.SlidersHorizontal, image: L.ImageOff, x: L.X, back: L.ChevronLeft,
};
/** Legacy emoji -> line icon, so older call sites render an SVG instead of an emoji. */
const EMOJI_IC: Record<string, LI> = {
  "🧭": L.Navigation, "🏪": L.Store, "➕": L.CirclePlus, "↩️": L.Undo2, "📒": L.BookOpen, "📝": L.FilePen, "🏠": L.House, "🗺️": L.Route, "📍": L.MapPin, "🛒": L.ShoppingCart, "📦": L.Package,
  "💰": L.Wallet, "🎯": L.Target, "📚": L.Shirt, "📥": L.Inbox, "🧾": L.ReceiptText, "🏬": L.Warehouse, "📋": L.ClipboardList, "🪪": L.IdCard, "📊": L.ChartColumn, "📈": L.ChartLine,
  "🏷️": L.Tag, "🚚": L.Truck, "💬": L.MessageSquare, "👥": L.Users, "⚙️": L.Settings, "⬆️": L.Upload, "☰": L.Menu, "✅": L.CircleCheck, "🌴": L.CalendarDays, "🏆": L.Trophy, "🔌": L.Plug,
  "🚐": L.Truck, "🌱": L.Sprout, "📏": L.Ruler, "🧮": L.Table2, "⚠️": L.TriangleAlert, "🔒": L.Lock, "🎉": L.CircleCheck, "🔍": L.Search, "📭": L.Inbox, "🌐": L.Globe,
};
/** One consistent SVG icon. `name` may be a tab id or a legacy emoji. */
export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  const C = TAB_IC[name] || EMOJI_IC[name] || EMOJI_IC[name.replace(/\uFE0F/g, "")];
  if (!C) return <span className={className} aria-hidden>{name}</span>;
  return <C size={size} strokeWidth={1.9} className={className} aria-hidden />;
}
/** Kept for compatibility: tab ids that have an icon. */
export const ICONS: Record<string, string> = Object.fromEntries(Object.keys(TAB_IC).map(k => [k, k]));
