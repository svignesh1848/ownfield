import React, { useEffect, useState } from "react";
import { api, Table, type ViewProps } from "./main";
import { t } from "./i18n";
import { Field, toast, Loading } from "./ui";

/** Admin Integrations screen: API keys, webhooks, connectors (with field mapper) and the delivery log. */
export function Integrations({ s }: ViewProps) {
  const [tab, setTab] = useState("keys");
  return <><h2>{t("Integrations")}</h2>
    <p className="muted">{t("Connect FieldForce to your ERP, accounting or warehouse system. API docs:")}{" "}<a href="/api/v1/docs" target="_blank">/api/v1/docs</a></p>
    <div className="row-btns">{[["keys", t("API keys")], ["hooks", t("Webhooks")], ["conn", t("Connectors")], ["log", t("Delivery log")]].map(([k, l]) =>
      <button key={k} className={tab === k ? "sm" : "sm ghost"} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "keys" && <Keys s={s} />}{tab === "hooks" && <Hooks s={s} />}{tab === "conn" && <Connectors s={s} />}{tab === "log" && <Log s={s} />}</>;
}
const run = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e: any) { toast(e.message, "err"); } };

function Keys({ s }: { s: any }) {
  const [d, setD] = useState<any>(null), [name, setName] = useState(""), [sc, setSc] = useState<string[]>([]), [shown, setShown] = useState("");
  const load = () => api(s, "/api/integrations/keys").then(setD); useEffect(() => { load(); }, []);
  if (!d) return <Loading />;
  return <>
    {shown && <div className="hint"><b>{t("New key (copy it now, it is not shown again):")}</b><br /><code>{shown}</code></div>}
    <form className="card" onSubmit={async e => { e.preventDefault(); const r = await run(() => api(s, "/api/integrations/keys", { method: "POST", body: JSON.stringify({ name, scopes: sc }) })); if (r) { setShown(r.key); setName(""); load(); } }}>
      <Field label={t("Key name")}><input value={name} onChange={e => setName(e.target.value)} placeholder={t("e.g. ERP sync")} /></Field>
      <div>{d.scopes.map((x: string) => <label key={x} style={{ display: "inline-block", marginRight: 12 }}><input type="checkbox" checked={sc.includes(x)} onChange={e => setSc(e.target.checked ? [...sc, x] : sc.filter(y => y !== x))} /> {x}</label>)}</div>
      <button>{t("Create key")}</button></form>
    <Table rows={d.keys.map((k: any) => ({ ...k, scopes: k.scopes.join(", "), status: k.revoked_at ? "revoked" : "active" }))} cols={["name", "prefix", "scopes", "last_used_at", "status"]} empty={{ title: t("No API keys yet") }} />
    {d.keys.filter((k: any) => !k.revoked_at).map((k: any) => <button key={k.id} className="sm ghost" onClick={() => confirm(t("Revoke {0}?", k.name)) && run(() => api(s, `/api/integrations/keys/${k.id}`, { method: "DELETE" })).then(load)}>{t("Revoke")}{" "}{k.name}</button>)}
  </>;
}

function Hooks({ s }: { s: any }) {
  const [d, setD] = useState<any>(null), [url, setUrl] = useState(""), [ev, setEv] = useState<string[]>(["order.created"]), [secret, setSecret] = useState("");
  const load = () => api(s, "/api/integrations/webhooks").then(setD); useEffect(() => { load(); }, []);
  if (!d) return <Loading />;
  return <>
    {secret && <div className="hint"><b>{t("Signing secret (copy it now):")}</b> <code>{secret}</code></div>}
    <form className="card" onSubmit={async e => { e.preventDefault(); const r = await run(() => api(s, "/api/integrations/webhooks", { method: "POST", body: JSON.stringify({ url, events: ev }) })); if (r) { setSecret(r.secret); setUrl(""); load(); } }}>
      <Field label={t("URL (https)")}><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://erp.example.com/hooks/fieldforce" /></Field>
      <div>{d.events.filter((x: string) => x !== "test.ping").map((x: string) => <label key={x} style={{ display: "inline-block", marginRight: 12 }}><input type="checkbox" checked={ev.includes(x)} onChange={e => setEv(e.target.checked ? [...ev, x] : ev.filter(y => y !== x))} /> {x}</label>)}</div>
      <button>{t("Add webhook")}</button></form>
    <Table rows={d.webhooks.map((w: any) => ({ ...w, events: w.events.join(", ") }))} cols={["url", "events", "active"]} empty={{ title: t("No webhooks yet") }} />
    {d.webhooks.map((w: any) => <div key={w.id} className="row-btns"><span className="muted">{w.url}</span>
      <button className="sm ghost" onClick={async () => { const r = await run(() => api(s, `/api/integrations/webhooks/${w.id}/test`, { method: "POST" })); if (r) toast(t("Test: {0}{1}", r.status, r.last_error ? " — " + r.last_error : ""), r.status === "delivered" ? "ok" : "err"); }}>{t("Test send")}</button>
      <button className="sm ghost" onClick={() => run(() => api(s, `/api/integrations/webhooks/${w.id}`, { method: "PATCH", body: JSON.stringify({ active: !w.active }) })).then(load)}>{w.active ? t("Pause") : t("Resume")}</button>
      <button className="sm ghost" onClick={() => confirm(t("Delete this webhook?")) && run(() => api(s, `/api/integrations/webhooks/${w.id}`, { method: "DELETE" })).then(load)}>{t("Delete")}</button></div>)}
  </>;
}

