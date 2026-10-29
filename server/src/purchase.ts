import { logMove } from "./inventory.js";
// Step 5a: purchase orders distributor → company. Draft → submit → approve (editable qty, audited price override) / reject,
// partial dispatches (FEFO from company stock when tracked) and receipt into distributor stock. Numbered PO/<FY>/<seq> per distributor.
import type { Express, Response, Request, NextFunction } from "express";
import * as XLSX from "xlsx";
import { withTx, type Db } from "./db.js";
import { bad, getCompany, parseJson, parseDate, today, fefoRows } from "./catalog.js";
import { getFlow } from "./flow.js";
import { r2, nextNumber, formatNumber, fyOf, rateFor, esc, inr } from "./billing.js";
import type { Settings, Uom } from "./templates.js";

export async function distributorProfile(db: Db, cid: number, did: number) {
  return (await db.query("SELECT * FROM distributor_profiles WHERE distributor_id=$1 AND company_id=$2", [did, cid])).rows[0] ?? null;
}

/** Price base → margin → product/category discount → distributor discount (each multiplicative), rounded to paise. */
export function poPrice(v: { billing_price: number; mrp: number; item_code: string; category: string | null }, s: Settings, profile: any) {
  const base = Number(s.po.priceBase === "mrp" ? v.mrp : v.billing_price);
  const marginPct = profile?.margin_pct != null ? Number(profile.margin_pct) : s.po.marginPct;
  const item = s.po.productDiscounts.find(d => d.scope === "item" && d.key === v.item_code);
  const cat = s.po.productDiscounts.find(d => d.scope === "category" && v.category != null && d.key.toLowerCase() === String(v.category).toLowerCase());
  const productDiscPct = (item ?? cat)?.pct ?? 0, distDiscPct = Number(profile?.discount_pct ?? 0);
  const rate = r2(base * (1 - marginPct / 100) * (1 - productDiscPct / 100) * (1 - distDiscPct / 100));
  return { base, marginPct, productDiscPct, distDiscPct, rate };
}

const STATUSES = { draft: "draft", submitted: "submitted", approved: "approved", partial: "partially_dispatched", dispatched: "dispatched", received: "received", rejected: "rejected" };

async function priceLines(db: Db, cid: number, s: Settings, profile: any, lines: any[]) {
  const out = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw bad("qty must be a positive whole number");
    const v = (await db.query(`SELECT v.id, v.sku, v.mrp, v.billing_price, i.code AS item_code, i.category, i.kind, i.hsn, i.uoms FROM variants v JOIN items i ON i.id=v.item_id
      WHERE v.company_id=$1 AND (v.sku=$2 OR v.id=$3)`, [cid, String(l.sku ?? ""), Number(l.variantId) || 0])).rows[0];
    if (!v) throw bad(`product ${l.sku ?? l.variantId} not found`, 404);
    if (v.kind === "service") throw bad(`${v.sku} is a service item — not orderable on a PO`);
    const uoms = parseJson<Uom[]>(v.uoms, s.uoms);
    const u = l.uom ? uoms.find(x => x.code === String(l.uom).toUpperCase()) : uoms.find(x => x.factor === 1);
    if (!u) throw bad(`unit ${l.uom} not defined for ${v.sku}`);
    const p = poPrice(v, s, profile);
    out.push({ variant_id: v.id, uom: u.code, qty: qty * u.factor, ...p, gst: rateFor(s.gst, v.hsn) });
  }
  return out;
}

