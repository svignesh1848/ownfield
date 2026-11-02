// Sales returns: the rep books a return at the outlet (against an invoice or without one: reason, qty, condition
// saleable/damaged, optional photo). The outlet's distributor (or the company when there is none) approves fully or
// partly, or rejects. Approval raises a GST credit note in the issuer's credit-note series (linked to the original
// invoice when there is one), which lowers the outlet's outstanding, puts saleable goods back into the distributor's
// stock and records damaged goods separately (they are not sellable).
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, getCompany, parseJson, today } from "./catalog.js";
import { type Ctx, MGR } from "./common.js";
import { createDoc, distributorIssuer, loadInvoice, rateFor, r2 } from "./billing.js";
import { logMove } from "./inventory.js";
import { photoStore } from "./storage.js";
import { notify } from "./field.js";
import { saveDataUrlPhoto } from "./outlets.js";
import { teamIds, inTeam, assertTeam } from "./hierarchy.js";

export const RETURN_REASONS = ["Damaged", "Expired / near expiry", "Wrong item", "Not selling", "Quality issue", "Other"];
const CONDITIONS = ["saleable", "damaged"];

/** Base qty already credited or waiting on pending returns for an invoice line. */
async function usedQty(db: Db, lineId: number, exceptReturn = 0) {
  const credited = (await db.query("SELECT COALESCE(SUM(base_qty),0) AS n FROM invoice_lines WHERE ref_line_id=$1", [lineId])).rows[0].n;
  const pending = (await db.query("SELECT COALESCE(SUM(l.qty),0) AS n FROM sales_return_lines l JOIN sales_returns r ON r.id=l.return_id WHERE l.invoice_line_id=$1 AND r.status='pending' AND r.id<>$2", [lineId, exceptReturn])).rows[0].n;
  return Number(credited) + Number(pending);
}

export async function loadReturn(db: Db, cid: number, id: number) {
  const r = (await db.query(`SELECT r.*, s.name AS shop_name, s.code AS shop_code, u.name AS rep_name, d.name AS distributor_name, i.number AS invoice_number, cn.number AS credit_note_number, cn.total AS credit_total
    FROM sales_returns r JOIN shops s ON s.id=r.shop_id LEFT JOIN users u ON u.id=r.rep_id LEFT JOIN users d ON d.id=r.distributor_id LEFT JOIN invoices i ON i.id=r.invoice_id LEFT JOIN invoices cn ON cn.id=r.credit_note_id
    WHERE r.id=$1 AND r.company_id=$2`, [id, cid])).rows[0];
  if (!r) throw bad("return not found", 404);
  r.lines = (await db.query(`SELECT l.*, v.sku, i.name AS item_name, v.attrs FROM sales_return_lines l JOIN variants v ON v.id=l.variant_id JOIN items i ON i.id=v.item_id WHERE l.return_id=$1 ORDER BY l.id`, [r.id])).rows
    .map((l: any) => ({ ...l, attrs: parseJson(l.attrs, {}), rate: l.rate == null ? null : Number(l.rate) }));
  r.has_photo = !!r.photo_file; delete r.photo_file; r.credit_total = r.credit_total == null ? null : Number(r.credit_total);
  return r;
}

