// Step 4: GST invoices & credit notes (returns). HSN/SAC-based rates, CGST+SGST (intra-state) vs IGST (inter-state),
// numbering per Indian financial year (April–March), printable HTML. Every write runs in one DB transaction.
import type { Express, Response, Request, NextFunction } from "express";
import { withTx, type Db } from "./db.js";
import { bad, getCompany, parseJson, parseDate, today } from "./catalog.js";
import type { Gst } from "./templates.js";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const fyOf = (date: string) => { const [y, m] = date.split("-").map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, "0")}`; };
export const rateFor = (g: Gst, hsn: string | null) => {
  const h = String(hsn || ""); let best: { prefix: string; rate: number } | undefined;
  for (const x of g.hsnRates) if (h.startsWith(x.prefix) && (!best || x.prefix.length > best.prefix.length)) best = x;
  return best ? best.rate : g.defaultRate;
};
export function formatNumber(fmt: string, prefix: string, fy: string, seq: number) {
  const out = fmt.replace("{prefix}", prefix).replace("{fy}", fy).replace(/\{seq(?::(\d))?\}/, (_m, w) => String(seq).padStart(Number(w || 1), "0"));
  if (out.length > 16) throw bad(`document number "${out}" exceeds 16 characters — shorten the number format or prefix`);
  return out;
}
/** Next gapless number for (company, kind, FY). Must run inside the same transaction as the document insert. */
async function nextNumber(tx: Db, cid: number, kind: string, fy: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = (await tx.query("SELECT next_no FROM doc_series WHERE company_id=$1 AND kind=$2 AND fy=$3", [cid, kind, fy])).rows[0];
    if (!row) { await tx.query("INSERT INTO doc_series (company_id,kind,fy,next_no) VALUES ($1,$2,$3,2)", [cid, kind, fy]); return 1; }
    const n = Number(row.next_no);
    if ((await tx.query("UPDATE doc_series SET next_no=$1 WHERE company_id=$2 AND kind=$3 AND fy=$4 AND next_no=$5 RETURNING next_no", [n + 1, cid, kind, fy, n])).rows[0]) return n;
  }
  throw bad("could not allocate a document number — retry", 409);
}
const split = (taxable: number, rate: number, intra: boolean) => {
  const tax = r2(taxable * rate / 100);
  if (!intra) return { cgst: 0, sgst: 0, igst: tax };
  const c = r2(tax / 2); return { cgst: c, sgst: r2(tax - c), igst: 0 };
};

async function createDoc(tx: Db, cid: number, uid: number, d: { kind: "invoice" | "credit_note"; date: string; g: Gst; shop: any; orderId: number | null; refId: number | null; reason?: string | null;
  lines: { orderLineId?: number | null; refLineId?: number | null; variantId: number; description: string; hsn: string | null; baseQty: number; uom: string; rate: number; taxable: number; gstRate: number }[] }) {
  const sellerState = d.g.stateCode, pos = d.shop.state_code || String(d.shop.gstin || "").slice(0, 2) || sellerState;
  const intra = pos === sellerState;
  const fy = fyOf(d.date);
  const number = formatNumber(d.g.numberFormat, d.kind === "invoice" ? d.g.invoicePrefix : d.g.creditPrefix, fy, await nextNumber(tx, cid, d.kind, fy));
  const lines = d.lines.map(l => { const t = split(l.taxable, l.gstRate, intra); return { ...l, ...t, total: r2(l.taxable + t.cgst + t.sgst + t.igst) }; });
  const sum = (k: "taxable" | "cgst" | "sgst" | "igst") => r2(lines.reduce((a, l) => a + l[k], 0));
  const gross = r2(sum("taxable") + sum("cgst") + sum("sgst") + sum("igst")), total = Math.round(gross), roundOff = r2(total - gross);
  const seller = JSON.stringify({ name: d.g.legalName, gstin: d.g.gstin, state: sellerState, address: d.g.address });
  const buyer = JSON.stringify({ name: d.shop.name, gstin: d.shop.gstin || "", state: pos, address: [d.shop.address, d.shop.city].filter(Boolean).join(", ") });
  const inv = (await tx.query(`INSERT INTO invoices (company_id,kind,number,fy,doc_date,order_id,ref_invoice_id,shop_id,seller,buyer,place_of_supply,intra_state,reason,taxable,cgst,sgst,igst,round_off,total,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [cid, d.kind, number, fy, d.date, d.orderId, d.refId, d.shop.id, seller, buyer, pos, intra, d.reason ?? null, sum("taxable"), sum("cgst"), sum("sgst"), sum("igst"), roundOff, total, uid])).rows[0];
  for (const l of lines) await tx.query(`INSERT INTO invoice_lines (invoice_id,order_line_id,ref_line_id,variant_id,description,hsn,base_qty,uom,rate,taxable,gst_rate,cgst,sgst,igst,total)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`, [inv.id, l.orderLineId ?? null, l.refLineId ?? null, l.variantId, l.description, l.hsn, l.baseQty, l.uom, l.rate, l.taxable, l.gstRate, l.cgst, l.sgst, l.igst, l.total]);
  return inv;
}

