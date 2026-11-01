import { emit } from "./integrations/webhooks.js";
// Step 5d: collections. Outstanding per outlet per issuer (company or a billing distributor) = invoices − credit notes − payments.
// Payments by cash/UPI/cheque/NEFT with FIFO or chosen-invoice allocation, cheque bounce reversal, receipts RCPT/<FY>/<seq>,
// credit days / credit limit with warn-or-block on new orders, ageing buckets.
import type { Express } from "express";
import { withTx, type Db } from "./db.js";
import { bad, getCompany, parseDate, parseJson, today } from "./catalog.js";
import { r2, fyOf, nextNumber, esc, inr } from "./billing.js";
import { distributorProfile } from "./purchase.js";
import type { Settings } from "./templates.js";

export const MODES = ["cash", "upi", "cheque", "neft"] as const;
export const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
export const bucketOf = (age: number) => age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "90+";

/** Open-item ledger for a company, optionally narrowed to one outlet and/or issuer. Pure JS aggregation (no correlated SQL). */
export async function ledger(db: Db, cid: number, f: { shopId?: number; issuer?: string } = {}, on = today()) {
  const cond: string[] = ["company_id=$1"], args: unknown[] = [cid];
  if (f.shopId) { args.push(f.shopId); cond.push(`shop_id=$${args.length}`); }
  if (f.issuer) { args.push(f.issuer); cond.push(`issuer=$${args.length}`); }
  const docs = (await db.query(`SELECT id, issuer, kind, number, doc_date, shop_id, ref_invoice_id, total, seller FROM invoices WHERE ${cond.join(" AND ")} ORDER BY doc_date, id`, args)).rows;
  const pays = (await db.query(`SELECT * FROM payments WHERE ${cond.join(" AND ")} ORDER BY pay_date, id`, args)).rows;
  const allocs = pays.length ? (await db.query(`SELECT a.* FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.status='cleared'`, [cid])).rows : [];
  const inv = new Map<number, any>();
  for (const d of docs.filter(d => d.kind === "invoice"))
    inv.set(d.id, { id: d.id, issuer: d.issuer, shop_id: d.shop_id, number: d.number, doc_date: d.doc_date, seller: parseJson<any>(d.seller, {}).name, total: Number(d.total), credited: 0, paid: 0 });
  for (const d of docs.filter(d => d.kind === "credit_note")) { const i = inv.get(d.ref_invoice_id); if (i) i.credited = r2(i.credited + Number(d.total)); }
  for (const a of allocs) { const i = inv.get(a.invoice_id); if (i) i.paid = r2(i.paid + Number(a.amount)); }
  const invoices = [...inv.values()].map(i => { const age = days(i.doc_date, on); return { ...i, outstanding: r2(i.total - i.credited - i.paid), age, bucket: bucketOf(age) }; });
  const allocated = new Map<number, number>(); for (const a of allocs) allocated.set(a.payment_id, r2((allocated.get(a.payment_id) ?? 0) + Number(a.amount)));
  const advances = pays.filter(p => p.status === "cleared").map(p => ({ shop_id: p.shop_id, issuer: p.issuer, amount: r2(Number(p.amount) - (allocated.get(p.id) ?? 0)) })).filter(p => p.amount > 0);
  return { invoices, advances };
}

/** Rows per (outlet, issuer). */
export async function outstanding(db: Db, cid: number, f: { shopId?: number; issuer?: string } = {}, credit?: { days: (shop: any) => number }) {
  const { invoices, advances } = await ledger(db, cid, f);
  const shops = new Map<number, any>((await db.query("SELECT id, code, name, credit_days, credit_limit FROM shops WHERE company_id=$1", [cid])).rows.map((s: any) => [s.id, s]));
  const m = new Map<string, any>();
  const row = (shop: number, issuer: string) => {
    const k = `${shop}|${issuer}`;
    if (!m.has(k)) m.set(k, { shop_id: shop, outlet_code: shops.get(shop)?.code, outlet: shops.get(shop)?.name, issuer, issuer_name: "", invoiced: 0, credited: 0, paid: 0, advance: 0, outstanding: 0, overdue: 0, invoices: [] as any[] });
    return m.get(k);
  };
  for (const i of invoices) {
    const r = row(i.shop_id, i.issuer); r.issuer_name ||= i.seller;
    r.invoiced = r2(r.invoiced + i.total); r.credited = r2(r.credited + i.credited); r.paid = r2(r.paid + i.paid);
    if (i.outstanding > 0.004) { r.invoices.push(i); if (credit && i.age > credit.days(shops.get(i.shop_id))) r.overdue = r2(r.overdue + i.outstanding); }
  }
  for (const a of advances) { const r = row(a.shop_id, a.issuer); r.advance = r2(r.advance + a.amount); }
  for (const r of m.values()) r.outstanding = r2(r.invoices.reduce((a: number, i: any) => a + i.outstanding, 0) - r.advance);
  return [...m.values()];
}

