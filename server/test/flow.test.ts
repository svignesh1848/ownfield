// Flow changes: van stock from source + unload, van payments + settlement, productive calls, must-sell, suggested order,
// scheme claims, claim approval rules, expiry block + adjustment approval + GRN, perfect store, start/end day, retailer home.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any, db: any; const T: Record<string, string> = {}; const id: Record<string, number> = {}; let sku = "";
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: (string | number)[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const on = (features: Record<string, boolean>) => request(app).put("/api/company/settings").set(as("adm")).send({ features }).expect(200);
const stockOf = async (dist: number | null) => Number((await db.query(`SELECT COALESCE(SUM(qty),0) AS q FROM stock WHERE variant_id=(SELECT id FROM variants WHERE sku=$1) AND ${dist == null ? "distributor_id IS NULL" : "distributor_id=" + dist}`, [sku])).rows[0].q);

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "FL", name: "FL (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("FL", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep", "r@x.com", "sales_rep", "pw"], ["Dist", "d@x.com", "distributor", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.rep = await login("FL", "r@x.com"); T.dist = await login("FL", "d@x.com"); T.mgr = await login("FL", "m@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { schemes: false, stock: true, batches: true, distInventory: true, vanSales: true }, gst: { legalName: "FL Sample Co", gstin: "33AAAAA0000A1Z9", stateCode: "33" } }).expect(200);
  const shops = (await request(app).get("/api/shops").set(as("adm"))).body; id.s = shops[0].id; id.s2 = shops[1].id;
  const users = (await request(app).get("/api/users").set(as("adm"))).body; id.rep = users.find((u: any) => u.email === "r@x.com").id; id.dist = users.find((u: any) => u.email === "d@x.com").id;
  sku = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1")).rows[0].sku;
  await db.query("UPDATE stock SET qty=0 WHERE variant_id=(SELECT id FROM variants WHERE sku=$1)", [sku]);
  await request(app).post("/api/inventory/moves").set(as("adm")).send({ distributorId: "company", kind: "in", lines: [{ sku, qty: 30, batch: "B1", expiry: "2099-01-31" }, { sku, qty: 10, batch: "B0", expiry: "2098-01-31" }] }).expect(201);
});

describe("1. van load from source stock, and unload", () => {
  it("loading deducts the source stock (FEFO) and refuses more than is there", async () => {
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: "company", lines: [{ sku, qty: 99 }] }).expect(409);
    expect(await stockOf(null)).toBe(40);
    const L = (await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: "company", lines: [{ sku, qty: 15 }] }).expect(201)).body;
    expect(L.lines[0]).toMatchObject({ loaded: 15, left: 15 }); expect(await stockOf(null)).toBe(25);
    expect(Number((await db.query("SELECT qty FROM stock WHERE batch_no='B0'")).rows[0].qty)).toBe(0); // nearest expiry taken first
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: id.dist, lines: [{ sku, qty: 1 }] }).expect(409); // one source per van
  });
  it("unload returns what is left to the source and the ledger shows it", async () => {
    await request(app).post("/api/van/unload").set(as("rep")).send({ lines: [{ sku, qty: 16 }] }).expect(409);
    const u = (await request(app).post("/api/van/unload").set(as("rep")).send({ lines: [{ sku, qty: 5 }] }).expect(200)).body;
    expect(u.lines[0]).toMatchObject({ unloaded: 5, left: 10 }); expect(await stockOf(null)).toBe(30);
    const kinds = (await db.query("SELECT kind FROM stock_moves WHERE kind LIKE 'van_%'")).rows.map((r: any) => r.kind);
    expect(kinds).toContain("van_load"); expect(kinds).toContain("van_unload");
  });
});

