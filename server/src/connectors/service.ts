// Runs connectors: event deliveries (through the retrying queue), scheduled pushes, pulls, inbound webhooks, file import/export.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { parseJson } from "../catalog.js";
import { applyMapping } from "./mapping.js";
import { plugin } from "./registry.js";
import { loadRecord, changedIds, stockRows } from "./records.js";
import { parseFile } from "./plugins/file.js";
import { upsertRows } from "../integrations/upserts.js";
import { setConnectorDeliver } from "../integrations/webhooks.js";
import type { Mapping, OutEntity, InEntity } from "./types.js";

export const EVENT_ENTITY: Record<string, OutEntity> = { order: "orders", invoice: "invoices", collection: "collections", stock: "stock" };
export type ConnRow = { id: number; company_id: number; name: string; type: string; enabled: boolean; mode: string; config: string; mapping: string; last_run_at: any; preset?: string | null; inbound_token?: string | null };
export const conf = (c: ConnRow) => parseJson<Record<string, any>>(c.config, {});
export const maps = (c: ConnRow) => parseJson<Mapping>(c.mapping, {});

async function records(db: Db, cid: number, entity: OutEntity, ids: number[] | null, since: string | null) {
  if (entity === "stock") return stockRows(db, cid);
  const list = ids ?? await changedIds(db, cid, entity, since, 1000);
  const out = []; for (const id of list) { const r = await loadRecord(db, cid, entity, id); if (r) out.push(r); }
  return out;
}

/** Deliver one queued connector event. Sample mode builds the request but never calls the network. */
async function deliver(db: Db, d: any, f: typeof fetch) {
  const c: ConnRow = (await db.query("SELECT * FROM connectors WHERE id=$1", [d.connector_id])).rows[0];
  if (!c) throw new Error("connector deleted");
  const p = await plugin(c.type); if (!p.send) throw new Error(`${p.label} cannot send events`);
  const { event, data } = JSON.parse(d.payload);
  const entity = EVENT_ENTITY[String(event).split(".")[0]]; if (!entity) throw new Error(`no entity for ${event}`);
  const record = entity === "stock" ? data : await loadRecord(db, c.company_id, entity, Number(data?.id));
  if (!record) throw new Error("record not found");
  const mapped = applyMapping(maps(c)[entity], record);
  const r = await p.send({ config: conf(c), entity, event, mapped, record, sample: c.mode !== "live", fetchImpl: f });
  return { code: r.status || null, sample: c.mode !== "live", detail: JSON.stringify(r.request ?? r.response ?? null).slice(0, 4000) };
}
setConnectorDeliver(deliver);

/** Preview: map the latest record of an entity and show what would be sent. Never calls the network. */
export async function preview(db: Db, c: ConnRow, entity: OutEntity) {
  const p = await plugin(c.type);
  const rec = (await records(db, c.company_id, entity, null, null)).slice(-1)[0];
  if (!rec) return { entity, record: null, mapped: null, request: null };
  const mapped = applyMapping(maps(c)[entity], rec);
  const req = p.send ? (await p.send({ config: conf(c), entity, event: "preview", mapped, record: rec, sample: true, fetchImpl: fetch }).catch((e: any) => ({ request: { error: e.message } }))).request : null;
  return { entity, record: rec, mapped, request: req };
}

export async function exportFile(db: Db, c: ConnRow, entity: OutEntity, format: string, since: string | null) {
  const p = await plugin(c.type); if (!p.exportFile) throw Object.assign(new Error(`${p.label} has no file export`), { status: 400 });
  const rows = (await records(db, c.company_id, entity, null, since)).map(r => applyMapping(maps(c)[entity], r));
  return p.exportFile({ entity, rows, format: format || conf(c).format || p.formats?.[0] || "csv", config: conf(c) });
}

/** Map external rows to OwnField fields and upsert them. */
export async function importRows(db: Db, c: ConnRow, entity: InEntity, rows: any[]) {
  const rules = maps(c)[entity];
  return upsertRows(db, c.company_id, entity, rows.slice(0, 5000).map(r => applyMapping(rules, r)));
}
export async function importFile(db: Db, c: ConnRow, entity: InEntity, buf: Buffer, name: string) {
  return importRows(db, c, entity, parseFile(buf, name));
}
export async function pull(db: Db, c: ConnRow, entity: InEntity, f: typeof fetch = fetch) {
  const p = await plugin(c.type); if (!p.pull) throw Object.assign(new Error(`${p.label} cannot pull`), { status: 400 });
  const raw = await p.pull({ config: conf(c), entity, sample: c.mode !== "live", fetchImpl: f });
  return { sample: c.mode !== "live", fetched: raw.length, ...(await importRows(db, c, entity, raw)) };
}

/** Folder for scheduled file drops: INTEGRATION_DROP_DIR/<company id>/<sub folder>. Off unless INTEGRATION_DROP_DIR is set. */
export function dropDir(c: ConnRow) {
  const root = process.env.INTEGRATION_DROP_DIR; const sub = String(conf(c).dropFolder || "").replace(/[^\w-]/g, "");
  if (!root || !sub) return null;
  return path.join(root, String(c.company_id), sub);
}

/** Scheduled runs: push changed records (REST) or write files to the drop folder. Called once a minute by the worker. */
export async function scheduleTick(db: Db, now = Date.now(), f: typeof fetch = fetch) {
  const list: ConnRow[] = (await db.query("SELECT * FROM connectors WHERE enabled=TRUE")).rows;
  for (const c of list) {
    const every = Number(conf(c).scheduleMinutes) || 0; if (every <= 0) continue;
    const last = c.last_run_at ? new Date(c.last_run_at).getTime() : 0; if (now - last < every * 60_000) continue;
    const since = c.last_run_at ? new Date(c.last_run_at).toISOString() : null;
    await db.query("UPDATE connectors SET last_run_at=$1 WHERE id=$2", [new Date(now).toISOString(), c.id]);
    try {
      const p = await plugin(c.type), m = maps(c);
      const ents = (Object.keys(m).filter(k => (p.out as string[]).includes(k)) as OutEntity[]);
      // Two-way: pull the listed inbound records (config.pull, e.g. "products,stock") on the same schedule.
      if (p.pull) for (const e of String(conf(c).pull || "").split(",").map(x => x.trim()).filter(x => (p.in as string[]).includes(x)))
        await pull(db, c, e as InEntity, f).catch((x: any) => console.error(`connector ${c.id} pull ${e}:`, x.message));
      if (p.send) {
        for (const e of ents) for (const id of e === "stock" ? [] : await changedIds(db, c.company_id, e, since))
          await db.query("INSERT INTO webhook_deliveries (company_id,connector_id,event,payload) VALUES ($1,$2,$3,$4)", [c.company_id, c.id, `${e.replace(/s$/, "")}.sync`, JSON.stringify({ event: `${e.replace(/s$/, "")}.sync`, data: { id } })]);
      } else if (p.exportFile && dropDir(c)) {
        const dir = dropDir(c)!; fs.mkdirSync(dir, { recursive: true });
        for (const e of ents.length ? ents : ["orders" as OutEntity]) { const f = await exportFile(db, c, e, conf(c).format, since); fs.writeFileSync(path.join(dir, f.filename), f.body); }
      }
    } catch (e: any) { console.error(`connector ${c.id} schedule:`, e.message); }
  }
}
export function startConnectorScheduler(db: Db) {
  const t = setInterval(() => scheduleTick(db).catch(e => console.error("connector scheduler:", e.message)), 60_000); t.unref(); return t;
}
