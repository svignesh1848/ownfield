// Shared CSV helpers: quote cells and neutralize spreadsheet formulas (=, +, -, @, tab, CR).
export function csvCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function sanitizeRow<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => {
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(v)) return [k, `'${v}`];
    return [k, v];
  })) as T;
}

export function toCsv(rows: Record<string, unknown>[], delimiter = ",") {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const q = (v: unknown) => {
    const s = csvCell(v);
    return /["\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(q).join(delimiter), ...rows.map(r => cols.map(c => q(r[c])).join(delimiter))].join("\n");
}