const TRANSFORMS = ["rename", "constant", "date", "number", "lookup", "upper", "lower", "template"];
function Mapper({ fields, rules, onChange }: { fields: string[]; rules: any[]; onChange: (r: any[]) => void }) {
  const upd = (i: number, k: string, v: any) => onChange(rules.map((r, j) => j === i ? { ...r, [k]: v } : r));
  return <div className="scroll"><table><thead><tr><th>{t("FieldForce field")}</th><th>{t("Transform")}</th><th>{t("Value / format")}</th><th>{t("External field")}</th><th /></tr></thead><tbody>
    {rules.map((r, i) => <tr key={i}>
      <td><select value={r.from || ""} onChange={e => upd(i, "from", e.target.value || undefined)}><option value="">—</option>{fields.filter(f => !f.includes("[]")).map(f => <option key={f}>{f}</option>)}{r.from && !fields.includes(r.from) && <option>{r.from}</option>}</select>{r.each && <div className="muted">+{r.each.length} {t("line rules")}</div>}</td>
      <td><select value={r.transform || "rename"} onChange={e => upd(i, "transform", e.target.value)}>{TRANSFORMS.map(t => <option key={t}>{t}</option>)}</select></td>
      <td>{r.transform === "lookup"
        ? <input value={Object.entries(r.table || {}).map(([a, b]) => `${a}=${b}`).join(";")} placeholder={t("cash=Cash;*=Bank")} onChange={e => upd(i, "table", Object.fromEntries(e.target.value.split(";").filter(Boolean).map(p => p.split("="))))} />
        : ["date", "number"].includes(r.transform) ? <input value={r.format || ""} placeholder={r.transform === "date" ? t("DD.MM.YYYY") : "2"} onChange={e => upd(i, "format", e.target.value)} />
        : ["constant", "template"].includes(r.transform) ? <input value={String(r.value ?? "")} onChange={e => upd(i, "value", e.target.value)} /> : null}</td>
      <td><input value={r.to} onChange={e => upd(i, "to", e.target.value)} /></td>
      <td><button className="sm ghost" onClick={() => onChange(rules.filter((_, j) => j !== i))}>✕</button></td></tr>)}
  </tbody></table><button className="sm ghost" onClick={() => onChange([...rules, { to: "", transform: "rename" }])}>{t("+ Add field")}</button>
    <p className="muted">{t("No rules = send FieldForce field names as they are. Line items: edit as JSON below.")}</p></div>;
}

