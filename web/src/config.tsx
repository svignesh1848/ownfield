import { Empty } from "./ui";
import React, { useEffect, useState } from "react";
import { api, Table, label, type Session, type Cfg } from "./main";
import { GstSettings } from "./step4";
import { PoSettings, poForSave } from "./po";
import { t } from "./i18n";
import { CreditSettings } from "./collect";

type P = { s: Session; cfg: Cfg; reload: () => void; onUsage?: (u: any) => void; go?: (t: string) => void };
const FEATURES: [string, string][] = [["stock", t("Track stock — stop orders when stock runs out")], ["batches", t("Batches & expiry dates — use the nearest expiry first")], ["sizeGrid", t("Order sizes/colours in a grid")], ["gps", t("Reps must share location when checking in")],
  ["schemes", t("Offers & schemes (discounts, free goods)")], ["drugLicence", t("Record drug licence numbers")], ["services", t("Allow services (items without stock)")], ["photos", t("Photos during visits")], ["invoicing", "GST invoices, returns & payments"], ["purchaseOrders", t("Distributors can order stock from the company")], ["distributorBilling", t("Distributors bill outlets under their own GST number")], ["eInvoice", t("GST e-invoices (government invoice number + QR code)")], ["audits", t("Store checks — checklists and shelf photos during visits")], ["expenses", t("Expense claims with bill photos, approved by a manager")], ["leave", t("Leave requests & attendance — visits pause on approved leave days")], ["incentives", t("Incentives — bonus when reps reach a % of their target")], ["retailerApp", t("Retailer app — shops log in, see products and order from their distributor")]];
export const attrText = (a: Record<string, string>) => Object.values(a || {}).join(" / ");
const unitsText = (u: { code: string; factor: number }[]) => u.map(x => `${x.code}=${x.factor}`).join(", ");

export function CustomInputs({ defs, value, onChange }: { defs: any[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  return <>{defs.map(d => <label key={d.key} className="fld"><span>{d.label}{d.required ? " *" : ""}</span>
    {d.type === "select" ? <select value={value[d.key] ?? ""} onChange={e => onChange({ ...value, [d.key]: e.target.value })}><option value="">—</option>{d.options.map((o: string) => <option key={o}>{o}</option>)}</select>
      : <input type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} value={value[d.key] ?? ""} onChange={e => onChange({ ...value, [d.key]: e.target.value })} />}</label>)}</>;
}

export function Catalog({ s, cfg, go }: P) {
  const [items, setItems] = useState<any[]>([]); useEffect(() => { api(s, "/api/items").then(setItems); }, []);
  const pf = cfg.settings.customFields.product;
  return <><h2>{t("Products")}</h2>{!items.length && <Empty icon="📚" title={t("No products yet")} text={s.user.role === "company_admin" ? t("Upload your product list from Excel, or load sample data from Company settings to try things out.") : t("Your administrator hasn't added products yet.")}
      action={s.user.role === "company_admin" && go ? t("Upload products") : undefined} onAction={() => go?.("import")} />}
    {items.map(i => <div className="row" key={i.id}><b>{i.name}</b> <span className="muted">{i.code}{i.category ? ` · ${i.category}` : ""}{i.hsn ? t(" · HSN code {0}", i.hsn) : ""}</span>
      {i.kind === "service" && <span className="pill">service</span>}
      <div className="muted">{t("Units:")}{" "}{unitsText(i.uoms)}{pf.filter(f => i.custom[f.key] != null).map(f => ` · ${f.label}: ${i.custom[f.key]}`).join("")}</div>
      <Table rows={i.variants.map((v: any) => ({ ...v, variant: attrText(v.attrs) }))} cols={["sku", "variant", "mrp", "billing_price"]} /></div>)}</>;
}

export function Stock({ s, cfg }: P) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/stock").then(setRows); useEffect(() => { load(); }, []);
  const b = cfg.settings.features.batches;
  return <><h2>{t("Stock")}</h2>
    <Table rows={rows.map(r => ({ ...r, item: `${r.item_name} ${attrText(r.attrs)}`, status: r.expired ? "EXPIRED" : r.qty > 0 ? "ok" : "nil" }))}
      cols={["location", "sku", "item", ...(b ? ["batch_no", "expiry"] : []), "qty", "status"]} />
    <form className="row" onSubmit={async e => { e.preventDefault(); try { const r = await api(s, "/api/import/stock", { method: "POST", body: new FormData(e.currentTarget) }); setMsg(t("{0} added, {1} updated{2}", r.inserted, r.updated, r.errors.map((x: any) => ` [row ${x.row}: ${x.error}]`).join(""))); load(); } catch (x: any) { setMsg(x.message); } }}>
      <label>{t("Upload stock (.xlsx/.csv) — sets quantity per SKU")}{b ? t(" + batch") : ""}</label><input name="file" type="file" accept=".xlsx,.xls,.csv" required /><button className="sm">{t("Upload")}</button></form>
    <p className="muted">{t("Columns: SKU, Qty, Unit")}{b ? t(", Batch, Expiry") : ""}{s.user.role !== "distributor" ? t(", Distributor Email (blank = company stock)") : ""}. {b && t("Orders are allocated first-expiry-first-out; expired batches are never allocated.")}</p><p>{msg}</p></>;
}

