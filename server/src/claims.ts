// Distributor claims: scheme payouts, damaged goods and expired goods. Distributor submits, manager approves (optionally a lower
// amount) or rejects, and settling issues a numbered claim credit note to the distributor (printable). Damage/expiry lines with
// quantities are taken out of the distributor's stock on settlement when stock tracking is on.
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { bad, today, parseJson } from "./catalog.js";
import { nextNumber, fyOf, esc, inr, r2 } from "./billing.js";
import { emit } from "./integrations/webhooks.js";
import { logMove } from "./inventory.js";
import { audit } from "./security.js";
import { checkClaimApproval } from "./flow.js";
import { type Ctx, MGR, requireFeature } from "./common.js";

export const CLAIM_KINDS = ["scheme", "damage", "expiry"];
const load = async (db: Db, cid: number, id: number) => {
  const c = (await db.query("SELECT c.*, u.name AS distributor, sc.name AS scheme FROM claims c JOIN users u ON u.id=c.distributor_id LEFT JOIN schemes sc ON sc.id=c.scheme_id WHERE c.id=$1 AND c.company_id=$2", [id, cid])).rows[0];
  if (!c) throw bad("claim not found", 404);
  return { ...c, amount: Number(c.amount), approved_amount: c.approved_amount == null ? null : Number(c.approved_amount), lines: parseJson(c.lines, []) };
};

