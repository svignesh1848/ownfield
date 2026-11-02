// Retailer account view (retailer app): invoices (open / print to PDF), account statement with running balance and a
// date filter, payment history, outstanding with ageing, credit limit and available credit, and sales returns.
// A retailer only ever sees its own outlet.
import { bad, getCompany, parseJson, today } from "./catalog.js";
import { type Ctx } from "./common.js";
import { ledger, creditTerms } from "./collections.js";
import { loadInvoice, invoiceHtml, r2 } from "./billing.js";
import { einvBlock } from "./einvoice.js";
import type { Db } from "./db.js";

async function myShop(db: Db, req: any, cid: number) {
  const { settings } = await getCompany(db, cid);
  if (!settings.features.retailerApp) throw bad("the retailer app is turned off for this company", 403);
  const u = (await db.query("SELECT shop_id FROM users WHERE id=$1 AND company_id=$2", [req.user.uid, cid])).rows[0];
  if (!u?.shop_id) throw bad("your login is not linked to an outlet", 403);
  return { shop: (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [u.shop_id, cid])).rows[0], settings };
}
const okDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;

/** Statement lines for one outlet: invoices (debit), credit notes and cleared payments (credit), with running balance. */
export async function statement(db: Db, cid: number, shopId: number, from: string | null, to: string | null) {
  const docs = (await db.query("SELECT id, kind, number, doc_date, total, ref_invoice_id, reason, issuer FROM invoices WHERE company_id=$1 AND shop_id=$2 ORDER BY doc_date, id", [cid, shopId])).rows;
  const pays = (await db.query("SELECT id, number, pay_date, mode, reference, amount, status, bounce_reason FROM payments WHERE company_id=$1 AND shop_id=$2 ORDER BY pay_date, id", [cid, shopId])).rows;
  const refNo = new Map(docs.map((d: any) => [d.id, d.number]));
  const all = [
    ...docs.map((d: any) => ({ date: d.doc_date, sort: `${d.doc_date}|1|${d.id}`, type: d.kind === "invoice" ? "Invoice" : "Credit note", number: d.number, doc_id: d.id,
      detail: d.kind === "credit_note" ? [d.reason, d.ref_invoice_id ? `against ${refNo.get(d.ref_invoice_id) || ""}` : ""].filter(Boolean).join(" · ") : "",
      debit: d.kind === "invoice" ? Number(d.total) : 0, credit: d.kind === "credit_note" ? Number(d.total) : 0 })),
    ...pays.filter((p: any) => p.status === "cleared").map((p: any) => ({ date: p.pay_date, sort: `${p.pay_date}|2|${p.id}`, type: "Payment", number: p.number, doc_id: null,
      detail: `${String(p.mode).toUpperCase()}${p.reference ? ` · ${p.reference}` : ""}`, debit: 0, credit: Number(p.amount) })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));
  let bal = 0, opening = 0; const lines: any[] = [];
  for (const x of all) {
    bal = r2(bal + x.debit - x.credit);
    if (from && x.date < from) { opening = bal; continue; }
    if (to && x.date > to) continue;
    const { sort, ...rest } = x; void sort; lines.push({ ...rest, balance: bal });
  }
  const closing = lines.length ? lines[lines.length - 1].balance : opening;
  return { from, to, opening, closing, debit: r2(lines.reduce((a, l) => a + l.debit, 0)), credit: r2(lines.reduce((a, l) => a + l.credit, 0)), lines,
    payments: pays.map((p: any) => ({ ...p, amount: Number(p.amount) })).reverse() };
}

export function registerAccountRoutes2({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/retailer/account", auth("retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { shop, settings } = await myShop(db, req, cid);
    const from = okDate(req.query.from), to = okDate(req.query.to);
    if (from && to && from > to) throw bad("from must be on or before to");
    const terms = creditTerms(settings, shop);
    const { invoices, advances } = await ledger(db, cid, { shopId: shop.id }, today());
    const advance = r2(advances.reduce((a, x) => a + x.amount, 0));
    const open = invoices.filter(i => i.outstanding > 0.004);
    const outstanding = r2(open.reduce((a, i) => a + i.outstanding, 0) - advance);
    const ageing: Record<string, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    for (const i of open) ageing[i.bucket] = r2(ageing[i.bucket] + i.outstanding);
    const overdue = terms.days ? r2(open.filter(i => i.age > terms.days).reduce((a, i) => a + i.outstanding, 0)) : 0;
    const docs = (await db.query("SELECT id, kind, number, doc_date, total, ref_invoice_id FROM invoices WHERE company_id=$1 AND shop_id=$2 ORDER BY doc_date DESC, id DESC", [cid, shop.id])).rows;
    const byId = new Map(invoices.map(i => [i.id, i]));
    const st = await statement(db, cid, shop.id, from, to);
    const returns = (await db.query(`SELECT r.id, r.created_at, r.status, r.reason, cn.number AS credit_note, cn.total AS credit_total, i.number AS invoice FROM sales_returns r
      LEFT JOIN invoices cn ON cn.id=r.credit_note_id LEFT JOIN invoices i ON i.id=r.invoice_id WHERE r.company_id=$1 AND r.shop_id=$2 ORDER BY r.id DESC`, [cid, shop.id])).rows
      .map((r: any) => ({ ...r, credit_total: r.credit_total == null ? null : Number(r.credit_total) }));
    res.json({ shop: { id: shop.id, code: shop.code, name: shop.name },
      credit: { limit: terms.limit || 0, days: terms.days || 0, outstanding, available: terms.limit ? r2(Math.max(0, terms.limit - Math.max(0, outstanding))) : null, overdue, advance },
      ageing, documents: docs.map((d: any) => ({ id: d.id, kind: d.kind, number: d.number, doc_date: d.doc_date, total: Number(d.total),
        outstanding: d.kind === "invoice" ? byId.get(d.id)?.outstanding ?? 0 : null, age: d.kind === "invoice" ? byId.get(d.id)?.age ?? null : null })),
      statement: { from: st.from, to: st.to, opening: st.opening, closing: st.closing, debit: st.debit, credit: st.credit, lines: st.lines }, payments: st.payments, returns });
  }));
  // Printable invoice / credit note for the retailer's own outlet ("Download PDF" = the browser's Save as PDF).
  app.get("/api/retailer/invoices/:id/print", auth("retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { shop } = await myShop(db, req, cid);
    const inv = await loadInvoice(db, cid, Number(req.params.id));
    if (inv.shop_id !== shop.id) throw bad("invoice not found", 404);
    const ref = inv.ref_invoice_id ? (await db.query("SELECT number FROM invoices WHERE id=$1", [inv.ref_invoice_id])).rows[0]?.number : undefined;
    res.type("html").send(invoiceHtml(inv, ref, await einvBlock(inv)));
  }));
  void parseJson;
}