async function recompute(tx: Db, po: any, intra: boolean) {
  const lines = (await tx.query("SELECT * FROM po_lines WHERE po_id=$1 ORDER BY id", [po.id])).rows;
  let taxable = 0, tax = 0;
  for (const l of lines) {
    const q = l.qty_approved != null ? Number(l.qty_approved) : Number(l.qty_requested);
    const t = r2(q * Number(l.rate)), x = r2(t * Number(l.gst_rate) / 100);
    taxable += t; tax += x;
    await tx.query("UPDATE po_lines SET taxable=$1, tax=$2, total=$3 WHERE id=$4", [t, x, r2(t + x), l.id]);
  }
  await tx.query("UPDATE purchase_orders SET taxable=$1, tax=$2, total=$3, intra_state=$4 WHERE id=$5", [r2(taxable), r2(tax), r2(taxable + tax), intra, po.id]);
}

export async function loadPo(db: Db, cid: number, id: number) {
  const po = (await db.query(`SELECT p.*, u.name AS distributor_name, u.email AS distributor_email FROM purchase_orders p JOIN users u ON u.id=p.distributor_id
    WHERE p.id=$1 AND p.company_id=$2`, [id, cid])).rows[0];
  if (!po) throw bad("purchase order not found", 404);
  const n = (o: any, ks: string[]) => { for (const k of ks) if (o[k] != null) o[k] = Number(o[k]); return o; };
  po.lines = (await db.query(`SELECT l.*, v.sku, v.attrs, i.name AS item_name, i.hsn FROM po_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id
    WHERE l.po_id=$1 ORDER BY l.id`, [id])).rows.map(l => n({ ...l, attrs: parseJson(l.attrs, {}) },
      ["qty_requested", "qty_approved", "qty_dispatched", "qty_received", "base_price", "margin_pct", "product_disc_pct", "dist_disc_pct", "computed_rate", "rate", "gst_rate", "taxable", "tax", "total"]));
  po.dispatches = (await db.query("SELECT * FROM po_dispatches WHERE po_id=$1 ORDER BY id", [id])).rows;
  for (const d of po.dispatches) d.lines = (await db.query("SELECT * FROM po_dispatch_lines WHERE dispatch_id=$1 ORDER BY id", [d.id])).rows.map(x => n(x, ["qty"]));
  po.audit = (await db.query(`SELECT a.*, u.name AS user_name FROM po_price_audit a JOIN users u ON u.id=a.user_id JOIN po_lines l ON l.id=a.po_line_id WHERE l.po_id=$1 ORDER BY a.id`, [id])).rows
    .map(a => n(a, ["old_rate", "new_rate"]));
  return n(po, ["taxable", "tax", "total"]);
}

const poRows = (po: any) => po.lines.map((l: any) => ({ po: po.number || `DRAFT-${po.id}`, sku: l.sku, item: l.item_name, variant: Object.values(l.attrs).join(" / "), hsn: l.hsn || "",
  qty_requested: l.qty_requested, qty_approved: l.qty_approved ?? "", qty_dispatched: l.qty_dispatched, qty_received: l.qty_received, base_price: l.base_price,
  margin_pct: l.margin_pct, product_disc_pct: l.product_disc_pct, distributor_disc_pct: l.dist_disc_pct, rate: l.rate, gst_rate: l.gst_rate, taxable: l.taxable, tax: l.tax, total: l.total }));