export const creditTerms = (settings: Settings, shop: any) => ({
  days: shop?.credit_days != null ? Number(shop.credit_days) : settings.credit.days,
  limit: shop?.credit_limit != null ? Number(shop.credit_limit) : settings.credit.limit,
  onBreach: settings.credit.onBreach });

/** Credit check for a new order of `amount` at an outlet. 0 days / 0 limit mean "not enforced". */
export async function creditCheck(db: Db, cid: number, settings: Settings, shop: any, amount: number) {
  const t = creditTerms(settings, shop);
  if (!settings.features.invoicing || (!t.days && !t.limit)) return { ok: true, terms: t, outstanding: 0, overdue: 0, reasons: [] as string[] };
  const rows = await outstanding(db, cid, { shopId: shop.id }, { days: () => t.days });
  const out = r2(rows.reduce((a, r) => a + r.outstanding, 0)), overdue = r2(rows.reduce((a, r) => a + r.overdue, 0));
  const reasons: string[] = [];
  if (t.days && overdue > 0) reasons.push(`₹${inr(overdue)} overdue beyond ${t.days} credit days`);
  if (t.limit && out + amount > t.limit) reasons.push(`outstanding ₹${inr(out)} + this order ₹${inr(amount)} exceeds credit limit ₹${inr(t.limit)}`);
  return { ok: !reasons.length, action: reasons.length ? t.onBreach : null, terms: t, outstanding: out, overdue, reasons };
}