describe("2. van payments and day-end settlement", () => {
  it("takes cash, UPI or credit; settlement shows cash and stock differences; manager signs off", async () => {
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p0", shopId: id.s, lines: [{ sku, qty: 1 }], payment: { mode: "card" } }).expect(400);
    const a = (await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p1", shopId: id.s, lines: [{ sku, qty: 2 }], payment: { mode: "cash" } }).expect(201)).body;
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p2", shopId: id.s2, lines: [{ sku, qty: 1 }], payment: { mode: "upi", reference: "UPI123" } }).expect(201);
    await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "p3", shopId: id.s2, lines: [{ sku, qty: 1 }], payment: { mode: "credit" } }).expect(201);
    const cash = Number(a.invoice.total);
    const L = (await request(app).get("/api/van/today").set(as("rep"))).body;
    expect(L.settlement.cash).toBeCloseTo(cash); expect(L.settlement.upi).toBeGreaterThan(0); expect(L.settlement.credit).toBeGreaterThan(0);
    await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("mgr")).expect(409); // not closed yet
    const cr = await request(app).post("/api/van/close").set(as("rep")).send({ counts: [{ sku, qty: L.lines[0].left - 1 }], cashCounted: 0 }); if (cr.status !== 200) console.log("CLOSE", cr.body); const c = cr.body;
    expect(c.settlement).toMatchObject({ cash_diff: -cash, stock_diff_units: -1, signed_off_by: null });
    await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("rep")).expect(403);
    const s = (await request(app).post(`/api/van/loads/${L.id}/signoff`).set(as("mgr")).send({ note: "₹50 short, recovered" }).expect(200)).body;
    expect(s.settlement.signed_off_by).toBe("Mgr");
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM payments WHERE mode IN ('cash','upi')")).rows[0].n)).toBe(2);
  });
});

describe("3. productive calls and no-order reasons", () => {
  it("checkout without an order needs a listed reason; coverage shows productive vs non-productive", async () => {
    await on({ coverage: true, gps: false });
    await request(app).put("/api/flow-settings").set(as("rep")).send({}).expect(403);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ noOrderReasons: ["Shop closed", "Enough stock"] }).expect(200);
    const v = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s }).expect(201)).body;
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({}).expect(400);
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Bad weather" }).expect(400);
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Enough stock" }).expect(200);
    const v2 = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s2 }).expect(201)).body;
    await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "o-prod", shopId: id.s2, lines: [{ sku, qty: 1 }] }).expect(201);
    await request(app).post(`/api/visits/${v2.id}/checkout`).set(as("rep")).send({}).expect(200); // order taken → productive, no reason needed
    const c = (await request(app).get("/api/coverage").set(as("mgr"))).body.reps.find((r: any) => r.rep_id === id.rep);
    expect(c).toMatchObject({ total_calls: 2, productive_calls: 1, non_productive_calls: 1 });
    expect(c.no_order_reasons["Enough stock"]).toBe(1);
  });
});

describe("4. must-sell lists per outlet type", () => {
  it("lists must-sell SKUs for the outlet and coverage shows compliance", async () => {
    const other = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1 OFFSET 1")).rows[0].sku;
    await request(app).put(`/api/shops/${id.s2}/type`).set(as("rep")).send({ outletType: "Grocery" }).expect(403);
    await request(app).put(`/api/shops/${id.s2}/type`).set(as("adm")).send({ outletType: "Grocery" }).expect(200);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ mustSell: { Grocery: [sku, other] } }).expect(200);
    expect((await request(app).get(`/api/must-sell?shopId=${id.s2}`).set(as("rep")).expect(200)).body).toEqual({ outlet_type: "Grocery", skus: [sku, other] });
    expect((await request(app).get(`/api/must-sell?shopId=${id.s}`).set(as("rep")).expect(200)).body.skus).toEqual([]);
    await request(app).post("/api/orders").set(as("rep")).send({ clientRef: "ms-1", shopId: id.s2, lines: [{ sku, qty: 1 }, { sku: other, qty: 1 }] }).expect(201);
    const c = (await request(app).get("/api/coverage").set(as("mgr"))).body.reps.find((r: any) => r.rep_id === id.rep);
    expect(c.must_sell_orders).toBeGreaterThanOrEqual(2); expect(c.must_sell_complete).toBe(1); expect(c.must_sell_missing[other]).toBeGreaterThanOrEqual(1);
  });
});