export function Schemes({ s }: P) {
  const blank = { name: "", type: "percent", itemId: "", category: "", distributorId: "", startsOn: "", endsOn: "", minQty: "1", discountPct: "", amount: "", buy: "", get: "", basis: "qty", slabs: "" };
  const [rows, setRows] = useState<any[]>([]); const [items, setItems] = useState<any[]>([]); const [dists, setDists] = useState<any[]>([]); const [f, setF] = useState(blank); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/schemes").then(setRows);
  useEffect(() => { load(); api(s, "/api/items").then(setItems); api(s, "/api/distributors").then(setDists).catch(() => {}); }, []);
  const cats = [...new Set(items.map(i => i.category).filter(Boolean))];
  const inp = (k: keyof typeof blank, ph: string) => <input placeholder={ph} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} />;
  const save = async (e: any) => { e.preventDefault(); try {
    const slabs = f.slabs.split(",").map(x => x.trim()).filter(Boolean).map(x => { const [min, pct] = x.split(":"); return { min: Number(min), pct: Number(pct) }; });
    await api(s, "/api/schemes", { method: "POST", body: JSON.stringify({ ...f, minQty: Number(f.minQty), discountPct: Number(f.discountPct), amount: Number(f.amount), buy: Number(f.buy), get: Number(f.get), slabs,
      itemId: f.itemId || null, distributorId: f.distributorId || null, category: f.category || null, startsOn: f.startsOn || null, endsOn: f.endsOn || null }) });
    setMsg(t("Scheme added")); setF(blank); load(); } catch (x: any) { setMsg(x.message); } };
  return <><h2>{t("Offers & schemes")}</h2><p className="muted">{t("Discounts and free goods are applied to orders automatically.")}</p>
    <Table rows={rows.map(r => ({ ...r, applies_to: [r.item_name || (r.category ? `Category ${r.category}` : t("All items")), r.distributor_name && `via ${r.distributor_name}`].filter(Boolean).join(" "),
      valid: `${r.starts_on || "…"} → ${r.ends_on || "…"}`, status: r.live ? "live" : r.active ? t("not in date range") : "off" }))} cols={["name", "rule", "applies_to", "min_qty", "valid", "status"]} />
    {rows.map(r => <button key={r.id} className="sm ghost" onClick={() => api(s, `/api/schemes/${r.id}/active`, { method: "POST", body: JSON.stringify({ active: !r.active }) }).then(load)}>{r.active ? t("Turn off") : t("Turn on")} {r.name}</button>)}
    <details><summary>{t("Scheme budgets")}</summary><p className="muted small">{t("Approved scheme claims cannot go over the budget. Leave blank for no limit.")}</p>
      {rows.map(r => <label key={r.id} className="row">{r.name} <input type="number" min={0} className="sm-input" placeholder="₹" defaultValue={r.budget ?? ""} onBlur={e => { if (e.target.value !== String(r.budget ?? "")) api(s, `/api/schemes/${r.id}/budget`, { method: "PUT", body: JSON.stringify({ budget: e.target.value }) }).then(load).catch(x => setMsg(x.message)); }} /></label>)}</details>
    <form onSubmit={save}><h3>{t("New scheme")}</h3>{inp("name", t("Name"))}
      <select value={f.type} onChange={e => setF({ ...f, type: e.target.value })}><option value="percent">{t("Percent off")}</option><option value="flat">{t("Flat ₹ off per unit")}</option><option value="bxgy">{t("Buy X get Y free")}</option><option value="slab">{t("Quantity / value slabs")}</option></select>
      {f.type === "percent" && inp("discountPct", t("Discount %"))}{f.type === "flat" && inp("amount", t("₹ off per base unit"))}
      {f.type === "bxgy" && <>{inp("buy", t("Buy (base units)"))}{inp("get", t("Get free"))}</>}
      {f.type === "slab" && <><select value={f.basis} onChange={e => setF({ ...f, basis: e.target.value })}><option value="qty">{t("By quantity")}</option><option value="value">{t("By line value ₹")}</option></select>{inp("slabs", t("Slabs min:pct, e.g. 12:5, 24:8"))}</>}
      <select value={f.itemId} onChange={e => setF({ ...f, itemId: e.target.value })}><option value="">{t("Any product")}</option>{items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">{t("Any category")}</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
      <select value={f.distributorId} onChange={e => setF({ ...f, distributorId: e.target.value })}><option value="">{t("All distributors")}</option>{dists.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      {inp("minQty", t("Min qty (base units)"))}<label className="small">{t("From")}{" "}<input type="date" value={f.startsOn} onChange={e => setF({ ...f, startsOn: e.target.value })} /></label>
      <label className="small">{t("To")}{" "}<input type="date" value={f.endsOn} onChange={e => setF({ ...f, endsOn: e.target.value })} /></label>
      <button>{t("Add")}</button><p>{msg}</p></form></>;
}

const cfText = (list: any[]) => list.map(f => [f.label, f.type, (f.options || []).join(","), f.required ? "required" : ""].join(" | ").replace(/( \| )+$/, "")).join("\n");
const cfParse = (t: string) => t.split("\n").map(l => l.trim()).filter(Boolean).map(l => { const [lbl, type = "text", options = "", req = ""] = l.split("|").map(x => x.trim()); return { label: lbl, type, options, required: /req/i.test(req) || /req/i.test(options) && type !== "select" }; });

export function SettingsPage({ s, cfg, reload }: P) {
  const st = cfg.settings;
  const [industry, setIndustry] = useState(cfg.industry); const [tpl, setTpl] = useState<any[]>([]);
  const [features, setFeatures] = useState({ ...st.features }); const [attrs, setAttrs] = useState(st.attributes.join(", ")); const [units, setUnits] = useState(unitsText(st.uoms));
  const [cf, setCf] = useState<Record<string, string>>({ outlet: cfText(st.customFields.outlet), product: cfText(st.customFields.product), visit: cfText(st.customFields.visit) });
  const [msg, setMsg] = useState(""); const [gst, setGst] = useState<any>({ ...(st as any).gst }); const [po, setPo] = useState<any>({ ...(st as any).po });
  const [einv, setEinv] = useState<string>((st as any).einvoice?.provider || "test");
  const [credit, setCredit] = useState<any>({ days: 0, limit: 0, onBreach: "warn", ...(st as any).credit });
  useEffect(() => { api(null, "/api/templates").then(setTpl); }, []);
  useEffect(() => { setFeatures({ ...st.features }); setAttrs(st.attributes.join(", ")); setUnits(unitsText(st.uoms)); setCf({ outlet: cfText(st.customFields.outlet), product: cfText(st.customFields.product), visit: cfText(st.customFields.visit) }); setGst({ ...(st as any).gst }); setPo({ ...(st as any).po }); }, [cfg]);
  const put = async (body: any, ok: string) => { try { await api(s, "/api/company/settings", { method: "PUT", body: JSON.stringify(body) }); setMsg(ok); reload(); } catch (x: any) { setMsg(x.message); } };
  return <><h2>{t("Company settings")}</h2>
    <p className="muted">{t("Choose your industry and turn features on/off. Add your company and GST details for invoices.")}</p>
    <label>{t("Industry template")}</label>
    <select value={industry} onChange={e => setIndustry(e.target.value)}>{tpl.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
    <p className="muted">{tpl.find(t => t.id === industry)?.description}</p>
    <button className="sm ghost" onClick={() => confirm(t("Reset features, attributes, units and custom fields to this template?")) && put({ industry, applyTemplate: true }, t("Template applied"))}>{t("Apply template")}</button>{" "}
    <button className="sm ghost" onClick={async () => { const r = await api(s, "/api/company/sample-data", { method: "POST" }); setMsg(t("Sample data loaded: {0} variants, {1} outlets{2}", r.products.inserted + r.products.updated, r.shops.inserted + r.shops.updated, r.stock ? `, ${r.stock.inserted + r.stock.updated} stock rows` : "")); }}>{t("Load sample data")}</button>
    <h3>{t("Features")}</h3>
    {FEATURES.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!features[k]} onChange={e => setFeatures({ ...features, [k]: e.target.checked })} />{l}</label>)}
    <h3>{t("Product model")}</h3>
    <label className="fld"><span>{t("Variant attributes (comma separated, e.g. size, colour)")}</span><input value={attrs} onChange={e => setAttrs(e.target.value)} /></label>
    <label className="fld"><span>{t("Units with conversion to base unit (base = 1), e.g. PCS=1, BOX=12, CASE=144")}</span><input value={units} onChange={e => setUnits(e.target.value)} /></label>
    <h3>{t("Custom fields")}</h3><p className="muted">{t("One per line:")}{" "}<code>{t("Label | text/number/date/select | options,comma,separated | required")}</code></p>
    {(["outlet", "product", "visit"] as const).map(e => <label key={e} className="fld"><span>{label(e)} fields</span><textarea rows={3} value={cf[e]} onChange={x => setCf({ ...cf, [e]: x.target.value })} /></label>)}
    <GstSettings g={gst} onChange={setGst} />
    {features.purchaseOrders && <PoSettings po={po} onChange={setPo} />}
    {features.invoicing && <CreditSettings c={credit} onChange={setCredit} />}
    {features.eInvoice && <><h3>{t("E-invoicing")}</h3><label className="fld"><span>{t("Provider")}</span><select value={einv} onChange={e => setEinv(e.target.value)}>
      <option value="test">{t("TEST mock (fake IRN/QR — not valid for GST)")}</option><option value="gsp">{t("GSP adapter (configure EINV_GSP_* env on the server)")}</option></select></label></>}
    <button onClick={() => put({ industry, features, attributes: attrs, uoms: units, gst: { ...gst, defaultRate: Number(gst.defaultRate) }, ...(features.purchaseOrders ? { po: poForSave(po) } : {}), ...(features.eInvoice ? { einvoice: { provider: einv } } : {}), ...(features.invoicing ? { credit: { days: Number(credit.days), limit: Number(credit.limit), onBreach: credit.onBreach } } : {}), customFields: { outlet: cfParse(cf.outlet), product: cfParse(cf.product), visit: cfParse(cf.visit) } }, t("Settings saved"))}>{t("Save settings")}</button>
    <p>{msg}</p></>;
}