export function registerClaimRoutes({ app, db, auth, wrap, tenant }: Ctx) {
  app.post("/api/claims", auth("distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "claims");
    const b = req.body || {}, kind = String(b.kind || "");
    if (!CLAIM_KINDS.includes(kind)) throw bad(`type must be one of ${CLAIM_KINDS.join(", ")}`);
    const description = String(b.description || "").trim().slice(0, 500); if (!description) throw bad("describe the claim");
    const lines: any[] = [];
    for (const l of Array.isArray(b.lines) ? b.lines : []) {
      if (!l?.sku) continue; const q = Number(l.qty); if (!Number.isInteger(q) || q <= 0) throw bad("quantities must be whole numbers");
      const v = (await db.query("SELECT id, sku, billing_price FROM variants WHERE company_id=$1 AND (sku=$2 OR barcode=$2)", [cid, String(l.sku).trim()])).rows[0]; if (!v) throw bad(`product ${l.sku} not found`, 404);
      lines.push({ variant_id: v.id, sku: v.sku, qty: q, batch_no: String(l.batch_no || ""), value: r2(q * Number(v.billing_price)) });
    }
    const amount = b.amount != null && b.amount !== "" ? Number(b.amount) : r2(lines.reduce((a, l) => a + l.value, 0));
    if (!(amount > 0) || amount > 1e8) throw bad("enter the claim amount");
    const schemeId = kind === "scheme" && b.schemeId ? Number(b.schemeId) : null;
    if (schemeId && !(await db.query("SELECT id FROM schemes WHERE id=$1 AND company_id=$2", [schemeId, cid])).rows[0]) throw bad("scheme not found", 404);
    const c = (await db.query("INSERT INTO claims (company_id,distributor_id,kind,scheme_id,description,lines,amount) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [cid, req.user.uid, kind, schemeId, description, JSON.stringify(lines), r2(amount)])).rows[0];
    await emit(db, cid, "claim.submitted", { id: c.id, kind, amount: r2(amount), distributor_id: req.user.uid });
    res.status(201).json(await load(db, cid, c.id));
  }));
  app.get("/api/claims", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "claims");
    const own = req.user.role === "distributor";
    const ids = (await db.query(`SELECT id FROM claims WHERE company_id=$1 ${own ? "AND distributor_id=$2" : ""} ORDER BY id DESC LIMIT 300`, own ? [cid, req.user.uid] : [cid])).rows;
    res.json(await Promise.all(ids.map(r => load(db, cid, r.id))));
  }));
  app.post("/api/claims/:id/decide", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; await requireFeature(db, cid, "claims");
    const c = await load(db, cid, Number(req.params.id)); if (c.status !== "submitted") throw bad("this claim was already decided", 409);
    const approve = req.body?.approve === true, amt = req.body?.amount != null ? Number(req.body.amount) : c.amount;
    if (approve && (!(amt > 0) || amt > c.amount)) throw bad("approved amount must be more than 0 and not above the claim");
    if (!approve && !String(req.body?.reason || "").trim()) throw bad("give a reason for rejecting");
    if (approve) await checkClaimApproval(db, cid, req.user.role, c, amt);
    await db.query("UPDATE claims SET status=$1, approved_amount=$2, reason=$3, decided_by=$4, decided_at=NOW() WHERE id=$5 AND status='submitted'",
      [approve ? "approved" : "rejected", approve ? r2(amt) : null, String(req.body?.reason || "").slice(0, 300) || null, req.user.uid, c.id]);
    await audit(db, { companyId: cid, userId: req.user.uid, action: approve ? "claim.approve" : "claim.reject", target: `claim:${c.id}`, detail: { amount: amt }, ip: req.ip });
    res.json(await load(db, cid, c.id));
  }));
  app.post("/api/claims/:id/settle", auth(...MGR), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return; const s = await requireFeature(db, cid, "claims");
    const c = await load(db, cid, Number(req.params.id)); if (c.status !== "approved") throw bad("approve the claim first", 409);
    const fy = fyOf(today());
    const no = await withTx(db, async tx => {
      const n = `CCN/${fy}/${String(await nextNumber(tx, cid, "claim_cn", fy)).padStart(4, "0")}`;
      if (!(await tx.query("UPDATE claims SET status='settled', credit_note_no=$1, settled_at=NOW() WHERE id=$2 AND status='approved' RETURNING id", [n, c.id])).rows[0]) throw bad("claim changed — reload", 409);
      if (s.features.stock && c.kind !== "scheme") for (const l of c.lines) {
        const st = (await tx.query("SELECT id, qty FROM stock WHERE company_id=$1 AND distributor_id=$2 AND variant_id=$3 AND batch_no=$4", [cid, c.distributor_id, l.variant_id, l.batch_no || ""])).rows[0];
        if (!st) continue; const take = Math.min(Number(st.qty), l.qty);
        await tx.query("UPDATE stock SET updated_at=NOW(), qty=$1 WHERE id=$2", [Number(st.qty) - take, st.id]);
        await logMove(tx, cid, c.distributor_id, l.variant_id, l.batch_no || "", -take, `claim_${c.kind}`, n, req.user.uid);
      }
      return n;
    });
    await emit(db, cid, "claim.settled", { id: c.id, kind: c.kind, amount: c.approved_amount, credit_note_no: no, distributor_id: c.distributor_id });
    res.json(await load(db, cid, c.id));
  }));
  app.get("/api/claims/:id/print", auth(...MGR, "distributor"), wrap(async (req, res) => {
    const cid = tenant(req, res); if (cid == null) return;
    const c = await load(db, cid, Number(req.params.id));
    if (req.user.role === "distributor" && c.distributor_id !== req.user.uid) throw bad("claim not found", 404);
    if (c.status !== "settled") throw bad("only settled claims have a credit note", 409);
    const co = (await db.query("SELECT name FROM companies WHERE id=$1", [cid])).rows[0];
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>${esc(c.credit_note_no)}</title><body style="font:14px system-ui;max-width:640px;margin:24px auto">
<h2>CLAIM CREDIT NOTE ${esc(c.credit_note_no)}</h2><p>From <b>${esc(co.name)}</b> to <b>${esc(c.distributor)}</b><br>Date ${esc(String(c.settled_at).slice(0, 10))}</p>
<p>Claim #${c.id} (${esc(c.kind)}${c.scheme ? `: ${esc(c.scheme)}` : ""}) — ${esc(c.description)}</p>
${c.lines.length ? `<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>SKU</th><th>Batch</th><th>Qty</th><th>Value</th></tr>${c.lines.map((l: any) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.batch_no)}</td><td>${l.qty}</td><td>${inr(l.value)}</td></tr>`).join("")}</table>` : ""}
<p>Claimed ₹${inr(c.amount)} · <b>Credited ₹${inr(c.approved_amount)}</b></p><p style="color:#666">This credit note settles the claim against the distributor's account. Not a GST tax invoice.</p></body>`);
  }));
}