describe("5. suggested order", () => {
  it("averages the last 3 orders and subtracts shelf stock", async () => {
    const other = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1 OFFSET 1")).rows[0].sku;
    const shop = (await request(app).get("/api/shops").set(as("adm"))).body[2].id;
    expect((await request(app).post("/api/orders/suggest").set(as("rep")).send({ shopId: shop }).expect(200)).body).toEqual({ orders: 0, lines: [] });
    for (const [i, q] of [[1, 4], [2, 6], [3, 8], [4, 2]] as const) // sg-1 is moved back in time, so it falls outside the last 3
      await request(app).post("/api/orders").set(as("rep")).send({ clientRef: `sg-${i}`, shopId: shop, lines: [{ sku, qty: q }, ...(i === 2 ? [{ sku: other, qty: 3 }] : [])] }).expect(201);
    await db.query("UPDATE orders SET created_at=NOW() - INTERVAL '10 days' WHERE client_ref='sg-1'");
    const r = (await request(app).post("/api/orders/suggest").set(as("rep")).send({ shopId: shop, shelf: { [sku]: 1 } }).expect(200)).body;
    expect(r.orders).toBe(3);
    const a = r.lines.find((l: any) => l.sku === sku), b = r.lines.find((l: any) => l.sku === other);
    expect(a).toMatchObject({ avg: Math.round(((6 + 8 + 2) / 3) * 10) / 10, shelf: 1, suggested: Math.ceil((6 + 8 + 2) / 3 - 1) });
    expect(b).toMatchObject({ avg: 1, suggested: 1 });
  });
});

describe("6. scheme claims from invoices", () => {
  it("creates one claim per distributor + scheme + month from invoice discounts, only once", async () => {
    await on({ claims: true });
    const sc = (await db.query("INSERT INTO schemes (company_id,name,discount_pct) VALUES ((SELECT company_id FROM users WHERE id=$1),'Sample 5% off',5) RETURNING id", [id.dist])).rows[0].id;
    const o = (await db.query("SELECT id, company_id FROM orders ORDER BY id LIMIT 1")).rows[0];
    await db.query("UPDATE order_lines SET scheme_id=$1, gross=100, amount=95 WHERE order_id=$2", [sc, o.id]);
    const n = Number((await db.query("SELECT COUNT(*) AS n FROM order_lines WHERE order_id=$1", [o.id])).rows[0].n);
    await db.query(`INSERT INTO invoices (company_id,issuer,kind,number,fy,doc_date,order_id,shop_id,seller,buyer,intra_state,taxable,cgst,sgst,igst,round_off,total)
      VALUES ($1,$2,'invoice','D-SAMPLE-1','2026-27','2026-10-15',$3,$4,'{}','{}',TRUE,95,0,0,0,0,95)`, [o.company_id, `d${id.dist}`, o.id, id.s]);
    await request(app).post("/api/claims/auto-schemes").set(as("adm")).send({ month: "2026-13" }).expect(400);
    const r = (await request(app).post("/api/claims/auto-schemes").set(as("dist")).send({ month: "2026-10" }).expect(200)).body;
    expect(r.created).toBe(1);
    const c = (await request(app).get("/api/claims").set(as("dist"))).body.find((x: any) => x.id === r.ids[0]);
    expect(c).toMatchObject({ kind: "scheme", amount: 5 * n, status: "submitted" }); expect(c.description).toContain("D-SAMPLE-1");
    expect((await request(app).post("/api/claims/auto-schemes").set(as("adm")).send({ month: "2026-10" }).expect(200)).body.created).toBe(0);
  });
});