function Connectors({ s }: { s: any }) {
  const [d, setD] = useState<any>(null), [open, setOpen] = useState<any>(null), [ent, setEnt] = useState("orders"), [out, setOut] = useState<any>(null);
  const load = () => api(s, "/api/integrations/connectors").then(x => { setD(x); return x; }); useEffect(() => { load(); }, []);
  if (!d) return <Loading />;
  const add = async (body: any) => { const c = await run(() => api(s, "/api/integrations/connectors", { method: "POST", body: JSON.stringify(body) })); if (c) { await load(); setOpen(c); } };
  const save = async (patch: any) => { const c = await run(() => api(s, `/api/integrations/connectors/${open.id}`, { method: "PATCH", body: JSON.stringify(patch) })); if (c) { setOpen(c); load(); } };
  const type = open && d.types.find((t: any) => t.type === open.type);
  return <>
    <div className="card"><b>{t("Add a connector")}</b><div className="row-btns">
      {d.types.map((t: any) => <button key={t.type} className="sm" onClick={() => add({ type: t.type })}>{t.label}</button>)}
      {d.presets.map((p: any) => <button key={p.id} className="sm ghost" title={p.note} onClick={() => add({ preset: p.id })}>{p.label}</button>)}</div>
      <p className="muted">{t("Presets are ready-made field mappings on top of Custom REST or File. Everything starts in sample mode: nothing is sent until you switch to live.")}</p></div>
    <Table rows={d.connectors.map((c: any) => ({ ...c, open: c.id }))} cols={["name", "type", "enabled", "mode", "last_run_at"]} empty={{ title: t("No connectors yet") }} />
    <div className="row-btns">{d.connectors.map((c: any) => <button key={c.id} className="sm ghost" onClick={() => { setOpen(c); setOut(null); }}>{t("Open")}{" "}{c.name}</button>)}</div>
    {open && type && <div className="card"><h3>{open.name} <span className="muted">({type.label})</span></h3>
      <label><input type="checkbox" checked={open.enabled} onChange={e => save({ enabled: e.target.checked })} /> {t("On")}</label>{" "}
      <label><input type="checkbox" checked={open.mode === "live"} onChange={e => save({ mode: e.target.checked ? "live" : "sample" })} /> {t("Live (unticked = sample mode, no network calls)")}</label>
      <form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); save({ config: Object.fromEntries(type.configFields.map((x: any) => [x.key, x.kind === "number" ? Number(f.get(x.key)) : f.get(x.key)])) }); }}>
        {type.configFields.map((x: any) => <Field key={x.key} label={x.label} help={x.help}>{x.kind === "select"
          ? <select name={x.key} defaultValue={open.config[x.key] || ""}>{x.options.map((o: string) => <option key={o}>{o}</option>)}</select>
          : x.kind === "json" ? <textarea name={x.key} rows={4} defaultValue={typeof open.config[x.key] === "string" ? open.config[x.key] : JSON.stringify(open.config[x.key] ?? {}, null, 1)} />
          : <input name={x.key} type={x.kind === "secret" ? "password" : x.kind === "number" ? "number" : "text"} defaultValue={open.config[x.key] ?? ""} />}</Field>)}
        <button>{t("Save settings")}</button></form>
      <h4>{t("Field mapping")}</h4>
      <Field label={t("Record")}><select value={ent} onChange={e => setEnt(e.target.value)}>{[...type.out, ...type.in].map((x: string) => <option key={x}>{x}</option>)}</select></Field>
      <Mapper fields={d.fields[ent] || []} rules={open.mapping[ent] || []} onChange={r => setOpen({ ...open, mapping: { ...open.mapping, [ent]: r } })} />
      <details><summary>{t("Edit mapping as JSON")}</summary><textarea rows={8} style={{ width: "100%" }} value={JSON.stringify(open.mapping[ent] || [], null, 1)} onChange={e => { try { setOpen({ ...open, mapping: { ...open.mapping, [ent]: JSON.parse(e.target.value) } }); } catch { /* typing */ } }} /></details>
      <button onClick={() => save({ mapping: open.mapping })}>{t("Save mapping")}</button>
      <div className="row-btns">
        {type.out.includes(ent) && <button className="sm ghost" onClick={async () => setOut(await run(() => api(s, `/api/integrations/connectors/${open.id}/preview`, { method: "POST", body: JSON.stringify({ entity: ent }) })))}>{t("Preview")}</button>}
        {type.canSend && <button className="sm ghost" onClick={async () => setOut(await run(() => api(s, `/api/integrations/connectors/${open.id}/test`, { method: "POST" })))}>{t("Test send (latest order)")}</button>}
        {type.canExport && type.out.includes(ent) && <a className="btn sm ghost" href="#" onClick={async e => { e.preventDefault(); const r = await fetch(`/api/integrations/connectors/${open.id}/export?entity=${ent}`, { headers: { Authorization: `Bearer ${s.token}` } }); if (!r.ok) return toast(t("Export failed"), "err"); const b = await r.blob(); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = (r.headers.get("Content-Disposition") || "").split('"')[1] || "export"; a.click(); }}>{t("Download file")}</a>}
        {type.canPull && type.in.includes(ent) && <button className="sm ghost" onClick={async () => setOut(await run(() => api(s, `/api/integrations/connectors/${open.id}/pull`, { method: "POST", body: JSON.stringify({ entity: ent }) })))}>{t("Pull now")}</button>}
        {type.in.includes(ent) && <label className="btn sm ghost">{t("Import file")}<input type="file" hidden accept=".csv,.xlsx,.xls,.json" onChange={async e => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append("file", f); setOut(await run(() => api(s, `/api/integrations/connectors/${open.id}/import?entity=${ent}`, { method: "POST", body: fd }))); }} /></label>}
        <button className="sm ghost" onClick={() => confirm(t("Delete this connector?")) && run(() => api(s, `/api/integrations/connectors/${open.id}`, { method: "DELETE" })).then(() => { setOpen(null); load(); })}>{t("Delete")}</button>
      </div>
      {open.inbound_path && <p className="muted">{t("Inbound webhook:")}{" "}<code>{t("POST")}{" "}{location.origin}{open.inbound_path}</code> {t("(entity = products, stock, customers or distributors; connector must be On)")}</p>}
      {out && <pre style={{ maxHeight: 300, overflow: "auto" }}>{JSON.stringify(out, null, 1)}</pre>}
    </div>}
  </>;
}

function Log({ s }: { s: any }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => api(s, "/api/integrations/deliveries").then(setRows); useEffect(() => { load(); }, []);
  return <><button className="sm ghost" onClick={load}>{t("Refresh")}</button>
    <Table rows={rows} cols={["created_at", "event", "target", "status", "attempts", "response_code", "last_error"]} empty={{ title: t("Nothing sent yet") }} />
    {rows?.filter(r => r.status === "failed").map(r => <button key={r.id} className="sm ghost" onClick={() => run(() => api(s, `/api/integrations/deliveries/${r.id}/retry`, { method: "POST" })).then(load)}>{t("Retry #")}{r.id}</button>)}</>;
}
