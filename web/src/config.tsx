import React, { useEffect, useState } from "react";
import { api, Table, label, type Session, type Cfg } from "./main";
import { GstSettings } from "./step4";
import { PoSettings, poForSave } from "./po";
import { CreditSettings } from "./collect";

type P = { s: Session; cfg: Cfg; reload: () => void; onUsage?: (u: any) => void };
const FEATURES: [string, string][] = [["stock", "Stock tracking"], ["batches", "Batch & expiry (FEFO)"], ["sizeGrid", "Size-grid ordering"], ["gps", "GPS check-in required"],
  ["schemes", "Schemes / discounts"], ["drugLicence", "Drug licence numbers"], ["services", "Service (non-stock) items"], ["photos", "Visit photos"], ["invoicing", "GST invoicing & credit notes"], ["purchaseOrders", "Purchase orders from distributors"], ["distributorBilling", "Distributors invoice under their own GSTIN"]];
export const attrText = (a: Record<string, string>) => Object.values(a || {}).join(" / ");
const unitsText = (u: { code: string; factor: number }[]) => u.map(x => `${x.code}=${x.factor}`).join(", ");

export function CustomInputs({ defs, value, onChange }: { defs: any[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  return <>{defs.map(d => <label key={d.key} className="fld"><span>{d.label}{d.required ? " *" : ""}</span>
    {d.type === "select" ? <select value={value[d.key] ?? ""} onChange={e => onChange({ ...value, [d.key]: e.target.value })}><option value="">—</option>{d.options.map((o: string) => <option key={o}>{o}</option>)}</select>
      : <input type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} value={value[d.key] ?? ""} onChange={e => onChange({ ...value, [d.key]: e.target.value })} />}</label>)}</>;
}

export function Catalog({ s, cfg }: P) {
  const [items, setItems] = useState<any[]>([]); useEffect(() => { api(s, "/api/items").then(setItems); }, []);
  const pf = cfg.settings.customFields.product;
  return <><h2>Catalogue</h2>{!items.length && <p className="muted">No products yet — import them or load the sample data in Settings.</p>}
    {items.map(i => <div className="row" key={i.id}><b>{i.name}</b> <span className="muted">{i.code}{i.category ? ` · ${i.category}` : ""}{i.hsn ? ` · HSN ${i.hsn}` : ""}</span>
      {i.kind === "service" && <span className="pill">service</span>}
      <div className="muted">Units: {unitsText(i.uoms)}{pf.filter(f => i.custom[f.key] != null).map(f => ` · ${f.label}: ${i.custom[f.key]}`).join("")}</div>
      <Table rows={i.variants.map((v: any) => ({ ...v, variant: attrText(v.attrs) }))} cols={["sku", "variant", "mrp", "billing_price"]} /></div>)}</>;
}

export function Stock({ s, cfg }: P) {
  const [rows, setRows] = useState<any[]>([]); const [msg, setMsg] = useState("");
  const load = () => api(s, "/api/stock").then(setRows); useEffect(() => { load(); }, []);
  const b = cfg.settings.features.batches;
  return <><h2>Stock</h2>
    <Table rows={rows.map(r => ({ ...r, item: `${r.item_name} ${attrText(r.attrs)}`, status: r.expired ? "EXPIRED" : r.qty > 0 ? "ok" : "nil" }))}
      cols={["location", "sku", "item", ...(b ? ["batch_no", "expiry"] : []), "qty", "status"]} />
    <form className="row" onSubmit={async e => { e.preventDefault(); try { const r = await api(s, "/api/import/stock", { method: "POST", body: new FormData(e.currentTarget) }); setMsg(`${r.inserted} added, ${r.updated} updated${r.errors.map((x: any) => ` [row ${x.row}: ${x.error}]`).join("")}`); load(); } catch (x: any) { setMsg(x.message); } }}>
      <label>Upload stock (.xlsx/.csv) — sets quantity per SKU{b ? " + batch" : ""}</label><input name="file" type="file" accept=".xlsx,.xls,.csv" required /><button className="sm">Upload</button></form>
    <p className="muted">Columns: SKU, Qty, Unit{b ? ", Batch, Expiry" : ""}{s.user.role !== "distributor" ? ", Distributor Email (blank = company stock)" : ""}. {b && "Orders are allocated first-expiry-first-out; expired batches are never allocated."}</p><p>{msg}</p></>;
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
    setMsg("Scheme added"); setF(blank); load(); } catch (x: any) { setMsg(x.message); } };
  return <><h2>Schemes</h2>
    <Table rows={rows.map(r => ({ ...r, applies_to: [r.item_name || (r.category ? `Category ${r.category}` : "All items"), r.distributor_name && `via ${r.distributor_name}`].filter(Boolean).join(" "),
      valid: `${r.starts_on || "…"} → ${r.ends_on || "…"}`, status: r.live ? "live" : r.active ? "not in date range" : "off" }))} cols={["name", "rule", "applies_to", "min_qty", "valid", "status"]} />
    {rows.map(r => <button key={r.id} className="sm ghost" onClick={() => api(s, `/api/schemes/${r.id}/active`, { method: "POST", body: JSON.stringify({ active: !r.active }) }).then(load)}>{r.active ? "Turn off" : "Turn on"} {r.name}</button>)}
    <form onSubmit={save}><h3>New scheme</h3>{inp("name", "Name")}
      <select value={f.type} onChange={e => setF({ ...f, type: e.target.value })}><option value="percent">Percent off</option><option value="flat">Flat ₹ off per unit</option><option value="bxgy">Buy X get Y free</option><option value="slab">Quantity / value slabs</option></select>
      {f.type === "percent" && inp("discountPct", "Discount %")}{f.type === "flat" && inp("amount", "₹ off per base unit")}
      {f.type === "bxgy" && <>{inp("buy", "Buy (base units)")}{inp("get", "Get free")}</>}
      {f.type === "slab" && <><select value={f.basis} onChange={e => setF({ ...f, basis: e.target.value })}><option value="qty">By quantity</option><option value="value">By line value ₹</option></select>{inp("slabs", "Slabs min:pct, e.g. 12:5, 24:8")}</>}
      <select value={f.itemId} onChange={e => setF({ ...f, itemId: e.target.value })}><option value="">Any product</option>{items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">Any category</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
      <select value={f.distributorId} onChange={e => setF({ ...f, distributorId: e.target.value })}><option value="">All distributors</option>{dists.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      {inp("minQty", "Min qty (base units)")}<label className="small">From <input type="date" value={f.startsOn} onChange={e => setF({ ...f, startsOn: e.target.value })} /></label>
      <label className="small">To <input type="date" value={f.endsOn} onChange={e => setF({ ...f, endsOn: e.target.value })} /></label>
      <button>Add</button><p>{msg}</p></form></>;
}

const cfText = (list: any[]) => list.map(f => [f.label, f.type, (f.options || []).join(","), f.required ? "required" : ""].join(" | ").replace(/( \| )+$/, "")).join("\n");
const cfParse = (t: string) => t.split("\n").map(l => l.trim()).filter(Boolean).map(l => { const [lbl, type = "text", options = "", req = ""] = l.split("|").map(x => x.trim()); return { label: lbl, type, options, required: /req/i.test(req) || /req/i.test(options) && type !== "select" }; });

export function SettingsPage({ s, cfg, reload }: P) {
  const st = cfg.settings;
  const [industry, setIndustry] = useState(cfg.industry); const [tpl, setTpl] = useState<any[]>([]);
  const [features, setFeatures] = useState({ ...st.features }); const [attrs, setAttrs] = useState(st.attributes.join(", ")); const [units, setUnits] = useState(unitsText(st.uoms));
  const [cf, setCf] = useState<Record<string, string>>({ outlet: cfText(st.customFields.outlet), product: cfText(st.customFields.product), visit: cfText(st.customFields.visit) });
  const [msg, setMsg] = useState(""); const [gst, setGst] = useState<any>({ ...(st as any).gst }); const [po, setPo] = useState<any>({ ...(st as any).po });
  const [credit, setCredit] = useState<any>({ days: 0, limit: 0, onBreach: "warn", ...(st as any).credit });
  useEffect(() => { api(null, "/api/templates").then(setTpl); }, []);
  useEffect(() => { setFeatures({ ...st.features }); setAttrs(st.attributes.join(", ")); setUnits(unitsText(st.uoms)); setCf({ outlet: cfText(st.customFields.outlet), product: cfText(st.customFields.product), visit: cfText(st.customFields.visit) }); setGst({ ...(st as any).gst }); setPo({ ...(st as any).po }); }, [cfg]);
  const put = async (body: any, ok: string) => { try { await api(s, "/api/company/settings", { method: "PUT", body: JSON.stringify(body) }); setMsg(ok); reload(); } catch (x: any) { setMsg(x.message); } };
  return <><h2>Company settings</h2>
    <label>Industry template</label>
    <select value={industry} onChange={e => setIndustry(e.target.value)}>{tpl.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
    <p className="muted">{tpl.find(t => t.id === industry)?.description}</p>
    <button className="sm ghost" onClick={() => confirm("Reset features, attributes, units and custom fields to this template?") && put({ industry, applyTemplate: true }, "Template applied")}>Apply template</button>{" "}
    <button className="sm ghost" onClick={async () => { const r = await api(s, "/api/company/sample-data", { method: "POST" }); setMsg(`Sample data loaded: ${r.products.inserted + r.products.updated} variants, ${r.shops.inserted + r.shops.updated} outlets${r.stock ? `, ${r.stock.inserted + r.stock.updated} stock rows` : ""}`); }}>Load sample data</button>
    <h3>Features</h3>
    {FEATURES.map(([k, l]) => <label key={k} className="chk"><input type="checkbox" checked={!!features[k]} onChange={e => setFeatures({ ...features, [k]: e.target.checked })} />{l}</label>)}
    <h3>Product model</h3>
    <label className="fld"><span>Variant attributes (comma separated, e.g. size, colour)</span><input value={attrs} onChange={e => setAttrs(e.target.value)} /></label>
    <label className="fld"><span>Units with conversion to base unit (base = 1), e.g. PCS=1, BOX=12, CASE=144</span><input value={units} onChange={e => setUnits(e.target.value)} /></label>
    <h3>Custom fields</h3><p className="muted">One per line: <code>Label | text/number/date/select | options,comma,separated | required</code></p>
    {(["outlet", "product", "visit"] as const).map(e => <label key={e} className="fld"><span>{label(e)} fields</span><textarea rows={3} value={cf[e]} onChange={x => setCf({ ...cf, [e]: x.target.value })} /></label>)}
    {features.invoicing && <GstSettings g={gst} onChange={setGst} />}
    {features.purchaseOrders && <PoSettings po={po} onChange={setPo} />}
    {features.invoicing && <CreditSettings c={credit} onChange={setCredit} />}
    <button onClick={() => put({ industry, features, attributes: attrs, uoms: units, ...(features.invoicing ? { gst: { ...gst, defaultRate: Number(gst.defaultRate) } } : {}), ...(features.purchaseOrders ? { po: poForSave(po) } : {}), ...(features.invoicing ? { credit: { days: Number(credit.days), limit: Number(credit.limit), onBreach: credit.onBreach } } : {}), customFields: { outlet: cfParse(cf.outlet), product: cfParse(cf.product), visit: cfParse(cf.visit) } }, "Settings saved")}>Save settings</button>
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
  return <><h2>Import from Excel / CSV</h2>
    {Object.keys(cols).map(k => <form key={k} className="row" onSubmit={async e => { e.preventDefault(); try { const r = await api(s, `/api/import/${k}`, { method: "POST", body: new FormData(e.currentTarget) }); setMsg(`${k}: ${r.inserted} added, ${r.updated} updated, ${r.errors.length} errors ${r.errors.map((x: any) => `[row ${x.row}: ${x.error}]`).join(" ")}`); onUsage?.(r.usage); } catch (x: any) { setMsg(x.message); } }}>
      <label><b>{label(k)}</b> <a href="#" onClick={e => { e.preventDefault(); dl(k); }}>download template</a></label>
      <div className="muted small">{cols[k].join(" · ")}</div>
      <input name="file" type="file" accept=".xlsx,.xls,.csv" required /><button className="sm">Upload</button></form>)}
    <p className="muted">Columns follow this company's attributes, units and custom fields. Units column format: <code>PCS=1|BOX=12</code> (blank = company default).</p><p>{msg}</p></>;
}