describe("7. claim approval levels, damage cap and scheme budget", () => {
  it("enforces who may approve, the damage cap and the scheme budget", async () => {
    const mk = async (amount: number) => (await request(app).post("/api/claims").set(as("dist")).send({ kind: "damage", description: "Sample damaged cartons", amount }).expect(201)).body.id;
    await request(app).put("/api/flow-settings").set(as("adm")).send({ claimLevels: [{ kind: "damage", upTo: 100, role: "manager" }], damageCapPct: 0 }).expect(200);
    const small = await mk(80), big = await mk(150);
    await request(app).post(`/api/claims/${small}/decide`).set(as("mgr")).send({ approve: true }).expect(200);
    await request(app).post(`/api/claims/${big}/decide`).set(as("mgr")).send({ approve: true }).expect(403);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ damageCapPct: 10 }).expect(200); // no primary sales this month → cap ₹0
    expect((await request(app).post(`/api/claims/${big}/decide`).set(as("adm")).send({ approve: true }).expect(409)).body.error).toContain("capped");
    await request(app).put("/api/flow-settings").set(as("adm")).send({ damageCapPct: 0 }).expect(200);
    await request(app).post(`/api/claims/${big}/decide`).set(as("adm")).send({ approve: true }).expect(200);
    const sch = (await request(app).get("/api/claims").set(as("adm"))).body.find((x: any) => x.kind === "scheme");
    await request(app).put(`/api/schemes/${sch.scheme_id}/budget`).set(as("mgr")).send({ budget: 3 }).expect(200);
    expect((await request(app).post(`/api/claims/${sch.id}/decide`).set(as("mgr")).send({ approve: true }).expect(409)).body.error).toContain("budget");
    await request(app).post(`/api/claims/${sch.id}/decide`).set(as("mgr")).send({ approve: true, amount: 3 }).expect(200);
  });
});

describe("8. expiry block, adjustment reasons/approval, GRN", () => {
  it("does not sell batches expiring within N days", async () => {
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, lines: [{ sku, qty: 1 }] }); // a closed van earlier; make sure none is open
    await request(app).post("/api/van/unload").set(as("adm")).send({ repId: id.rep });
    await request(app).post("/api/van/close").set(as("adm")).send({ repId: id.rep });
    await db.query("UPDATE stock SET qty=0 WHERE variant_id=(SELECT id FROM variants WHERE sku=$1)", [sku]);
    const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    await request(app).post("/api/inventory/moves").set(as("adm")).send({ distributorId: "company", kind: "in", lines: [{ sku, qty: 5, batch: "SOON", expiry: soon }] }).expect(201);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ expiryBlockDays: 30 }).expect(200);
    expect((await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, lines: [{ sku, qty: 1 }] }).expect(409)).body.error).toContain("not enough stock");
    await request(app).put("/api/flow-settings").set(as("adm")).send({ expiryBlockDays: 0 }).expect(200);
    await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, lines: [{ sku, qty: 1 }] }).expect(201);
  });
  it("stock adjustments need a reason and, when on, a manager's approval", async () => {
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "in", lines: [{ sku, qty: 10, batch: "D1", expiry: "2099-12-31" }] }).expect(201);
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "adjust", lines: [{ sku, qty: 7, batch_no: "D1" }] }).expect(400);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ adjustApproval: true }).expect(200);
    const p = (await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "adjust", reason: "Count correction", lines: [{ sku, qty: 7, batch_no: "D1" }] }).expect(202)).body;
    expect(await stockOf(id.dist)).toBe(10);
    await request(app).post(`/api/inventory/adjustments/${p.id}/decide`).set(as("dist")).send({ approve: true }).expect(403);
    await request(app).post(`/api/inventory/adjustments/${p.id}/decide`).set(as("mgr")).send({ approve: true }).expect(200);
    expect(await stockOf(id.dist)).toBe(7);
    expect((await request(app).get("/api/inventory/moves").set(as("dist"))).body[0]).toMatchObject({ kind: "adjust", reason: "Count correction" });
  });
  it("GRN: with confirmation on, the distributor confirms received quantities and only those go into stock", async () => {
    await on({ purchaseOrders: true });
    const c = (await db.query("SELECT company_id FROM users WHERE id=$1", [id.dist])).rows[0].company_id, vid = (await db.query("SELECT id FROM variants WHERE sku=$1", [sku])).rows[0].id;
    const po = (await db.query("INSERT INTO purchase_orders (company_id,distributor_id,number,status) VALUES ($1,$2,'PO-SAMPLE-1','dispatched') RETURNING id", [c, id.dist])).rows[0].id;
    const pl = (await db.query(`INSERT INTO po_lines (po_id,variant_id,uom,qty_requested,qty_approved,qty_dispatched,base_price,margin_pct,product_disc_pct,dist_disc_pct,computed_rate,rate,gst_rate,taxable,tax,total)
      VALUES ($1,$2,'PCS',6,6,6,10,0,0,0,10,10,0,60,0,60) RETURNING id`, [po, vid])).rows[0].id;
    const d = (await db.query("INSERT INTO po_dispatches (po_id) VALUES ($1) RETURNING id", [po])).rows[0].id;
    const dl = (await db.query("INSERT INTO po_dispatch_lines (dispatch_id,po_line_id,qty,batch_no,expiry) VALUES ($1,$2,6,'G1','2099-06-30') RETURNING id", [d, pl])).rows[0].id;
    await request(app).put("/api/flow-settings").set(as("adm")).send({ grnConfirm: true }).expect(200);
    const before = await stockOf(id.dist);
    await request(app).post(`/api/pos/${po}/dispatches/${d}/receive`).set(as("dist")).send({}).expect(400);
    await request(app).post(`/api/pos/${po}/dispatches/${d}/receive`).set(as("dist")).send({ lines: [{ dispatchLineId: dl, qty: 9 }] }).expect(400);
    await request(app).post(`/api/pos/${po}/dispatches/${d}/receive`).set(as("dist")).send({ lines: [{ dispatchLineId: dl, qty: 5 }] }).expect(200);
    expect(await stockOf(id.dist)).toBe(before + 5);
    expect((await db.query("SELECT grn_no FROM po_dispatches WHERE id=$1", [d])).rows[0].grn_no).toBe(`GRN-PO-SAMPLE-1-${d}`);
  });
});