export function registerReturnRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.get("/api/returns/reasons", auth(...MGR, "sales_rep", "distributor", "retailer"), (_q: any, res: any) => res.json({ reasons: RETURN_REASONS, conditions: CONDITIONS }));

  // Invoices of one outlet with their lines, for picking what is returned (cached on the phone for offline use).
  app.get("/api/returns/invoices", auth(...MGR, "sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const rows = (await db.query("SELECT id, number, doc_date, total FROM invoices WHERE company_id=$1 AND shop_id=$2 AND kind='invoice' ORDER BY doc_date DESC, id DESC LIMIT 30", [cid, Number(req.query.shopId) || 0])).rows;
    const out = [];
    for (const r of rows) {
      const lines = (await db.query("SELECT id, variant_id, description, base_qty, uom FROM invoice_lines WHERE invoice_id=$1 ORDER BY id", [r.id])).rows;
      for (const l of lines) l.returnable = Math.max(0, Number(l.base_qty) - (await usedQty(db, l.id)));
      out.push({ ...r, total: Number(r.total), lines });
    }
    res.json(out);
  }));
  // Book a return (rep at the outlet). Idempotent on clientRef so the offline queue can safely retry.
  app.post("/api/returns", auth("sales_rep"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const b = req.body || {}, ref = String(b.clientRef || "").trim().slice(0, 64);
    if (!ref) throw bad("clientRef required");
    const dup = (await db.query("SELECT id FROM sales_returns WHERE company_id=$1 AND client_ref=$2", [cid, ref])).rows[0];
    if (dup) return res.status(200).json({ ...(await loadReturn(db, cid, dup.id)), duplicate: true });
    const shop = (await db.query("SELECT * FROM shops WHERE id=$1 AND company_id=$2", [Number(b.shopId), cid])).rows[0];
    if (!shop) throw bad("shop not found", 404);
    const reason = String(b.reason || "").trim().slice(0, 100); if (!reason) throw bad("pick a reason for the return");
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l: any) => Number(l.qty) > 0);
    if (!lines.length) throw bad("add at least one product with a quantity");
    let inv: any = null;
    if (b.invoiceId) {
      inv = await loadInvoice(db, cid, Number(b.invoiceId));
      if (inv.kind !== "invoice" || inv.shop_id !== shop.id) throw bad("invoice not found for this outlet", 404);
    }
    const out: any[] = [];
    for (const l of lines) {
      const q = Number(l.qty); if (!Number.isInteger(q) || q <= 0) throw bad("qty must be a whole number");
      const cond = String(l.condition || "saleable"); if (!CONDITIONS.includes(cond)) throw bad("condition must be saleable or damaged");
      if (inv) {
        const il = inv.lines.find((x: any) => x.id === Number(l.invoiceLineId) || (!l.invoiceLineId && x.variant_id === Number(l.variantId)));
        if (!il) throw bad("that product is not on this invoice", 404);
        const left = il.base_qty - (await usedQty(db, il.id)) - out.filter(o => o.invoiceLineId === il.id).reduce((a, o) => a + o.qty, 0);
        if (q > left) throw bad(`cannot return ${q} of ${il.description}: ${Math.max(0, left)} returnable`, 409);
        out.push({ variantId: il.variant_id, invoiceLineId: il.id, qty: q, condition: cond, rate: il.rate });
      } else {
        const v = (await db.query("SELECT id, billing_price FROM variants WHERE id=$1 AND company_id=$2", [Number(l.variantId), cid])).rows[0];
        if (!v) throw bad("product not found", 404);
        out.push({ variantId: v.id, invoiceLineId: null, qty: q, condition: cond, rate: Number(v.billing_price) });
      }
    }
    const photo = await saveDataUrlPhoto(cid, b.photo);
    const dist = inv && String(inv.issuer).startsWith("d") ? Number(String(inv.issuer).slice(1)) : shop.distributor_id ?? null;
    const id = await withTx(db, async tx => {
      const r = (await tx.query(`INSERT INTO sales_returns (company_id,client_ref,rep_id,shop_id,distributor_id,invoice_id,reason,note,photo_file,photo_mime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [cid, ref, req.user.uid, shop.id, dist, inv?.id ?? null, reason, String(b.note || "").trim().slice(0, 300) || null, photo?.file ?? null, photo?.mime ?? null])).rows[0];
      for (const l of out) await tx.query("INSERT INTO sales_return_lines (return_id,variant_id,invoice_line_id,qty,condition,rate) VALUES ($1,$2,$3,$4,$5,$6)", [r.id, l.variantId, l.invoiceLineId, l.qty, l.condition, l.rate]);
      const to = dist ? [dist] : (await tx.query("SELECT id FROM users WHERE company_id=$1 AND role='company_admin' AND active", [cid])).rows.map((x: any) => x.id);
      for (const u of to) await notify(tx, cid, u, "Return #{0} from {1} needs your decision", [r.id, shop.name], reason, "returns");
      return r.id;
    });
    res.status(201).json(await loadReturn(db, cid, id));
  }));

  app.get("/api/returns", auth(...MGR, "sales_rep", "distributor", "retailer"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const role = req.user.role, uid = Number(req.user.uid) | 0;
    let w = role === "sales_rep" ? ` AND r.rep_id=${uid}` : role === "distributor" ? ` AND r.distributor_id=${uid}` : role === "retailer" ? ` AND r.shop_id=(SELECT shop_id FROM users WHERE id=${uid})` : "";
    w += inTeam("r.rep_id", await teamIds(db, cid, req.user));
    if (["pending", "approved", "partial", "rejected"].includes(String(req.query.status))) w += ` AND r.status='${String(req.query.status)}'`;
    const ids = (await db.query(`SELECT r.id FROM sales_returns r WHERE r.company_id=$1${w} ORDER BY r.id DESC LIMIT 300`, [cid])).rows;
    const out = []; for (const x of ids) out.push(await loadReturn(db, cid, x.id));
    res.json(out);
  }));

  // Distributor (or admin; manager/admin when the outlet has no distributor) approves, partly approves or rejects.
  app.post("/api/returns/:id/decision", auth("company_admin", "manager", "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const ret = await loadReturn(db, cid, Number(req.params.id));
    if (req.user.role === "distributor" && ret.distributor_id !== req.user.uid) throw bad("return not found", 404);
    if (req.user.role === "manager") { if (ret.distributor_id) throw bad("the distributor decides on this return", 403); await assertTeam(db, cid, req.user, ret.rep_id); }
    if (ret.status !== "pending") throw bad("this return is already decided", 409);
    const d = String(req.body?.decision || ""); if (!["approve", "reject"].includes(d)) throw bad("decision must be approve or reject");
    const note = String(req.body?.note || "").trim().slice(0, 300) || null;
    if (d === "reject") {
      if (!note) throw bad("tell the rep why the return was rejected");
      const u = (await db.query("UPDATE sales_returns SET status='rejected', decided_by=$1, decided_at=NOW(), decision_note=$2 WHERE id=$3 AND status='pending' RETURNING id", [req.user.uid, note, ret.id])).rows[0];
      if (!u) throw bad("return changed meanwhile — reload", 409);
      if (ret.rep_id) await notify(db, cid, ret.rep_id, "Return #{0} at {1}: {2}", [ret.id, ret.shop_name, "rejected"], note, "returns");
      return res.json(await loadReturn(db, cid, ret.id));
    }
    const given = new Map<number, number>((Array.isArray(req.body?.lines) ? req.body.lines : []).map((l: any) => [Number(l.id), Number(l.approvedQty)]));
    const approved = ret.lines.map((l: any) => { const q = given.has(l.id) ? given.get(l.id)! : l.qty; if (!Number.isInteger(q) || q < 0 || q > l.qty) throw bad(`approved qty for ${l.sku} must be 0 to ${l.qty}`); return { ...l, approved: q }; });
    if (!approved.some((l: any) => l.approved > 0)) throw bad("approve at least one unit, or reject the return");
    const partial = approved.some((l: any) => l.approved < l.qty);
    const { settings } = await getCompany(db, cid);
    if (!settings.features.invoicing) throw bad("invoicing is turned off for this company");
    // Issuer of the credit note: the original invoice's issuer, else the distributor (with distributor billing), else the company.
    const inv = ret.invoice_id ? await loadInvoice(db, cid, ret.invoice_id) : null;
    const key = inv ? inv.issuer : ret.distributor_id && settings.features.distributorBilling ? `d${ret.distributor_id}` : "company";
    const issuer = key === "company" ? { key, g: settings.gst } : await distributorIssuer(db, cid, settings, Number(key.slice(1)));
    if (!issuer || !issuer.g.gstin || !issuer.g.stateCode || !issuer.g.legalName) throw bad(key === "company" ? "set legal name, GSTIN and state code in Settings → GST first" : "the distributor's legal name, GSTIN and state code must be set first");
    const out = await withTx(db, async tx => {
      const shop = (await tx.query("SELECT * FROM shops WHERE id=$1", [ret.shop_id])).rows[0];
      const docLines: any[] = [];
      for (const l of approved.filter((x: any) => x.approved > 0)) {
        if (l.invoice_line_id) {
          const il = inv!.lines.find((x: any) => x.id === l.invoice_line_id);
          const done = Number((await tx.query("SELECT COALESCE(SUM(base_qty),0) AS n FROM invoice_lines WHERE ref_line_id=$1", [il.id])).rows[0].n);
          if (done + l.approved > il.base_qty) throw bad(`cannot credit ${l.approved} of ${il.description}: ${il.base_qty - done} returnable`, 409);
          docLines.push({ refLineId: il.id, variantId: il.variant_id, description: il.description, hsn: il.hsn, baseQty: l.approved, uom: il.uom, rate: il.rate, taxable: r2(il.taxable * l.approved / il.base_qty), gstRate: il.gst_rate });
        } else {
          const v = (await tx.query("SELECT v.sku, v.attrs, i.name, i.hsn FROM variants v JOIN items i ON i.id=v.item_id WHERE v.id=$1", [l.variant_id])).rows[0];
          docLines.push({ variantId: l.variant_id, description: `${v.name} ${Object.values(parseJson<Record<string, string>>(v.attrs, {})).join(" / ")} (${v.sku}) — sales return`.replace(/\s+/g, " "), hsn: v.hsn,
            baseQty: l.approved, uom: "PCS", rate: Number(l.rate), taxable: r2(Number(l.rate) * l.approved), gstRate: rateFor(settings.gst, v.hsn) });
        }
      }
      const cn = await createDoc(tx, cid, req.user.uid, { kind: "credit_note", issuer: issuer.key, date: today(), g: issuer.g, shop, orderId: inv?.order_id ?? null, refId: inv?.id ?? null,
        reason: `Sales return #${ret.id}: ${ret.reason}`, lines: docLines });
      for (const l of approved) {
        await tx.query("UPDATE sales_return_lines SET approved_qty=$1 WHERE id=$2", [l.approved, l.id]);
        if (!l.approved) continue;
        if (l.condition === "damaged") { // damaged goods are kept apart, never sold
          await tx.query("INSERT INTO damaged_stock (company_id,distributor_id,variant_id,qty,return_id) VALUES ($1,$2,$3,$4,$5)", [cid, ret.distributor_id, l.variant_id, l.approved, ret.id]);
        } else if (settings.features.stock) {
          // Saleable goods go back into the batch they were sold from when known, else into an unbatched row at the distributor.
          const al = l.invoice_line_id ? (await tx.query("SELECT a.stock_id FROM order_allocations a JOIN invoice_lines il ON il.order_line_id=a.order_line_id WHERE il.id=$1 ORDER BY a.id LIMIT 1", [l.invoice_line_id])).rows[0] : null;
          let st = al ? (await tx.query("SELECT * FROM stock WHERE id=$1", [al.stock_id])).rows[0] : null;
          if (!st) st = (await tx.query(`SELECT * FROM stock WHERE company_id=$1 AND variant_id=$2 AND batch_no='' AND ${ret.distributor_id ? "distributor_id=$3" : "distributor_id IS NULL"} LIMIT 1`, ret.distributor_id ? [cid, l.variant_id, ret.distributor_id] : [cid, l.variant_id])).rows[0];
          if (st) await tx.query("UPDATE stock SET updated_at=NOW(), qty=qty+$1 WHERE id=$2", [l.approved, st.id]);
          else st = (await tx.query("INSERT INTO stock (company_id,distributor_id,variant_id,batch_no,expiry,qty) VALUES ($1,$2,$3,'',NULL,$4) RETURNING *", [cid, ret.distributor_id, l.variant_id, l.approved])).rows[0];
          await logMove(tx, cid, st.distributor_id ?? null, l.variant_id, st.batch_no || "", l.approved, "return", `credit_note:${cn.number}`, req.user.uid, `sales return #${ret.id}`);
        }
      }
      const u = (await tx.query("UPDATE sales_returns SET status=$1, decided_by=$2, decided_at=NOW(), decision_note=$3, credit_note_id=$4 WHERE id=$5 AND status='pending' RETURNING id",
        [partial ? "partial" : "approved", req.user.uid, note, cn.id, ret.id])).rows[0];
      if (!u) throw bad("return changed meanwhile — reload", 409);
      if (ret.rep_id) await notify(tx, cid, ret.rep_id, "Return #{0} at {1}: {2}", [ret.id, ret.shop_name, partial ? "partly approved" : "approved"], `${cn.number}`, "returns");
      return cn;
    });
    res.json({ ...(await loadReturn(db, cid, ret.id)), credit_note: { id: out.id, number: out.number, total: Number(out.total) } });
  }));

  app.get("/api/returns/:id/photo", auth(...MGR, "sales_rep", "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const r = (await db.query("SELECT photo_file, photo_mime, rep_id, distributor_id FROM sales_returns WHERE id=$1 AND company_id=$2", [Number(req.params.id), cid])).rows[0];
    if (!r?.photo_file || (req.user.role === "sales_rep" && r.rep_id !== req.user.uid) || (req.user.role === "distributor" && r.distributor_id !== req.user.uid)) throw bad("photo not found", 404);
    if (req.user.role === "manager") await assertTeam(db, cid, req.user, r.rep_id);
    res.type(r.photo_mime).send(await photoStore().get(r.photo_file));
  }));
  // Damaged returned goods, per location and product (kept out of sellable stock).
  app.get("/api/returns/damaged", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const own = req.user.role === "distributor";
    res.json((await db.query(`SELECT d.distributor_id, u.name AS location, d.variant_id, v.sku, i.name AS item_name, SUM(d.qty) AS qty FROM damaged_stock d JOIN variants v ON v.id=d.variant_id JOIN items i ON i.id=v.item_id
      LEFT JOIN users u ON u.id=d.distributor_id WHERE d.company_id=$1 ${own ? "AND d.distributor_id=$2" : ""} GROUP BY d.distributor_id, u.name, d.variant_id, v.sku, i.name ORDER BY v.sku`, own ? [cid, req.user.uid] : [cid])).rows
      .map((r: any) => ({ ...r, qty: Number(r.qty), location: r.location || "Company stock" })));
  }));
}

