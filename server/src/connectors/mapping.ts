// No-code field mapping: a list of rules turns a OwnField record into an external record (outbound) or an external
// record into OwnField fields (inbound). Rules are plain JSON so the admin screen can edit them.
export type Rule = {
  /** Target field; dots create nested objects ("partner.ref"). */
  to: string;
  /** Source field path ("customer.code", "lines"); omit for constants. */
  from?: string;
  transform?: "rename" | "constant" | "date" | "number" | "lookup" | "upper" | "lower" | "template";
  /** constant value, or template text with {{path}} placeholders */
  value?: unknown;
  /** date pattern (YYYY, MM, DD, HH, mm, ss, e.g. "DD.MM.YYYY" or "YYYYMMDD") or number decimals ("2") */
  format?: string;
  /** lookup table: source value -> target value; "*" is the fallback */
  table?: Record<string, unknown>;
  default?: unknown;
  /** for array sources (order lines): rules applied to each element */
  each?: Rule[];
};

export function get(obj: any, path?: string): any {
  if (!path) return undefined;
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj: any, path: string, v: unknown) {
  const ks = path.split("."); let o = obj;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== "object") o[k] = {}; o = o[k]; }
  o[ks[ks.length - 1]] = v;
}
const pad = (n: number, l = 2) => String(n).padStart(l, "0");
export function formatDate(v: unknown, fmt = "YYYY-MM-DD") {
  if (v == null || v === "") return v;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  let p: number[];
  if (m) p = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
  else { const d = new Date(s); if (isNaN(+d)) return v; p = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]; }
  return fmt.replace("YYYY", pad(p[0], 4)).replace("MM", pad(p[1])).replace("DD", pad(p[2])).replace("HH", pad(p[3])).replace("mm", pad(p[4])).replace("ss", pad(p[5]));
}
export function fillTemplate(t: string, rec: any) {
  return t.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_m, k) => { const v = get(rec, k); return v == null ? "" : String(v); });
}
function one(r: Rule, rec: any): unknown {
  const src = get(rec, r.from);
  let v: unknown;
  switch (r.transform) {
    case "constant": v = r.value; break;
    case "template": v = fillTemplate(String(r.value ?? ""), rec); break;
    case "date": v = formatDate(src, r.format); break;
    case "number": { const n = Number(src); v = src == null || src === "" || isNaN(n) ? src : r.format !== undefined && r.format !== "" ? Number(n.toFixed(Number(r.format))) : n; break; }
    case "lookup": { const t = r.table || {}; const k = String(src ?? ""); v = k in t ? t[k] : "*" in t ? t["*"] : src; break; }
    case "upper": v = src == null ? src : String(src).toUpperCase(); break;
    case "lower": v = src == null ? src : String(src).toLowerCase(); break;
    default: v = src;
  }
  if (r.each && Array.isArray(src)) v = src.map(x => applyMapping(r.each!, { ...x, $parent: rec }));
  if ((v == null || v === "") && r.default !== undefined) v = r.default;
  return v;
}
/** Apply rules to a record. An empty rule list passes the record through unchanged. */
export function applyMapping(rules: Rule[] | undefined, rec: Record<string, any>): Record<string, any> {
  if (!rules || !rules.length) { const c = { ...rec }; delete c.$parent; return c; }
  const out: Record<string, any> = {};
  for (const r of rules) if (r && r.to) { const v = one(r, rec); if (v !== undefined) set(out, r.to, v); }
  return out;
}
/** Validate rules from the admin screen; returns an error string or null. */
export function checkRules(rules: unknown, depth = 0): string | null {
  if (!Array.isArray(rules)) return "mapping must be a list of rules";
  if (rules.length > 200) return "too many rules";
  for (const r of rules as any[]) {
    if (!r || typeof r.to !== "string" || !/^[\w$.\- ]{1,80}$/.test(r.to)) return "each rule needs a target field name";
    if (r.from != null && (typeof r.from !== "string" || r.from.length > 120)) return `bad source for ${r.to}`;
    if (r.transform && !["rename", "constant", "date", "number", "lookup", "upper", "lower", "template"].includes(r.transform)) return `unknown transform ${r.transform}`;
    if (r.each) { if (depth > 1) return "nesting too deep"; const e = checkRules(r.each, depth + 1); if (e) return e; }
  }
  return null;
}