describe("10. start/end day and the retailer home", () => {
  it("with the rule on, a rep starts the day with GPS (selfie optional) before visits, and ends it", async () => {
    await request(app).post("/api/day/start").set(as("rep")).send({ lat: 13, lng: 80 }).expect(409); // rule off
    await request(app).put("/api/flow-settings").set(as("adm")).send({ dayStart: true, selfie: true }).expect(200);
    for (const v of (await request(app).get("/api/visits").set(as("rep"))).body.filter((v: any) => !v.check_out_at))
      await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Shop closed" });
    await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s, lat: 13, lng: 80 }).expect(409);
    await request(app).post("/api/day/start").set(as("rep")).send({}).expect(400);
    await request(app).post("/api/day/start").set(as("rep")).field("lat", "13.08").field("lng", "80.27").expect(201);
    await request(app).post("/api/day/start").set(as("rep")).send({ lat: 13, lng: 80 }).expect(409);
    const v = (await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s, lat: 13, lng: 80 }).expect(201)).body;
    await request(app).post("/api/day/end").set(as("rep")).send({ lat: 13, lng: 80 }).expect(409); // visit still open
    await request(app).post(`/api/visits/${v.id}/checkout`).set(as("rep")).send({ noOrderReason: "Shop closed" }).expect(200);
    await request(app).post("/api/day/end").set(as("rep")).send({ lat: 13.1, lng: 80.2 }).expect(200);
    const m = (await request(app).get("/api/day").set(as("mgr")).expect(200)).body;
    expect(m.rows[0]).toMatchObject({ rep_name: "Rep", start_lat: 13.08, has_selfie: false });
    expect(m.rows[0].end_at).toBeTruthy();
    await request(app).post("/api/visits/checkin").set(as("rep")).send({ shopId: id.s, lat: 13, lng: 80 }).expect(409);
    await request(app).put("/api/flow-settings").set(as("adm")).send({ dayStart: false }).expect(200);
  });
  it("retailer home shows active schemes, outstanding and announcements", async () => {
    await on({ retailerApp: true });
    await request(app).post("/api/users").set(as("adm")).send({ email: "shop@x.com", name: "Shop", password: "pw", role: "retailer", shopId: id.s }).expect(201);
    T.shop = await login("FL", "shop@x.com");
    await request(app).put("/api/flow-settings").set(as("adm")).send({ announcements: [{ text: "Sample: Diwali offers start Monday" }, { text: "old", until: "2020-01-01" }] }).expect(200);
    const h = (await request(app).get("/api/retailer/home").set(as("shop")).expect(200)).body;
    expect(h.announcements).toEqual([{ text: "Sample: Diwali offers start Monday" }]);
    expect(Array.isArray(h.schemes)).toBe(true); expect(typeof h.outstanding).toBe("number");
    await request(app).get("/api/retailer/home").set(as("rep")).expect(403);
  });
});