export async function loadInvoice(db: Db, cid: number, id: number) {
  const inv = (await db.query("SELECT * FROM invoices WHERE id=$1 AND company_id=$2", [id, cid])).rows[0];
  if (!inv) throw bad("invoice not found", 404);
  const lines = (await db.query("SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id", [id])).rows;
  const num = (o: any, ks: string[]) => { for (const k of ks) o[k] = Number(o[k]); return o; };
  return { ...num(inv, ["taxable", "cgst", "sgst", "igst", "round_off", "total"]), seller: parseJson(inv.seller, {}), buyer: parseJson(inv.buyer, {}),
    lines: lines.map(l => num(l, ["rate", "taxable", "gst_rate", "cgst", "sgst", "igst", "total", "base_qty"])) };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const inr = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function invoiceHtml(inv: any, ref?: string) {
  const title = inv.kind === "invoice" ? "TAX INVOICE" : "CREDIT NOTE";
  const hsn = new Map<string, any>();
  for (const l of inv.lines) { const k = `${l.hsn || "-"}|${l.gst_rate}`; const h = hsn.get(k) || { hsn: l.hsn || "-", rate: l.gst_rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }; for (const f of ["taxable", "cgst", "sgst", "igst"]) h[f] = r2(h[f] + l[f]); hsn.set(k, h); }
  const taxCols = inv.intra_state ? ["CGST", "SGST"] : ["IGST"];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>
body{font-family:system-ui,sans-serif;font-size:12px;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}
th,td{border:1px solid #999;padding:4px 6px;text-align:left}td.n,th.n{text-align:right}.grid{display:flex;gap:16px}.grid>div{flex:1;border:1px solid #999;padding:8px}
.tot td{font-weight:700}.muted{color:#555}@media print{button{display:none}body{margin:8mm}}</style></head><body>
<button onclick="print()">Print</button>
<h1>${title}</h1><div>No. <b>${esc(inv.number)}</b> · Date ${esc(inv.doc_date)} · FY ${esc(inv.fy)}${ref ? ` · Against invoice <b>${esc(ref)}</b>` : ""}</div>
<div class="grid"><div><b>Supplier</b><br>${esc(inv.seller.name)}<br>${esc(inv.seller.address)}<br>GSTIN ${esc(inv.seller.gstin)} · State ${esc(inv.seller.state)}</div>
<div><b>Recipient</b><br>${esc(inv.buyer.name)}<br>${esc(inv.buyer.address)}<br>GSTIN ${esc(inv.buyer.gstin || "Unregistered")} · Place of supply ${esc(inv.place_of_supply)}</div></div>
${inv.reason ? `<p>Reason: ${esc(inv.reason)}</p>` : ""}
<table><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Taxable</th><th class="n">GST %</th>${taxCols.map(c => `<th class="n">${c}</th>`).join("")}<th class="n">Total</th></tr>
${inv.lines.map((l: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td><td>${esc(l.hsn)}</td><td class="n">${l.base_qty} ${esc(l.uom)}</td><td class="n">${inr(l.rate)}</td><td class="n">${inr(l.taxable)}</td><td class="n">${l.gst_rate}</td>${inv.intra_state ? `<td class="n">${inr(l.cgst)}</td><td class="n">${inr(l.sgst)}</td>` : `<td class="n">${inr(l.igst)}</td>`}<td class="n">${inr(l.total)}</td></tr>`).join("")}
<tr class="tot"><td colspan="5">Total</td><td class="n">${inr(inv.taxable)}</td><td></td>${inv.intra_state ? `<td class="n">${inr(inv.cgst)}</td><td class="n">${inr(inv.sgst)}</td>` : `<td class="n">${inr(inv.igst)}</td>`}<td class="n">${inr(r2(inv.total - inv.round_off))}</td></tr></table>
<table><tr><th>HSN/SAC</th><th class="n">GST %</th><th class="n">Taxable</th>${taxCols.map(c => `<th class="n">${c}</th>`).join("")}</tr>
${[...hsn.values()].map(h => `<tr><td>${esc(h.hsn)}</td><td class="n">${h.rate}</td><td class="n">${inr(h.taxable)}</td>${inv.intra_state ? `<td class="n">${inr(h.cgst)}</td><td class="n">${inr(h.sgst)}</td>` : `<td class="n">${inr(h.igst)}</td>`}</tr>`).join("")}</table>
<p>Round off: ${inr(inv.round_off)} · <b>Amount ${inv.kind === "invoice" ? "payable" : "credited"}: ₹${inr(inv.total)}</b></p>
<p class="muted">Generated by FieldForce OSS. Verify GST rates and HSN/SAC codes with your tax advisor.</p></body></html>`;
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void };

export function registerBillingRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const BILL = ["company_admin", "manager"];
  const ready = async (cid: number) => {
    const { settings } = await getCompany(db, cid);
    if (!settings.features.invoicing) throw bad("invoicing is turned off for this company");
    const g = settings.gst;
    if (!g.gstin || !g.stateCode || !g.legalName) throw bad("set legal name, GSTIN and state code in Settings → GST first");
    return settings;
  };
  const docDate = (v: unknown) => { const d = v ? parseDate(v)! : today(); if (d > today()) throw bad("document date cannot be in the future"); return d; };

  app.post("/api/orders/:id/invoice", auth(...BILL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const settings = await ready(cid);
    const date = docDate(req.body?.date);
    const inv = await withTx(db, async tx => {
      const o = (await tx.query("SELECT * FROM orders WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
      if (!o) throw bad("order not found", 404);
      if (!["accepted", "fulfilled"].includes(o.status)) throw bad("only accepted or fulfilled orders can be invoiced", 409);
      if ((await tx.query("SELECT id FROM invoices WHERE order_id=$1 AND kind='invoice'", [o.id])).rows[0]) throw bad("order already invoiced", 409);
      const shop = (await tx.query("SELECT * FROM shops WHERE id=$1", [o.shop_id])).rows[0];
      const lines = (await tx.query(`SELECT l.*, v.sku, v.attrs, i.name, i.hsn FROM order_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
        WHERE l.order_id=$1 ORDER BY l.id`, [o.id])).rows;
      return createDoc(tx, cid, req.user.uid, { kind: "invoice", date, g: settings.gst, shop, orderId: o.id, refId: null, lines: lines.map(l => ({
        orderLineId: l.id, variantId: l.variant_id, description: `${l.name} ${Object.values(parseJson<Record<string, string>>(l.attrs, {})).join(" / ")} (${l.sku})`.replace(/\s+/g, " "),
        hsn: l.hsn, baseQty: Number(l.base_qty), uom: l.uom, rate: Number(l.price) * (1 - Number(l.discount_pct) / 100),
        taxable: Number(l.amount), gstRate: rateFor(settings.gst, l.hsn) })) });
    });
    res.status(201).json(await loadInvoice(db, cid, inv.id));
  }));

  /** Credit note for returned quantities (base units). restock=true puts goods back into the batches they were allocated from. */
  app.post("/api/invoices/:id/credit-note", auth(...BILL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const settings = await ready(cid);
    const date = docDate(req.body?.date);
    const want = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!want.length) throw bad("at least one line with qty > 0");
    if (!String(req.body?.reason || "").trim()) throw bad("reason required");
    const cn = await withTx(db, async tx => {
      const inv = await loadInvoice(tx, cid, Number(req.params.id));
      if (inv.kind !== "invoice") throw bad("credit notes can only be raised against invoices");
      const shop = (await tx.query("SELECT * FROM shops WHERE id=$1", [inv.shop_id])).rows[0];
      const out = [];
      for (const w of want) {
        const l = inv.lines.find((x: any) => x.id === Number(w.invoiceLineId));
        if (!l) throw bad(`invoice line ${w.invoiceLineId} not found`, 404);
        const q = Number(w.qty); if (!Number.isInteger(q)) throw bad("qty must be a whole number (base units)");
        const done = (await tx.query("SELECT base_qty FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id WHERE il.ref_line_id=$1", [l.id])).rows.reduce((a: number, r: any) => a + Number(r.base_qty), 0);
        if (q + done > l.base_qty) throw bad(`cannot return ${q} of ${l.description}: ${l.base_qty - done} returnable`, 409);
        out.push({ refLineId: l.id, variantId: l.variant_id, description: l.description, hsn: l.hsn, baseQty: q, uom: l.uom, rate: l.rate,
          taxable: r2(l.taxable * q / l.base_qty), gstRate: l.gst_rate, orderLineId: l.order_line_id, already: done });
      }
      const doc = await createDoc(tx, cid, req.user.uid, { kind: "credit_note", date, g: settings.gst, shop, orderId: inv.order_id, refId: inv.id, reason: String(req.body.reason).trim(), lines: out });
      if (req.body?.restock && settings.features.stock) for (const l of out) {
        // Return into the allocated batches, skipping what earlier returns already put back (FIFO over allocations).
        let skip = l.already, left = l.baseQty;
        const allocs = l.orderLineId ? (await tx.query("SELECT * FROM order_allocations WHERE order_line_id=$1 ORDER BY id", [l.orderLineId])).rows : [];
        for (const a of allocs) {
          let cap = Number(a.qty); const s = Math.min(skip, cap); skip -= s; cap -= s;
          const put = Math.min(cap, left); if (put <= 0) continue;
          const st = (await tx.query("SELECT qty FROM stock WHERE id=$1", [a.stock_id])).rows[0];
          if (!(await tx.query("UPDATE stock SET qty=$1 WHERE id=$2 AND qty=$3 RETURNING id", [Number(st.qty) + put, a.stock_id, st.qty])).rows[0]) throw bad("stock changed — retry", 409);
          left -= put;
        }
      }
      return doc;
    });
    res.status(201).json(await loadInvoice(db, cid, cn.id));
  }));

  app.get("/api/invoices", auth(...BILL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rows = (await db.query(`SELECT i.id,i.kind,i.number,i.doc_date,i.order_id,i.ref_invoice_id,i.intra_state,i.taxable,i.cgst,i.sgst,i.igst,i.total,s.name AS shop_name
      FROM invoices i JOIN shops s ON s.id=i.shop_id WHERE i.company_id=$1 ORDER BY i.id DESC`, [cid])).rows;
    res.json(rows.map(r => ({ ...r, taxable: Number(r.taxable), total: Number(r.total), tax: Number(r.cgst) + Number(r.sgst) + Number(r.igst) })));
  }));
  app.get("/api/invoices/:id", auth(...BILL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; res.json(await loadInvoice(db, cid, Number(req.params.id)));
  }));
  app.get("/api/invoices/:id/print", auth(...BILL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const inv = await loadInvoice(db, cid, Number(req.params.id));
    const ref = inv.ref_invoice_id ? (await db.query("SELECT number FROM invoices WHERE id=$1", [inv.ref_invoice_id])).rows[0]?.number : undefined;
    res.type("html").send(invoiceHtml(inv, ref));
  }));
}
