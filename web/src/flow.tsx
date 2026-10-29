// Field rules: one simple settings page for the flow rules (no-order reasons, must-sell, expiry block, approvals, day start, announcements).
import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps } from "./main";
import { Field, toast, Loading } from "./ui";
import { t } from "./i18n";

const lines = (v: string) => v.split("\n").map(x => x.trim()).filter(Boolean);
export function FlowSettings({ s }: ViewProps) {
  const [f, setF] = useState<any>(null); const [txt, setTxt] = useState<Record<string, string>>({});
  useEffect(() => { api(s, "/api/flow-settings").then(x => { setF(x); setTxt({
    reasons: x.noOrderReasons.join("\n"), adjust: x.adjustReasons.join("\n"),
    must: Object.entries(x.mustSell).map(([k, v]: any) => `${k}: ${v.join(", ")}`).join("\n"),
    levels: x.claimLevels.map((l: any) => `${l.kind}, ${l.upTo}, ${l.role}`).join("\n"),
    ann: x.announcements.map((a: any) => a.until ? `${a.text} | ${a.until}` : a.text).join("\n") }); }); }, []);
  if (!f) return <Loading />;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const save = async () => {
    const mustSell: Record<string, string[]> = {}; for (const l of lines(txt.must || "")) { const [k, v = ""] = l.split(":"); mustSell[k.trim() || "*"] = v.split(",").map(x => x.trim()).filter(Boolean); }
    const claimLevels = lines(txt.levels || "").map(l => { const [kind, upTo, role] = l.split(",").map(x => x.trim()); return { kind, upTo: Number(upTo), role }; });
    const announcements = lines(txt.ann || "").map(l => { const [text, until] = l.split("|").map(x => x.trim()); return { text, until: until || undefined }; });
    try { setF(await api(s, "/api/flow-settings", { method: "PUT", body: JSON.stringify({ ...f, noOrderReasons: lines(txt.reasons || ""), adjustReasons: lines(txt.adjust || ""), mustSell, claimLevels, announcements }) })); }
    catch (e: any) { toast(e.message, "err"); }
  };
  const ck = (k: string, label: string) => <label className="check"><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)} /> {label}</label>;
  const ta = (k: string, label: string, help: string) => <Field label={label} help={help}><textarea rows={4} value={txt[k] || ""} onChange={e => setTxt({ ...txt, [k]: e.target.value })} /></Field>;
  return <><h2>{t("Field rules")}</h2>
    <div className="card"><h3>{t("Visits")}</h3>
      {ck("requireNoOrderReason", t("Reps must pick a reason when a visit has no order"))}
      {ta("reasons", t("No-order reasons"), t("One per line."))}
      {ck("dayStart", t("Reps start and end their day (with GPS)"))}
      {ck("selfie", t("Ask for a selfie at start of day (optional for the rep)"))}</div>
    <div className="card"><h3>{t("Must-sell products")}</h3>
      {ta("must", t("Must-sell list per outlet type"), t("One line per outlet type: type: SKU1, SKU2. Use * for every outlet."))}</div>
    <div className="card"><h3>{t("Stock")}</h3>
      <Field label={t("Don't sell batches expiring within (days)")} help={t("0 = only expired batches are blocked.")}><input type="number" min={0} value={f.expiryBlockDays} onChange={e => set("expiryBlockDays", Number(e.target.value))} /></Field>
      {ck("adjustApproval", t("Distributor stock adjustments need manager approval"))}
      {ta("adjust", t("Adjustment reasons"), t("One per line. A reason is always required."))}
      {ck("grnConfirm", t("Distributor confirms goods received (GRN) before stock is added"))}</div>
    <div className="card"><h3>{t("Claims")}</h3>
      {ta("levels", t("Approval levels"), t("One per line: claim type, up to ₹, approver (manager or company_admin). E.g. damage, 5000, manager. Use * for any type."))}
      <Field label={t("Damage claims cap (% of monthly primary sales)")} help={t("0 = no cap.")}><input type="number" min={0} max={100} value={f.damageCapPct} onChange={e => set("damageCapPct", Number(e.target.value))} /></Field></div>
    <div className="card"><h3>{t("Retailer app")}</h3>
      {ta("ann", t("Announcements"), t("One per line. Optional end date after |, e.g. Diwali offer on all biscuits | 2026-11-15"))}</div>
    <button className="block" onClick={save}>{t("Save rules")}</button>
    {f.dayStart && <DayList s={s} />}</>;
}
// Default no-order and adjustment reasons, listed so they are translated (custom reasons show as typed).
export const DEFAULT_REASON_WORDS = [t("Shop closed"), t("Owner not available"), t("Enough stock"), t("Payment pending"), t("Price issue"), t("Competitor scheme"), t("Other"), t("No reason given"),
  t("Damaged"), t("Expired"), t("Count correction"), t("Theft / loss"), t("Sample / free issue")];

function DayList({ s }: { s: ViewProps["s"] }) {
  const [d, setD] = useState<any>(null); useEffect(() => { api(s, "/api/day").then(setD).catch(() => setD({ rows: [] })); }, []);
  const tm = (x: string | null) => x ? new Date(x).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
  return <div className="card"><h3>{t("Who started their day today")}</h3>
    <Table rows={d?.rows?.map((r: any) => ({ rep_name: r.rep_name, start_at: tm(r.start_at), end_at: tm(r.end_at), where: r.start_lat != null ? `${r.start_lat.toFixed(4)}, ${r.start_lng.toFixed(4)}` : "", selfie: r.has_selfie ? t("Yes") : "" })) ?? null}
      cols={["rep_name", "start_at", "end_at", "where", "selfie"]} empty={{ title: t("Nobody has started yet") }} /></div>;
}