export function poHtml(po: any, company: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(po.number)}</title><style>body{font-family:system-ui,sans-serif;font-size:12px;margin:24px}
table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #999;padding:4px 6px}td.n{text-align:right}@media print{button{display:none}}</style></head><body>
<button onclick="print()">Print</button><h1 style="font-size:18px">PURCHASE ORDER ${esc(po.number || "(draft)")}</h1>
<p>From <b>${esc(po.distributor_name)}</b> to <b>${esc(company)}</b> · Status ${esc(po.status)}${po.reject_reason ? ` · Rejected: ${esc(po.reject_reason)}` : ""}</p>
<table><tr><th>#</th><th>SKU</th><th>Item</th><th>HSN</th><th>Req</th><th>Appr</th><th>Disp</th><th>Recd</th><th>Rate</th><th>GST %</th><th>Taxable</th><th>Tax</th><th>Total</th></tr>
${po.lines.map((l: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(l.sku)}</td><td>${esc(l.item_name)} ${esc(Object.values(l.attrs).join(" / "))}</td><td>${esc(l.hsn)}</td>
<td class="n">${l.qty_requested}</td><td class="n">${l.qty_approved ?? "—"}</td><td class="n">${l.qty_dispatched}</td><td class="n">${l.qty_received}</td><td class="n">${inr(l.rate)}</td>
<td class="n">${l.gst_rate}</td><td class="n">${inr(l.taxable)}</td><td class="n">${inr(l.tax)}</td><td class="n">${inr(l.total)}</td></tr>`).join("")}
<tr><td colspan="10"><b>Total</b> (${po.intra_state === false ? "IGST" : "CGST+SGST"})</td><td class="n">${inr(po.taxable)}</td><td class="n">${inr(po.tax)}</td><td class="n"><b>${inr(po.total)}</b></td></tr></table>
${po.audit.length ? `<p><b>Price overrides</b><br>${po.audit.map((a: any) => `${esc(a.user_name)}: ${inr(a.old_rate)} → ${inr(a.new_rate)} (${esc(a.reason)})`).join("<br>")}</p>` : ""}
<p style="color:#555">Quantities in base units. Generated by OwnField.</p></body></html>`;
}

type Ctx = { app: Express; db: Db; auth: (...r: any[]) => any; tenant: (req: any, res: Response) => number | null;
  wrap: (fn: (req: any, res: Response) => Promise<unknown>) => (q: Request, s: Response, n: NextFunction) => void };

export function registerPurchaseRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  const MGR = ["company_admin", "manager"], ALL = [...MGR, "distributor"];
  const enabled = async (cid: number) => { const c = await getCompany(db, cid); if (!c.settings.features.purchaseOrders) throw bad("purchase orders are turned off for this company"); return c.settings; };
  const own = async (req: any, cid: number) => {
    const po = await loadPo(db, cid, Number(req.params.id));
    if (req.user.role === "distributor" && po.distributor_id !== req.user.uid) throw bad("purchase order not found", 404);
    return po;
  };
  const intraFor = async (cid: number, s: Settings, did: number) => {
    const p = await distributorProfile(db, cid, did); const st = p?.state_code || String(p?.gstin || "").slice(0, 2) || s.gst.stateCode;
    return !s.gst.stateCode || st === s.gst.stateCode;
  };

  // ---- Distributor profiles (terms, GST identity, credit) ----
  app.get("/api/distributors/:id/profile", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const did = Number(req.params.id); if (req.user.role === "distributor" && did !== req.user.uid) throw bad("forbidden", 403);
    res.json(await distributorProfile(db, cid, did) ?? { distributor_id: did });
  }));
  app.put("/api/distributors/:id/profile", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const did = Number(req.params.id), b = req.body || {}, isDist = req.user.role === "distributor";
    if (isDist && did !== req.user.uid) throw bad("forbidden", 403);
    if (!(await db.query("SELECT id FROM users WHERE id=$1 AND company_id=$2 AND role='distributor'", [did, cid])).rows[0]) throw bad("distributor not found", 404);
    const cur = await distributorProfile(db, cid, did) ?? {};
    // Commercial terms are set by the company; GST identity/numbering can be maintained by the distributor.
    const terms = ["margin_pct", "discount_pct", "credit_days", "credit_limit"], ident = ["legal_name", "gstin", "state_code", "address", "city", "pincode", "invoice_prefix", "credit_prefix", "number_format"];
    const next: any = { ...cur };
    for (const k of ident) if (k in b) next[k] = b[k] === "" ? null : String(b[k]).trim();
    if (!isDist) for (const k of terms) if (k in b) next[k] = b[k] === "" || b[k] == null ? null : Number(b[k]);
    if (next.gstin) { next.gstin = next.gstin.toUpperCase(); if (!/^\d{2}[A-Z0-9]{13}$/.test(next.gstin)) throw bad("invalid GSTIN"); next.state_code ??= next.gstin.slice(0, 2); }
    if (next.state_code && !/^\d{2}$/.test(next.state_code)) throw bad("state code must be 2 digits");
    if (next.gstin && next.state_code && next.gstin.slice(0, 2) !== next.state_code) throw bad("GSTIN does not match state code");
    for (const k of ["margin_pct", "discount_pct"]) if (next[k] != null && !(next[k] >= 0 && next[k] < 100)) throw bad(`${k} must be 0–99.99`);
    if (next.credit_days != null && !(Number.isInteger(next.credit_days) && next.credit_days >= 0)) throw bad("credit_days must be a whole number");
    if (next.credit_limit != null && !(next.credit_limit >= 0)) throw bad("credit_limit must be ≥ 0");
    if (next.number_format && !String(next.number_format).includes("{seq")) throw bad("number format must contain {seq}");
    const cols = [...terms, ...ident], vals = cols.map(k => next[k] ?? (k === "discount_pct" ? 0 : null));
    if (cur.distributor_id) await db.query(`UPDATE distributor_profiles SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(",")} WHERE distributor_id=$${cols.length + 1}`, [...vals, did]);
    else await db.query(`INSERT INTO distributor_profiles (${cols.join(",")},distributor_id,company_id) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")},$${cols.length + 1},$${cols.length + 2})`, [...vals, did, cid]);
    res.json(await distributorProfile(db, cid, did));
  }));
  app.get("/api/po-price", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const did = req.user.role === "distributor" ? req.user.uid : Number(req.query.distributorId);
    const prof = await distributorProfile(db, cid, did);
    const vs = (await db.query(`SELECT v.id, v.sku, v.mrp, v.billing_price, v.attrs, i.name, i.code AS item_code, i.category, i.kind, i.hsn, i.uoms FROM variants v JOIN items i ON i.id=v.item_id
      WHERE v.company_id=$1 ORDER BY i.code, v.id`, [cid])).rows.filter(v => v.kind !== "service");
    res.json(vs.map(v => ({ id: v.id, sku: v.sku, name: v.name, attrs: parseJson(v.attrs, {}), uoms: parseJson(v.uoms, s.uoms), ...poPrice(v, s, prof), gst: rateFor(s.gst, v.hsn) })));
  }));

  // ---- PO lifecycle ----
  app.get("/api/pos", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const mine = req.user.role === "distributor";
    res.json((await db.query(`SELECT p.id,p.number,p.status,p.distributor_id,u.name AS distributor_name,p.taxable,p.tax,p.total,p.created_at,p.submitted_at FROM purchase_orders p
      JOIN users u ON u.id=p.distributor_id WHERE p.company_id=$1 ${mine ? "AND p.distributor_id=$2" : ""} ORDER BY p.id DESC`, mine ? [cid, req.user.uid] : [cid])).rows
      .map(p => ({ ...p, taxable: Number(p.taxable), tax: Number(p.tax), total: Number(p.total) })));
  }));
  app.get("/api/pos/:id", auth(...ALL), wrap(async (req, res) => { const cid = tenant(req, res); if (cid == null) return; res.json(await own(req, cid)); }));

  const saveLines = async (tx: Db, cid: number, s: Settings, po: any, lines: unknown) => {
    if (!Array.isArray(lines) || !lines.length) throw bad("at least one line required");
    const priced = await priceLines(tx, cid, s, await distributorProfile(tx, cid, po.distributor_id), lines);
    await tx.query("DELETE FROM po_lines WHERE po_id=$1", [po.id]);
    for (const p of priced) await tx.query(`INSERT INTO po_lines (po_id,variant_id,uom,qty_requested,base_price,margin_pct,product_disc_pct,dist_disc_pct,computed_rate,rate,gst_rate,taxable,tax,total)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,0,0,0)`, [po.id, p.variant_id, p.uom, p.qty, p.base, p.marginPct, p.productDiscPct, p.distDiscPct, p.rate, p.gst]);
    await recompute(tx, po, await intraFor(cid, s, po.distributor_id));
  };
  app.post("/api/pos", auth("distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid);
    const id = await withTx(db, async tx => {
      const po = (await tx.query("INSERT INTO purchase_orders (company_id,distributor_id,notes) VALUES ($1,$2,$3) RETURNING *", [cid, req.user.uid, req.body?.notes ?? null])).rows[0];
      await saveLines(tx, cid, s, po, req.body?.lines); return po.id;
    });
    res.status(201).json(await loadPo(db, cid, id));
  }));
  app.put("/api/pos/:id", auth("distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const po = await own(req, cid);
    if (po.status !== "draft") throw bad("only drafts can be edited", 409);
    await withTx(db, async tx => { await tx.query("UPDATE purchase_orders SET notes=$1 WHERE id=$2", [req.body?.notes ?? po.notes, po.id]); await saveLines(tx, cid, s, po, req.body?.lines); });
    res.json(await loadPo(db, cid, po.id));
  }));
  app.post("/api/pos/:id/submit", auth("distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const po = await own(req, cid);
    await withTx(db, async tx => {
      const fy = fyOf(today());
      const number = formatNumber(s.po.numberFormat, "PO", fy, await nextNumber(tx, cid, `po:${po.distributor_id}`, fy));
      if (!(await tx.query("UPDATE purchase_orders SET status='submitted', number=$1, fy=$2, submitted_at=NOW() WHERE id=$3 AND status='draft' RETURNING id", [number, fy, po.id])).rows[0])
        throw bad("only drafts can be submitted", 409);
    });
    res.json(await loadPo(db, cid, po.id));
  }));
  app.post("/api/pos/:id/reject", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const reason = String(req.body?.reason || "").trim(); if (!reason) throw bad("reason required");
    const po = await own(req, cid);
    if (!(await db.query("UPDATE purchase_orders SET status='rejected', reject_reason=$1, decided_at=NOW(), decided_by=$2 WHERE id=$3 AND status='submitted' RETURNING id", [reason, req.user.uid, po.id])).rows[0])
      throw bad("only submitted POs can be rejected", 409);
    res.json(await loadPo(db, cid, po.id));
  }));
  app.post("/api/pos/:id/approve", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const po = await own(req, cid);
    const edits = new Map<number, any>((Array.isArray(req.body?.lines) ? req.body.lines : []).map((l: any) => [Number(l.lineId), l]));
    for (const id of edits.keys()) if (!po.lines.some((l: any) => l.id === id)) throw bad(`line ${id} is not on this PO`, 404);
    await withTx(db, async tx => {
      if (!(await tx.query("UPDATE purchase_orders SET status='approved', decided_at=NOW(), decided_by=$1 WHERE id=$2 AND status='submitted' RETURNING id", [req.user.uid, po.id])).rows[0])
        throw bad("only submitted POs can be approved", 409);
      let any = 0;
      for (const l of po.lines) {
        const e = edits.get(l.id) ?? {};
        const qty = e.qty != null ? Number(e.qty) : l.qty_requested;
        if (!Number.isInteger(qty) || qty < 0) throw bad("approved qty must be a whole number ≥ 0");
        let rate = l.rate;
        if (e.rate != null && Number(e.rate) !== l.rate) {
          const nr = r2(Number(e.rate)); if (!(nr >= 0)) throw bad("override rate must be ≥ 0");
          if (!String(e.reason || "").trim()) throw bad("a reason is required for a price override");
          await tx.query("INSERT INTO po_price_audit (company_id,po_line_id,old_rate,new_rate,reason,user_id) VALUES ($1,$2,$3,$4,$5,$6)", [cid, l.id, l.rate, nr, String(e.reason).trim(), req.user.uid]);
          rate = nr;
        }
        any += qty;
        await tx.query("UPDATE po_lines SET qty_approved=$1, rate=$2 WHERE id=$3", [qty, rate, l.id]);
      }
      if (!any) throw bad("all quantities are zero — reject the PO instead");
      await recompute(tx, po, await intraFor(cid, s, po.distributor_id));
    });
    res.json(await loadPo(db, cid, po.id));
  }));
  app.post("/api/pos/:id/dispatch", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const po = await own(req, cid);
    if (!["approved", "partially_dispatched"].includes(po.status)) throw bad("PO must be approved before dispatch", 409);
    const want = (Array.isArray(req.body?.lines) ? req.body.lines : po.lines.map((l: any) => ({ lineId: l.id, qty: (l.qty_approved ?? 0) - l.qty_dispatched })))
      .filter((w: any) => Number(w.qty) > 0);
    if (!want.length) throw bad("nothing to dispatch");
    await withTx(db, async tx => {
      const d = (await tx.query("INSERT INTO po_dispatches (po_id,created_by) VALUES ($1,$2) RETURNING id", [po.id, req.user.uid])).rows[0];
      for (const w of want) {
        const l = po.lines.find((x: any) => x.id === Number(w.lineId)); if (!l) throw bad(`line ${w.lineId} not on this PO`, 404);
        const q = Number(w.qty), open = (l.qty_approved ?? 0) - l.qty_dispatched;
        if (!Number.isInteger(q) || q > open) throw bad(`${l.sku}: can dispatch at most ${open}`, 409);
        if (s.features.stock) {
          // Pick from company stock first-expiry-first-out; batch/expiry travel to the distributor on receipt.
          let left = q;
          for (const r of await fefoRows(tx, cid, null, l.variant_id)) {
            const take = Math.min(r.qty, left); if (take <= 0) continue;
            if (!(await tx.query("UPDATE stock SET updated_at=NOW(), qty=$1 WHERE id=$2 AND qty=$3 RETURNING id", [r.qty - take, r.id, r.qty])).rows[0]) throw bad("stock changed — retry", 409);
            await tx.query("INSERT INTO po_dispatch_lines (dispatch_id,po_line_id,qty,batch_no,expiry) VALUES ($1,$2,$3,$4,$5)", [d.id, l.id, take, r.batch_no, r.expiry]);
            left -= take; if (!left) break;
          }
          if (left > 0) throw bad(`insufficient company stock for ${l.sku}: short by ${left}`, 409);
        } else {
          const batch = s.features.batches ? String(w.batch || "").trim() : "", expiry = s.features.batches && w.expiry ? parseDate(w.expiry) : null;
          await tx.query("INSERT INTO po_dispatch_lines (dispatch_id,po_line_id,qty,batch_no,expiry) VALUES ($1,$2,$3,$4,$5)", [d.id, l.id, q, batch, expiry]);
        }
        if (!(await tx.query("UPDATE po_lines SET qty_dispatched=$1 WHERE id=$2 AND qty_dispatched=$3 RETURNING id", [l.qty_dispatched + q, l.id, l.qty_dispatched])).rows[0]) throw bad("PO changed — retry", 409);
        l.qty_dispatched += q;
      }
      const lines = (await tx.query("SELECT qty_approved, qty_dispatched FROM po_lines WHERE po_id=$1", [po.id])).rows;
      const full = lines.every(l => Number(l.qty_dispatched) >= Number(l.qty_approved ?? 0));
      await tx.query("UPDATE purchase_orders SET status=$1 WHERE id=$2", [full ? "dispatched" : "partially_dispatched", po.id]);
    });
    res.json(await loadPo(db, cid, po.id));
  }));
  app.post("/api/pos/:id/dispatches/:did/receive", auth("distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const s = await enabled(cid); const po = await own(req, cid);
    const d = po.dispatches.find((x: any) => x.id === Number(req.params.did)); if (!d) throw bad("dispatch not found", 404);
    // GRN (optional, Field rules): the distributor confirms the quantity actually received per line; only that goes into stock.
    const grn = (await getFlow(db, cid)).grnConfirm, got = new Map<number, number>();
    if (grn) {
      for (const x of Array.isArray(req.body?.lines) ? req.body.lines : []) { const q = Number(x.qty); if (!Number.isInteger(q) || q < 0) throw bad("received quantities must be whole numbers ≥ 0"); got.set(Number(x.dispatchLineId), q); }
      for (const dl of d.lines) { if (!got.has(dl.id)) throw bad("Confirm the received quantity for every line (GRN)"); if (got.get(dl.id)! > dl.qty) throw bad(`${dl.sku ?? "line"}: received more than dispatched`); }
    }
    await withTx(db, async tx => {
      if (!(await tx.query("UPDATE po_dispatches SET received_at=NOW(), received_by=$1, grn_no=$3 WHERE id=$2 AND received_at IS NULL RETURNING id", [req.user.uid, d.id, grn ? `GRN-${po.number ?? po.id}-${d.id}` : null])).rows[0]) throw bad("dispatch already received", 409);
      for (const dl0 of d.lines) {
        const dl = grn ? { ...dl0, qty: got.get(dl0.id)! } : dl0;
        if (grn) await tx.query("UPDATE po_dispatch_lines SET received_qty=$1 WHERE id=$2", [dl.qty, dl0.id]);
        const l = po.lines.find((x: any) => x.id === dl.po_line_id);
        if (!(await tx.query("UPDATE po_lines SET qty_received=$1 WHERE id=$2 AND qty_received=$3 RETURNING id", [l.qty_received + dl.qty, l.id, l.qty_received])).rows[0]) throw bad("PO changed — retry", 409);
        l.qty_received += dl.qty;
        if (!s.features.stock) continue;
        const ex = (await tx.query("SELECT id, qty FROM stock WHERE company_id=$1 AND distributor_id=$2 AND variant_id=$3 AND batch_no=$4", [cid, po.distributor_id, l.variant_id, dl.batch_no])).rows[0];
        if (ex) { if (!(await tx.query("UPDATE stock SET updated_at=NOW(), qty=$1 WHERE id=$2 AND qty=$3 RETURNING id", [Number(ex.qty) + dl.qty, ex.id, ex.qty])).rows[0]) throw bad("stock changed — retry", 409); }
        else await tx.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,$4,$5,$6)", [cid, po.distributor_id, l.variant_id, dl.batch_no, dl.expiry, dl.qty]);
        await logMove(tx, cid, po.distributor_id, l.variant_id, dl.batch_no, dl.qty, "in", `po:${po.number ?? po.id}`, req.user.uid);
      }
      const ls = (await tx.query("SELECT qty_approved, qty_received FROM po_lines WHERE po_id=$1", [po.id])).rows;
      if (ls.every(l => Number(l.qty_received) >= Number(l.qty_approved ?? 0))) await tx.query("UPDATE purchase_orders SET status='received' WHERE id=$1", [po.id]);
    });
    res.json(await loadPo(db, cid, po.id));
  }));
  app.get("/api/pos/:id/print", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const po = await own(req, cid); const c = (await db.query("SELECT name FROM companies WHERE id=$1", [cid])).rows[0];
    res.type("html").send(poHtml(po, c.name));
  }));
  app.get("/api/pos/:id/export", auth(...ALL), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const po = await own(req, cid); const ws = XLSX.utils.json_to_sheet(poRows(po)); const name = String(po.number || `draft-${po.id}`).replace(/\//g, "-");
    if (req.query.format === "xlsx") { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "PO"); return res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").attachment(`${name}.xlsx`).send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })); }
    res.type("text/csv").attachment(`${name}.csv`).send(XLSX.utils.sheet_to_csv(ws));
  }));
}
