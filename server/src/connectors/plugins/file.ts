// File import/export: CSV, Excel or JSON, with the company's saved mapping. Optional server drop folder for scheduled exports.
import * as XLSX from "xlsx";
import type { ConnectorPlugin } from "../types.js";

/** One row per line item for documents with lines; header fields are repeated. Nested objects are flattened with dots. */
export function flatten(rows: Record<string, any>[]): Record<string, unknown>[] {
  const flat = (o: any, pre = "", out: Record<string, unknown> = {}) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (Array.isArray(v)) continue;
      if (v && typeof v === "object" && !(v instanceof Date)) flat(v, `${pre}${k}.`, out); else out[`${pre}${k}`] = v;
    }
    return out;
  };
  const res: Record<string, unknown>[] = [];
  for (const r of rows) {
    const arr = Object.entries(r).find(([, v]) => Array.isArray(v) && v.length && typeof v[0] === "object");
    const head = flat(r);
    if (!arr) { res.push(head); continue; }
    for (const l of arr[1] as any[]) res.push({ ...head, ...flat(l, `${arr[0]}.`) });
  }
  return res;
}
export function toCsv(rows: Record<string, unknown>[], delimiter = ",") {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const q = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(q).join(delimiter), ...rows.map(r => cols.map(c => q(r[c])).join(delimiter))].join("\r\n") + "\r\n";
}
/** Parse an uploaded CSV / Excel / JSON file into plain rows. */
export function parseFile(buf: Buffer, name: string): Record<string, unknown>[] {
  if (/\.json$/i.test(name)) { const j = JSON.parse(buf.toString("utf8")); return Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []; }
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, dense: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false }) as Record<string, unknown>[];
}

const plugin: ConnectorPlugin = {
  type: "file",
  label: "File (CSV / Excel / JSON)",
  description: "Download or upload files with your own column names. Use for any ERP or WMS that can read or write a spreadsheet.",
  configFields: [
    { key: "format", label: "Format", kind: "select", options: ["csv", "xlsx", "json"] },
    { key: "delimiter", label: "CSV delimiter", kind: "text", help: "default ," },
    { key: "dropFolder", label: "Server drop folder (optional)", kind: "text", help: "sub-folder under INTEGRATION_DROP_DIR; scheduled exports are written here" },
    { key: "scheduleMinutes", label: "Write changed records to the drop folder every N minutes (0 = off)", kind: "number" },
  ],
  out: ["orders", "invoices", "collections", "stock"],
  in: ["products", "stock", "customers", "distributors"],
  formats: ["csv", "xlsx", "json"],
  exportFile({ entity, rows, format, config }) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    if (format === "json") return { filename: `${entity}-${stamp}.json`, contentType: "application/json", body: JSON.stringify(rows, null, 2) };
    const flat = flatten(rows);
    if (format === "xlsx") {
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), entity);
      return { filename: `${entity}-${stamp}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
    }
    return { filename: `${entity}-${stamp}.csv`, contentType: "text/csv; charset=utf-8", body: toCsv(flat, config.delimiter || ",") };
  },
};
export default plugin;
