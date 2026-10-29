// Design system: formatting (₹, dd-mm-yyyy), toasts, empty states, loading, tooltips for jargon, icons.
import React, { useEffect, useState } from "react";

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
export const fmtCell = (v: unknown) => isDateLike(v) ? fmtDate(v, String(v).includes("T")) : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "");
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
void two;

// ---------- Toasts ----------
type Toast = { id: number; text: string; kind: "ok" | "err" };
let push: (t: Omit<Toast, "id">) => void = () => {};
export const toast = (text: string, kind: "ok" | "err" = "ok") => push({ text, kind });
export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => { push = t => { const id = Date.now() + Math.random(); setList(l => [...l, { ...t, id }]); setTimeout(() => setList(l => l.filter(x => x.id !== id)), 3500); }; }, []);
  return <div className="toasts" role="status" aria-live="polite">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.kind === "ok" ? "✓ " : "⚠ "}{t.text}</div>)}</div>;
}

// ---------- Empty / loading / tooltips ----------
export function Empty({ icon = "📭", title, text, action, onAction }: { icon?: string; title: string; text?: string; action?: string; onAction?: () => void }) {
  return <div className="empty"><div className="empty-ic">{icon}</div><b>{title}</b>{text && <p>{text}</p>}{action && onAction && <button onClick={onAction}>{action}</button>}</div>;
}
export const Loading = ({ text = "Loading…" }: { text?: string }) => <div className="loading"><span className="spin" />{text}</div>;

export const GLOSSARY: Record<string, string> = {
  FEFO: "First Expiry, First Out — stock with the nearest expiry date is used first.",
  IRN: "Invoice Reference Number — the unique number the GST portal gives an e-invoice.",
  GSTIN: "15-character GST registration number of a business.",
  HSN: "HSN/SAC — the GST product/service code printed on invoices; it decides the tax rate.",
  PO: "Purchase order — a distributor's request to buy stock from the company.",
  Beat: "A planned route: the list of outlets a sales rep visits on a day.",
  Scheme: "A trade offer such as % off, buy X get Y free, or quantity slabs.",
  "Credit note": "A document that reduces what an outlet owes, e.g. for returned goods.",
  Ageing: "How long invoices have been unpaid, grouped as 0-30, 31-60, 61-90 and 90+ days.",
  UQC: "Unit code used by GST (PCS, BOX, CTN …).",
};
/** A jargon word with a tap/hover explanation. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <span className="term" tabIndex={0} title={GLOSSARY[k]} onClick={e => { e.stopPropagation(); setOpen(!open); }} onBlur={() => setOpen(false)}>
    {children ?? k}<sup>?</sup>{open && <span className="tip">{GLOSSARY[k]}</span>}</span>;
}

/** Labelled form field with helper text and inline error. */
export function Field({ label, help, error, children }: { label: string; help?: string; error?: string; children: React.ReactNode }) {
  return <label className={`field ${error ? "bad" : ""}`}><span className="flabel">{label}</span>{children}{error ? <span className="ferr">{error}</span> : help ? <span className="fhelp">{help}</span> : null}</label>;
}

export const ICONS: Record<string, string> = {
  home: "🏠", beat: "🗺️", visit: "📍", order: "🛒", orders: "📦", collect: "💰", collections: "💰", targets: "🎯", catalog: "📚", inbox: "📥",
  invoices: "🧾", stock: "🏬", POs: "📋", profile: "🪪", dashboard: "📊", beats: "🗺️", visits: "📍", reports: "📈", shops: "🏪", schemes: "🏷️",
  distributors: "🚚", users: "👥", settings: "⚙️", import: "⬆️", more: "☰", setup: "✅", audit: "✅", audits: "✅", checklists: "📝", expenses: "🧾", myexpenses: "🧾", leave: "🌴", myleave: "🌴", incentives: "🏆", rules: "🏆", integrations: "🔌", van: "🚐", vans: "🚐",
};
