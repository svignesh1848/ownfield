// Built-in AI: order suggestions, manager daily summary, at-risk shops, optional LLM wording (mocked; no outside calls).
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate } from "../src/db.js";
import { dailySummary, llmWording, smartSuggest, atRiskShops } from "../src/ai.js";
import { dayKey } from "../src/field.js";
import { txDb } from "./txdb.js";

let app: any, db: any, cid = 0; const T: Record<string, string> = {}; const id: Record<string, number> = {}; let v: { id: number; sku: string }[] = [];
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const ago = (d: number) => new Date(Date.now() - d * 864e5);
let n = 0;
async function order(shop: number, daysAgo: number, lines: [number, number][], rep = id.rep) {
  const total = lines.reduce((a, [, q]) => a + q * 10, 0);
  const o = (await db.query("INSERT INTO orders (company_id,client_ref,rep_id,shop_id,status,total,created_at) VALUES ($1,$2,$3,$4,'fulfilled',$5,$6) RETURNING id", [cid, `t${n++}`, rep, shop, total, ago(daysAgo)])).rows[0];
  for (const [k, q] of lines) await db.query("INSERT INTO order_lines (order_id,variant_id,uom,qty,base_qty,price,amount) VALUES ($1,$2,'PCS',$3,$3,10,$4)", [o.id, v[k].id, q, q * 10]);
}

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`).send({ code: "AI", name: "AI (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } });
  T.adm = await login("AI", "a@x.com");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv([["Name", "Email", "Role", "Password"], ["Rep A", "r@x.com", "sales_rep", "pw"], ["Rep B", "r2@x.com", "sales_rep", "pw"], ["Mgr", "m@x.com", "manager", "pw"]]), "u.csv");
  T.rep = await login("AI", "r@x.com"); T.mgr = await login("AI", "m@x.com");
  await request(app).post("/api/company/sample-data").set(as("adm")).expect(200);
  cid = (await db.query("SELECT id FROM companies WHERE code='AI'")).rows[0].id;
  const users = (await request(app).get("/api/users").set(as("adm"))).body; id.rep = users.find((u: any) => u.email === "r@x.com").id; id.rep2 = users.find((u: any) => u.email === "r2@x.com").id;
  await db.query("INSERT INTO shops (company_id,code,name,city) VALUES ($1,'AIX1','Extra Shop (sample)','Chennai'),($1,'AIX2','Extra Shop 2 (sample)','Chennai')", [cid]);
  const shops = (await db.query("SELECT id FROM shops WHERE company_id=$1 ORDER BY id", [cid])).rows; expect(shops.length).toBeGreaterThanOrEqual(4);
  [id.s, id.s2, id.s3, id.s4] = shops.map((s: any) => s.id);
  await request(app).put("/api/company/settings").set(as("adm")).send({ features: { stock: false } }).expect(200);
  await db.query("UPDATE shops SET outlet_type='Grocery', distributor_id=NULL WHERE company_id=$1", [cid]);
  const it0 = (await db.query("SELECT id FROM items WHERE company_id=$1 AND kind='goods' ORDER BY id LIMIT 1", [cid])).rows[0].id;
  for (const k of ["AIV1", "AIV2", "AIV3", "AIV4", "AIV5"]) await db.query("INSERT INTO variants (company_id,item_id,sku,attrs,mrp,billing_price) VALUES ($1,$2,$3,'{}',12,10)", [cid, it0, k]);
  v = (await db.query("SELECT v.id, v.sku FROM variants v JOIN items i ON i.id=v.item_id WHERE v.company_id=$1 AND i.kind='goods' AND v.sku LIKE 'AIV%' ORDER BY v.id LIMIT 5", [cid])).rows;
  // Shop 1 orders SKU0 (12) every ~10 days, last 12 days ago; SKU1 (5) in most orders.
  for (const d of [52, 42, 32, 22, 12]) await order(id.s, d, [[0, 12], [1, 5]]);
  // Shops 2-4 (similar) all buy SKU2 (6); shop 2 used to order weekly but stopped 40 days ago.
  for (const d of [75, 68, 61, 54, 47, 40]) await order(id.s2, d, [[2, 6]]);
  await order(id.s3, 3, [[2, 6]], id.rep2); await order(id.s4, 2, [[2, 8]], id.rep2);
  await order(id.s3, 1, [[2, 6], [0, 2]], id.rep2);
});
afterEach(() => { delete process.env.AI_PROVIDER; delete process.env.AI_BASE_URL; delete process.env.AI_MODEL; });

describe("smart order suggestions", () => {
  it("suggests due, usual and similar-shop SKUs with a short reason", async () => {
    const r = (await request(app).post("/api/ai/suggest").set(as("rep")).send({ shopId: id.s }).expect(200)).body;
    expect(r.orders).toBe(5);
    const a = r.lines.find((l: any) => l.sku === v[0].sku); expect(a).toMatchObject({ qty: 12, source: "due" }); expect(a.why.text).toMatch(/every 10 days, last 12 days ago/);
    const sim = r.lines.find((l: any) => l.sku === v[2].sku); expect(sim.source).toBe("similar"); expect(sim.why.text).toMatch(/similar shops/);
    expect(sim.why.key).toContain("{0}");
  });
  it("adds must-sell items and caps to available stock when stock is tracked", async () => {
    await request(app).put("/api/flow-settings").set(as("adm")).send({ mustSell: { Grocery: [v[4].sku] } }).expect(200);
    let r = await smartSuggest(db, cid, id.s);
    expect(r.lines.find(l => l.sku === v[4].sku)?.source).toBe("must");
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { stock: true } }).expect(200);
    await db.query("DELETE FROM stock WHERE company_id=$1", [cid]);
    await db.query("INSERT INTO stock (company_id,variant_id,qty) VALUES ($1,$2,5),($1,$3,100)", [cid, v[0].id, v[1].id]);
    r = await smartSuggest(db, cid, id.s);
    expect(r.lines.find(l => l.sku === v[0].sku)).toMatchObject({ qty: 5, stock: 5 });
    expect(r.lines.find(l => l.sku === v[0].sku)?.note?.text).toBe("Only 5 in stock");
    expect(r.lines.find(l => l.sku === v[4].sku)).toBeUndefined(); // out of stock → not suggested
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { stock: false } }).expect(200);
  });
  it("is for reps and managers of the same company only", async () => {
    await request(app).post("/api/ai/suggest").send({ shopId: id.s }).expect(401);
    await request(app).post("/api/ai/suggest").set(as("rep")).send({ shopId: 999999 }).expect(404);
  });
});

describe("at-risk shops and daily summary", () => {
  it("flags a shop whose orders stopped", async () => {
    const r = await atRiskShops(db, cid);
    const s2 = r.find(x => x.shopId === id.s2)!; expect(s2.why.text).toMatch(/No order for 40 days; usually every 7 days/);
    expect(r.find(x => x.shopId === id.s3)).toBeUndefined();
    expect((await request(app).get("/api/ai/at-risk").set(as("mgr")).expect(200)).body.length).toBe(r.length);
  });
  it("manager summary has plain sentences with numbers, reps and at-risk shops", async () => {
    const s = (await request(app).get("/api/ai/summary").set(as("mgr")).expect(200)).body;
    expect(s.provider).toBe("built-in"); expect(s.aiText).toBeNull();
    expect(s.yesterday.orders).toBe(1);
    const text = s.lines.map((l: any) => l.text).join(" ");
    expect(text).toMatch(/Yesterday: 1 orders worth ₹80/);
    expect(text).toMatch(/Top rep this week: Rep B/);
    expect(text).toMatch(/Rep A has no orders this week/);
    expect(text).toMatch(/shops have not ordered as often as usual/);
    await request(app).get("/api/ai/summary").set(as("rep")).expect(403);
  });
  it("flags low stock risk and unusual big orders", async () => {
    await request(app).put("/api/company/settings").set(as("adm")).send({ features: { stock: true } }).expect(200);
    await db.query("DELETE FROM stock WHERE company_id=$1", [cid]);
    await db.query("INSERT INTO stock (company_id,variant_id,qty) VALUES ($1,$2,1)", [cid, v[2].id]);
    for (const d of [30, 20, 10]) await order(id.s4, d + 5, [[3, 1]]);
    await order(id.s4, 0, [[3, 500]]);
    const s = await dailySummary(db, cid, dayKey(new Date()));
    const text = s.lines.map(l => l.text).join(" ");
    expect(text).toMatch(new RegExp(`Low stock risk: .*${v[2].sku} \\(1 left\\)`));
    expect(text).toMatch(/Unusual: .* ordered ₹5,000/);
  });
});

describe("optional LLM wording", () => {
  it("does nothing without AI_PROVIDER and uses an OpenAI-compatible API when set", async () => {
    let calls = 0; const fake: any = async (url: string, init: any) => { calls++; expect(url).toBe("http://llm.local/v1/chat/completions"); expect(JSON.parse(init.body).model).toBe("m1");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Good day overall." } }] }) }; };
    expect(await llmWording(["a"], fake)).toBeNull(); expect(calls).toBe(0);
    Object.assign(process.env, { AI_PROVIDER: "openai-compatible", AI_BASE_URL: "http://llm.local/v1/", AI_MODEL: "m1" });
    expect(await llmWording(["fact one"], fake)).toBe("Good day overall."); expect(calls).toBe(1);
    const fail: any = async () => { throw new Error("down"); };
    expect(await llmWording(["fact two"], fail)).toBeNull();
  });
});