describe("11. van sales from a distributor's stock are invoiced by that distributor", () => {
  it("uses the distributor's GSTIN, numbering and ledger; company-stock vans stay company-invoiced", async () => {
    await request(app).post("/api/van/unload").set(as("adm")).send({ repId: id.rep });
    await request(app).post("/api/van/close").set(as("adm")).send({ repId: id.rep });
    // company-stock van → company invoice
    await request(app).post("/api/inventory/moves").set(as("adm")).send({ distributorId: "company", kind: "in", lines: [{ sku, qty: 5, batch: "CV1", expiry: "2099-06-30" }] }).expect(201);
    const inv0 = (await db.query("SELECT issuer FROM invoices i JOIN orders o ON o.id=i.order_id WHERE o.client_ref='p1'")).rows[0];
    expect(inv0.issuer).toBe("company");
    // distributor-stock van
    await request(app).post("/api/inventory/moves").set(as("dist")).send({ kind: "in", lines: [{ sku, qty: 10, batch: "DV1", expiry: "2099-12-31" }] }).expect(201);
    const L = await request(app).post("/api/van/load").set(as("adm")).send({ repId: id.rep, sourceId: id.dist, lines: [{ sku, qty: 4 }] });
    expect(L.status).toBe(201);
    const blocked = await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "dv0", shopId: id.s, lines: [{ sku, qty: 1 }], payment: { mode: "cash" } });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatch(/distributor/);
    await request(app).put(`/api/distributors/${id.dist}/profile`).set(as("dist")).send({ legal_name: "Sample Distributor Pvt Ltd (sample)", gstin: "33BBBBB1111B1ZU", state_code: "33", invoice_prefix: "SDV" }).expect(200);
    const s = (await request(app).post("/api/van/sale").set(as("rep")).send({ clientRef: "dv1", shopId: id.s, lines: [{ sku, qty: 2 }], payment: { mode: "cash" } }).expect(201)).body;
    expect(s.invoice.issuer).toBe(`d${id.dist}`); expect(s.invoice.number).toMatch(/^SDV/);
    expect(JSON.stringify(s.invoice.seller)).toContain("33BBBBB1111B1ZU");
    expect(s.order.distributor_id).toBe(id.dist);
    const pay = (await db.query("SELECT p.issuer FROM payments p JOIN payment_allocations a ON a.payment_id=p.id WHERE a.invoice_id=$1", [s.invoice.id])).rows[0];
    expect(pay.issuer).toBe(`d${id.dist}`);
    // the distributor sees it in its own invoice list; the company list shows it under the distributor
    const mine = (await request(app).get("/api/invoices").set(as("dist")).expect(200)).body;
    expect(mine.some((i: any) => i.id === s.invoice.id)).toBe(true);
  });
});

describe("12. orders placed by retailers are not attributed to a rep in reports", () => {
  it("shows 'Retailer: <shop>' as placed by, in the report builder, the export and the order list", async () => {
    await on({ retailerApp: true, stock: false });
    const shopName = (await request(app).get("/api/shops").set(as("adm"))).body.find((s: any) => s.id === id.s).name;
    T.shop ||= await login("FL", "shop@x.com");
    const v = (await db.query("SELECT sku FROM variants ORDER BY id LIMIT 1")).rows[0].sku;
    const o = (await request(app).post("/api/orders").set(as("shop")).send({ clientRef: "ret-1", lines: [{ sku: v, qty: 1 }] }).expect(201)).body;
    const p = (await request(app).post("/api/report-builder/preview").set(as("adm")).send({ def: { source: "orders", filters: { dateRange: { preset: "this_month" } }, groupBy: ["rep"], metrics: [{ fn: "count" }], view: { type: "table" } } }).expect(200)).body;
    const names = p.rows.map((r: any) => r.rep);
    expect(names).toContain(`Retailer: ${shopName}`); expect(names).not.toContain("Shop");
    const list = (await request(app).get("/api/orders").set(as("adm"))).body.find((x: any) => x.id === o.id);
    expect(list.placed_by).toBe(`Retailer: ${shopName}`);
    const csv = (await request(app).get("/api/reports/orders?format=csv").set(as("adm")).expect(200)).text;
    expect(csv).toContain(`Retailer: ${shopName}`);
  });
});
