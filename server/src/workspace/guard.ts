// SPDX-License-Identifier: AGPL-3.0-only
// SQL guard for the Data Workspace. Layer 1 of 3 (layer 2: read-only transaction + company views + search_path;
// layer 3, when the database allows it: SET ROLE to a per-company read-only role that can only see its views).
// Accepts exactly one SELECT / WITH … SELECT. Rejects DDL/DML, multiple statements, catalogs, other schemas,
// non-whitelisted tables and any function not on the allow-list. Table names are rewritten to the company schema.
import { bad } from "../catalog.js";
import { SCHEMA } from "../db.js";
import { WS_TABLES } from "./tables.js";

export const FUNCS = new Set(("count sum avg min max round ceil floor abs coalesce nullif greatest least lower upper trim ltrim rtrim length substring substr " +
  "replace concat concat_ws left right position strpos split_part lpad rpad initcap date_trunc date_part extract to_char to_date to_number age now current_date " +
  "make_date string_agg array_agg bool_and bool_or every stddev variance percentile_cont percentile_disc mode row_number rank dense_rank ntile lag lead " +
  "first_value last_value cume_dist percent_rank cast sign power sqrt mod trunc ln exp generate_series date timestamp numeric text int integer bigint " +
  "float double precision interval json_build_object jsonb_build_object json_agg jsonb_agg to_json to_jsonb unnest").split(" "));
// Keywords that may be followed by "(" without being a function call.
const PAREN_OK = new Set("in exists any all some as over filter from join on select values and or not when then else case where with lateral using within group by partition order is distinct null over".split(" "));
const BLOCK = new Set(("insert update delete merge upsert drop create alter truncate grant revoke copy call do execute prepare deallocate set reset vacuum analyze " +
  "cluster reindex lock listen unlisten notify refresh comment security into load discard checkpoint import export begin commit rollback savepoint release " +
  "declare fetch move close owner").split(" "));
const ALL_TABLES = new Set([...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1].toLowerCase()).concat(["custom_reports", "ws_datasets"]));

type Tok = { t: "id" | "qid" | "str" | "num" | "op" | "ws"; v: string };
function tokenize(sql: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < sql.length) {
    const c = sql[i], rest = sql.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) { out.push({ t: "ws", v: " " }); i += m[0].length; continue; }
    if (rest.startsWith("--")) { const e = sql.indexOf("\n", i); i = e < 0 ? sql.length : e; out.push({ t: "ws", v: " " }); continue; }
    if (rest.startsWith("/*")) { const e = sql.indexOf("*/", i + 2); if (e < 0) throw bad("Unclosed comment"); i = e + 2; out.push({ t: "ws", v: " " }); continue; }
    if (c === "'") { let j = i + 1; for (;;) { if (j >= sql.length) throw bad("Unclosed text quote"); if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out.push({ t: "str", v: sql.slice(i, j + 1) }); i = j + 1; continue; }
    if (c === '"') { const e = sql.indexOf('"', i + 1); if (e < 0) throw bad("Unclosed name quote"); out.push({ t: "qid", v: sql.slice(i + 1, e) }); i = e + 1; continue; }
    if (c === "$") throw bad("$ quoting and $1 parameters are not allowed");
    if (/^[eEbBxXuU]&?'/.test(rest)) throw bad("Escaped/binary strings are not allowed");
    if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) { out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\d+(\.\d+)?([eE][+-]?\d+)?/))) { out.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^(::|<=|>=|<>|!=|\|\||[-+*/%<>=(),.;\[\]:])/))) { out.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
    throw bad(`Character "${c}" is not allowed`);
  }
  return out;
}

/** Validate user SQL and return SQL with table names pointed at the company schema. */
export function guardSql(sql: string, schema: string): string {
  if (typeof sql !== "string" || !sql.trim()) throw bad("Write a SELECT query");
  if (sql.length > 20000) throw bad("Query is too long (max 20 000 characters)");
  let toks = tokenize(sql);
  while (toks.length && (toks[toks.length - 1].t === "ws" || toks[toks.length - 1].v === ";")) toks = toks.slice(0, -1);
  const sig = toks.filter(x => x.t !== "ws");
  if (!sig.length) throw bad("Write a SELECT query");
  const first = sig[0].v.toLowerCase();
  if (sig[0].t !== "id" || !["select", "with"].includes(first)) throw bad("Only SELECT queries are allowed (start with SELECT or WITH)");
  const ctes = new Set<string>();
  for (let k = 0; k < sig.length; k++) {
    const x = sig[k], lv = x.v.toLowerCase(), prev = sig[k - 1], next = sig[k + 1];
    if (x.v === ";") throw bad("Only one statement at a time");
    if (x.t === "id" && BLOCK.has(lv)) throw bad(`"${x.v.toUpperCase()}" is not allowed: the workspace is read-only`);
    if (x.t === "id" || x.t === "qid") {
      if (/^pg_/.test(lv) || ["information_schema", "pg_catalog", "public", "pg_toast"].includes(lv) || /^ff_(c|bi|ro)/.test(lv)) throw bad(`"${x.v}" is not allowed. Use the tables listed in the schema browser.`);
      if (next?.v === "(" && x.t === "id" && !PAREN_OK.has(lv) && !(prev && /^(as)$/i.test(prev.v)) && !FUNCS.has(lv) && !ctes.has(lv))
        throw bad(`Function "${x.v}" is not allowed. Allowed: ${[...FUNCS].slice(0, 30).join(", ")} …`);
      if (x.t === "id" && next?.t === "id" && lv !== "as" && sig[k + 2]?.v === "(" && prev?.v?.toLowerCase() === "with") ctes.add(lv);
      if (prev?.v.toLowerCase() === "with" || prev?.v === ",") { if (next?.v.toLowerCase() === "as") ctes.add(lv); }
    }
  }
  // Rewrite bare table names (not part of a.b) to the company schema; block other real tables.
  return toks.map((x, k) => {
    if (x.t !== "id" && x.t !== "qid") return x.v;
    const lv = x.v.toLowerCase(); const before = prevSig(toks, k), after = nextSig(toks, k);
    if (before?.v === "." || after?.v === "." || ctes.has(lv)) return x.t === "qid" ? `"${x.v}"` : x.v;
    if (WS_TABLES[lv] && isTablePos(toks, k)) return `${schema}.${lv}`;
    if (ALL_TABLES.has(lv) && !WS_TABLES[lv]) throw bad(`Table "${x.v}" is not available in the workspace`);
    return x.t === "qid" ? `"${x.v}"` : x.v;
  }).join("");
}
const prevSig = (t: Tok[], k: number) => { for (let j = k - 1; j >= 0; j--) if (t[j].t !== "ws") return t[j]; };
const nextSig = (t: Tok[], k: number) => { for (let j = k + 1; j < t.length; j++) if (t[j].t !== "ws") return t[j]; };
/** A name is in table position after FROM / JOIN, or after a comma inside a FROM list. */
function isTablePos(t: Tok[], k: number) {
  const p = prevSig(t, k); if (!p) return false; const pv = p.v.toLowerCase();
  if (pv === "from" || pv === "join") return true;
  if (pv !== ",") return false;
  let depth = 0; // walk back to the clause that owns this comma
  for (let j = k - 1; j >= 0; j--) { const v = t[j].v.toLowerCase(); if (v === ")") depth++; else if (v === "(") { if (!depth) return false; depth--; }
    else if (!depth && t[j].t === "id") { if (v === "from") return true; if (["select", "where", "group", "order", "having", "on", "by", "values", "limit"].includes(v)) return false; } }
  return false;
}