export function ImportPage({ s, cfg, onUsage }: P) {
  const st = cfg.settings, f = st.features; const [msg, setMsg] = useState("");
  const cols: Record<string, string[]> = {
    products: ["Item Code", "Item Name", "Category", ...(f.services ? ["Type"] : []), "HSN", "SKU", ...st.attributes.map(label), "MRP", "Billing Price", "Units", ...st.customFields.product.map(x => x.label)],
    shops: ["Code", "Name", "Owner Name", "Phone", "Address", "City", "State Code", "GSTIN", ...(f.drugLicence ? ["Drug Licence"] : []), "Distributor Email", ...st.customFields.outlet.map(x => x.label)],
    users: ["Name", "Email", "Phone", "Role", "Password", ...(f.drugLicence ? ["Drug Licence"] : [])],
    targets: ["Rep Email", "Month", "Metric", "Target"],
    ...(f.stock ? { stock: ["SKU", "Qty", "Unit", ...(f.batches ? ["Batch", "Expiry"] : []), "Distributor Email"] } : {}),
  };
  const dl = (k: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([cols[k].join(",") + "\n"], { type: "text/csv" })); a.download = `${k}-template.csv`; a.click(); };
  return <><h2>{t("Upload data from Excel")}</h2><p className="muted">{t("Download a template, fill it in Excel, and upload it. You can upload the same file again to update.")}</p>
    {Object.keys(cols).map(k => <form key={k} className="row" onSubmit={async e => { e.preventDefault(); try { const r = await api(s, `/api/import/${k}`, { method: "POST", body: new FormData(e.currentTarget) }); setMsg(t("{0}: {1} added, {2} updated, {3} errors {4}", k, r.inserted, r.updated, r.errors.length, r.errors.map((x: any) => `[row ${x.row}: ${x.error}]`).join(" "))); onUsage?.(r.usage); } catch (x: any) { setMsg(x.message); } }}>
      <label><b>{label(k)}</b> <a href="#" onClick={e => { e.preventDefault(); dl(k); }}>{t("download template")}</a></label>
      <div className="muted small">{cols[k].join(" · ")}</div>
      <input name="file" type="file" accept=".xlsx,.xls,.csv" required /><button className="sm">{t("Upload")}</button></form>)}
    <p className="muted">{t("Columns follow this company's attributes, units and custom fields. Units column format:")}{" "}<code>{t("PCS=1|BOX=12")}</code> {t("(blank = company default).")}</p><p>{msg}</p></>;
}