/** Rows for the "returns" report export. */
export async function returnRows(db: Db, cid: number, inRange: (d: string) => boolean, dayKey: (d: any) => string, team: number[] | null) {
  return (await db.query(`SELECT r.id, r.created_at, r.status, r.reason, s.code, s.name AS outlet, u.name AS rep, d.name AS distributor, i.number AS invoice, cn.number AS credit_note,
      v.sku, it.name AS item, l.qty, l.approved_qty, l.condition, l.rate FROM sales_returns r JOIN sales_return_lines l ON l.return_id=r.id JOIN variants v ON v.id=l.variant_id JOIN items it ON it.id=v.item_id
      JOIN shops s ON s.id=r.shop_id LEFT JOIN users u ON u.id=r.rep_id LEFT JOIN users d ON d.id=r.distributor_id LEFT JOIN invoices i ON i.id=r.invoice_id LEFT JOIN invoices cn ON cn.id=r.credit_note_id
      WHERE r.company_id=$1${inTeam("r.rep_id", team)} ORDER BY r.id, l.id`, [cid])).rows
    .filter((r: any) => inRange(dayKey(r.created_at))).map((r: any) => ({ return_id: r.id, date: dayKey(r.created_at), status: r.status, reason: r.reason, outlet_code: r.code, outlet: r.outlet, rep: r.rep || "",
      distributor: r.distributor || "Company", invoice: r.invoice || "", credit_note: r.credit_note || "", sku: r.sku, item: r.item, qty: Number(r.qty), approved_qty: r.approved_qty == null ? "" : Number(r.approved_qty),
      condition: r.condition, rate: Number(r.rate), value: r.approved_qty == null ? "" : r2(Number(r.rate) * Number(r.approved_qty)) }));
}