export function receiptHtml(p: any) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.number)}</title><style>body{font:13px system-ui,sans-serif;margin:24px;max-width:640px}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}.n{text-align:right}.muted{color:#666}.bounced{color:#b00;font-weight:bold}</style></head><body>
<h2>PAYMENT RECEIPT ${p.status === "bounced" ? `<span class="bounced">— CHEQUE BOUNCED</span>` : ""}</h2>
<p><b>${esc(p.seller.name)}</b>${p.seller.gstin ? ` · GSTIN ${esc(p.seller.gstin)}` : ""}</p>
<p>Receipt <b>${esc(p.number)}</b> · Date ${esc(p.pay_date)}<br>Received from <b>${esc(p.shop_name)}</b> (${esc(p.shop_code)})</p>
<p>Amount <b>₹${inr(Number(p.amount))}</b> by ${esc(String(p.mode).toUpperCase())}${p.reference ? ` · Ref ${esc(p.reference)}` : ""}${p.cheque_date ? ` · Cheque date ${esc(p.cheque_date)}` : ""}</p>
<table><tr><th>Against invoice</th><th>Invoice date</th><th class="n">Amount</th></tr>
${p.allocations.map((a: any) => `<tr><td>${esc(a.number)}</td><td>${esc(a.doc_date)}</td><td class="n">${inr(Number(a.amount))}</td></tr>`).join("")}
${p.unallocated > 0 ? `<tr><td colspan="2">On account (advance)</td><td class="n">${inr(p.unallocated)}</td></tr>` : ""}</table>
${p.status === "bounced" ? `<p class="bounced">Bounced: ${esc(p.bounce_reason)} — allocations reversed.</p>` : ""}
<p class="muted">Generated by OwnField. Subject to realisation of cheques.</p></body></html>`;
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: any) => number | null; wrap: (fn: (req: any, res: any) => Promise<unknown>) => any };
export function registerCollectionRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const ALL = ["company_admin", "manager", "sales_rep", "distributor"], MGR = ["company_admin", "manager"];
  const ready = async (cid: number) => { const { settings } = await getCompany(db, cid); if (!settings.features.invoicing) throw bad("invoicing is turned off for this company"); return settings; };
  const own = (req: any) => req.user.role === "distributor" ? `d${req.user.uid}` : undefined;
  const sellerOf = async (cid: number, settings: Settings, issuer: string) => {
    if (issuer === "company") return { name: settings.gst.legalName, gstin: settings.gst.gstin };
    const p = await distributorProfile(db, cid, Number(issuer.slice(1)));
    const u = (await db.query("SELECT name FROM users WHERE id=$1 AND company_id=$2", [Number(issuer.slice(1)), cid])).rows[0];
    if (!u) throw bad("issuer not found", 404);
    return { name: p?.legal_name || u.name, gstin: p?.gstin || "" };
  };
  const loadPayment = async (cid: number, id: number, req: any) => {
    const p = (await db.query(`SELECT p.*, s.name AS shop_name, s.code AS shop_code FROM payments p JOIN shops s ON s.id=p.shop_id WHERE p.id=$1 AND p.company_id=$2`, [id, cid])).rows[0];
    if (!p || (own(req) && p.issuer !== own(req))) throw bad("payment not found", 404);
    p.amount = Number(p.amount);
    p.allocations = (await db.query("SELECT a.invoice_id, a.amount, i.number, i.doc_date FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.payment_id=$1 ORDER BY a.id", [p.id])).rows
      .map((a: any) => ({ ...a, amount: Number(a.amount) }));
    p.unallocated = r2(p.amount - p.allocations.reduce((a: number, x: any) => a + x.amount, 0));
    p.seller = await sellerOf(cid, (await getCompany(db, cid)).settings, p.issuer);
    return p;
  };

  app.get("/api/outstanding", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const settings = await ready(cid);
    const shops = new Map<number, any>((await db.query("SELECT * FROM shops WHERE company_id=$1", [cid])).rows.map((s: any) => [s.id, s]));
    const rows = await outstanding(db, cid, { shopId: Number(req.query.shopId) || undefined, issuer: own(req) || (req.query.issuer ? String(req.query.issuer) : undefined) },
      { days: s => creditTerms(settings, s).days || Infinity });
    res.json(rows.filter(r => r.invoices.length || r.advance).map(r => ({ ...r, terms: creditTerms(settings, shops.get(r.shop_id)) })));
  }));
  app.get("/api/credit-check", auth(...ALL, "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const { settings } = await getCompany(db, cid);
    // A retailer can only check its own shop.
    const sid = req.user.role === "retailer" ? (await db.query("SELECT shop_id FROM users WHERE id=$1", [req.user.uid])).rows[0]?.shop_id : Number(req.query.shopId);
    const shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [sid, cid])).rows[0]; if (!shop) throw bad("shop not found", 404);
    res.json(await creditCheck(db, cid, settings, shop, Number(req.query.amount) || 0));
  }));

  app.post("/api/payments", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const settings = await ready(cid);
    const b = req.body || {};
    if (b.clientRef) { // offline retries: the same clientRef returns the payment already saved
      const dup = (await db.query("SELECT id FROM payments WHERE company_id=$1 AND client_ref=$2", [cid, String(b.clientRef).slice(0, 60)])).rows[0];
      if (dup) return res.status(200).json({ ...(await loadPayment(cid, dup.id, req)), duplicate: true });
    }
    const shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(b.shopId), cid])).rows[0]; if (!shop) throw bad("shop not found", 404);
    const issuer = own(req) || String(b.issuer || (settings.features.distributorBilling && shop.distributor_id ? `d${shop.distributor_id}` : "company"));
    if (issuer !== "company" && !/^d\d+$/.test(issuer)) throw bad("issuer must be company or d<distributorId>");
    const amount = r2(Number(b.amount)); if (!(amount > 0)) throw bad("amount must be > 0");
    const mode = String(b.mode || "").toLowerCase(); if (!(MODES as readonly string[]).includes(mode)) throw bad(`mode must be one of ${MODES.join(", ")}`);
    if (["cheque", "neft", "upi"].includes(mode) && !b.reference) throw bad(`${mode} needs a reference (cheque no. / UTR)`);
    const payDate = b.date ? parseDate(b.date) : today(); if (!payDate) throw bad("date must be YYYY-MM-DD");
    const chequeDate = mode === "cheque" && b.chequeDate ? parseDate(b.chequeDate) : null;
    const seller = await sellerOf(cid, settings, issuer);
    const p = await withTx(db, async tx => {
      const open = (await ledger(tx as Db, cid, { shopId: shop.id, issuer }, payDate)).invoices.filter(i => i.outstanding > 0.004);
      let plan: { id: number; amount: number }[] = [];
      if (Array.isArray(b.allocations)) {
        for (const a of b.allocations) {
          const i = open.find(x => x.id === Number(a.invoiceId)), amt = r2(Number(a.amount));
          if (!i) throw bad(`invoice ${a.invoiceId} is not open for this outlet`, 404);
          if (!(amt > 0) || amt > i.outstanding) throw bad(`allocation for ${i.number} must be between 0 and ₹${inr(i.outstanding)}`);
          plan.push({ id: i.id, amount: amt });
        }
        if (r2(plan.reduce((a, x) => a + x.amount, 0)) > amount) throw bad("allocations exceed the payment amount");
      } else { // FIFO: oldest invoice first
        let left = amount;
        for (const i of open) { if (left <= 0) break; const a = r2(Math.min(left, i.outstanding)); plan.push({ id: i.id, amount: a }); left = r2(left - a); }
      }
      const fy = fyOf(payDate);
      // Receipts aren't GST documents, so the 16-character invoice-number limit doesn't apply.
      const number = `RCPT/${fy}/${String(await nextNumber(tx as Db, cid, issuer === "company" ? "receipt" : `receipt:${issuer}`, fy)).padStart(4, "0")}`;
      const p = (await tx.query(`INSERT INTO payments (company_id,issuer,number,fy,shop_id,pay_date,mode,reference,cheque_date,amount,collected_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [cid, issuer, number, fy, shop.id, payDate, mode, b.reference ? String(b.reference) : null, chequeDate, amount, req.user.uid])).rows[0];
      if (b.clientRef) await tx.query("UPDATE payments SET client_ref=$1 WHERE id=$2", [String(b.clientRef).slice(0, 60), p.id]);
      for (const a of plan) await tx.query("INSERT INTO payment_allocations (payment_id,invoice_id,amount) VALUES ($1,$2,$3)", [p.id, a.id, a.amount]);
      await emit(tx as Db, cid, "collection.created", { id: p.id, number: p.number, shop_id: p.shop_id, amount: Number(p.amount), mode: p.mode, pay_date: p.pay_date });
      return p;
    });
    void seller;
    res.status(201).json(await loadPayment(cid, p.id, req));
  }));
  app.get("/api/payments", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const args: unknown[] = [cid]; let w = "p.company_id=$1";
    if (own(req)) { args.push(own(req)); w += ` AND p.issuer=$${args.length}`; }
    if (req.user.role === "sales_rep") { args.push(req.user.uid); w += ` AND p.collected_by=$${args.length}`; }
    if (req.query.shopId) { args.push(Number(req.query.shopId)); w += ` AND p.shop_id=$${args.length}`; }
    res.json((await db.query(`SELECT p.*, s.name AS shop_name, u.name AS collected_by_name FROM payments p JOIN shops s ON s.id=p.shop_id LEFT JOIN users u ON u.id=p.collected_by
      WHERE ${w} ORDER BY p.id DESC`, args)).rows.map((p: any) => ({ ...p, amount: Number(p.amount) })));
  }));
  app.get("/api/payments/:id", auth(...ALL), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json(await loadPayment(cid, Number(req.params.id), req)); }));
  app.get("/api/payments/:id/print", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    res.type("html").send(receiptHtml(await loadPayment(cid, Number(req.params.id), req)));
  }));
  app.post("/api/payments/:id/bounce", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const p = await loadPayment(cid, Number(req.params.id), req);
    if (p.mode !== "cheque") throw bad("only cheque payments can bounce", 409);
    const reason = String(req.body?.reason || "").trim(); if (!reason) throw bad("bounce reason required");
    await withTx(db, async tx => {
      const u = (await tx.query("UPDATE payments SET status='bounced', bounce_reason=$1, bounced_at=NOW() WHERE id=$2 AND status='cleared' RETURNING id", [reason, p.id])).rows[0];
      if (!u) throw bad("payment already bounced", 409);
      // Allocations stay on record for the receipt; ledger() ignores bounced payments, so the invoices re-open.
    });
    res.json(await loadPayment(cid, p.id, req));
  }));
}

/** Ageing rows for the reports endpoint. */
export async function ageingRows(db: Db, cid: number, on = today(), issuer?: string) {
  const { invoices } = await ledger(db, cid, issuer ? { issuer } : {}, on);
  const shops = new Map<number, any>((await db.query("SELECT id, code, name FROM shops WHERE company_id=$1", [cid])).rows.map((s: any) => [s.id, s]));
  const m = new Map<string, any>();
  for (const i of invoices.filter(i => i.outstanding > 0.004)) {
    const k = `${i.shop_id}|${i.issuer}`;
    const r = m.get(k) || { outlet_code: shops.get(i.shop_id)?.code, outlet: shops.get(i.shop_id)?.name, billed_by: i.seller, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0, total: 0 };
    r[i.bucket] = r2(r[i.bucket] + i.outstanding); r.total = r2(r.total + i.outstanding); m.set(k, r);
  }
  return [...m.values()];
}
