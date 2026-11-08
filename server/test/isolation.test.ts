// Company data isolation: users of company A must never read or change company B's data by guessing ids.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import fs from "node:fs"; import path from "node:path";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any; const T: Record<string, string> = {}; const B: Record<string, number> = {};
const H = (k: string) => ({ Authorization: `Bearer ${T[k]}` });
const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(",")).join("\n"));
const MARK = "ZZBSECRET"; // appears in company B's names only
const login = async (code: string, e: string) => (await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.9." + code.length + ".1").send({ companyCode: code, email: e, password: "goodpass1" }).expect(200)).body.token;

async function setup(code: string, tag: string, k: string) {
  T[k + "a"] = (await request(app).post("/api/signup").send({ companyName: `${tag} Co`, companyCode: code, industry: "fmcg", adminName: `${tag} Admin`, email: `a@${code}.com`, password: "goodpass1", consent: true }).expect(201)).body.token;
  await request(app).put("/api/company/settings").set(H(k + "a")).send({ features: { distInventory: true, distributorBilling: true, claims: true } }).expect(200);
  await request(app).post("/api/import/products").set(H(k + "a")).attach("file", csv([["Style", "SKU", "Size", "MRP", "Billing Price", "HSN"], [`${tag}TEE`, `${tag}-2Y`, "2Y", "400", "300", "6109"]]), "p.csv").expect(200);
  await request(app).post("/api/import/users").set(H(k + "a")).attach("file", csv([["Name", "Email", "Role", "Password"], [`${tag} Rep`, `r@${code}.com`, "sales_rep", "goodpass1"], [`${tag} Dist`, `d@${code}.com`, "distributor", "goodpass1"], [`${tag} Mgr`, `m@${code}.com`, "manager", "goodpass1"]]), "u.csv").expect(200);
  for (const r of ["r", "d", "m"]) T[k + r] = await login(code, `${r}@${code}.com`);
  await request(app).post("/api/import/shops").set(H(k + "a")).attach("file", csv([["Code", "Name", "Distributor Email"], [`${tag}S1`, `${tag} Shop`, `d@${code}.com`]]), "s.csv").expect(200);
  await request(app).post("/api/import/stock").set(H(k + "d")).attach("file", csv([["SKU", "Qty"], [`${tag}-2Y`, "100"]]), "st.csv").expect(200);
}

beforeAll(async () => {
  const db = txDb(); await migrate(db); app = createApp(db, "t");
  await setup("ISOA", "Alpha", "A");
  await setup("ISOB", MARK, "B");
  B.shop = (await request(app).get("/api/shops").set(H("Ba"))).body[0].id;
  B.dist = (await request(app).get("/api/distributors").set(H("Ba"))).body[0].id;
  B.variant = (await request(app).get("/api/products").set(H("Ba"))).body[0].id;
  B.item = (await request(app).get("/api/items").set(H("Ba"))).body[0].id;
  const users = (await request(app).get("/api/users").set(H("Ba"))).body;
  B.rep = users.find((u: any) => u.email === "r@ISOB.com".toLowerCase()).id;
  B.order = (await request(app).post("/api/orders").set(H("Br")).send({ clientRef: "b1", shopId: B.shop, lines: [{ variantId: B.variant, qty: 2 }] }).expect(201)).body.id;
  B.payment = (await request(app).post("/api/payments").set(H("Br")).send({ shopId: B.shop, amount: 10, mode: "cash", clientRef: "bp1" }).expect(201)).body.id;
});

const leaks = (r: any) => r.status < 300 && JSON.stringify(r.body ?? r.text ?? "").includes(MARK);

describe("company data isolation", () => {
  it("lists never include the other company's orders, shops, users, stock or distributors", async () => {
    for (const k of ["Aa", "Am", "Ar", "Ad"]) for (const u of ["/api/orders", "/api/shops", "/api/users", "/api/stock", "/api/distributors", "/api/products", "/api/payments", "/api/invoices"]) {
      const r = await request(app).get(u).set(H(k));
      expect(leaks(r), `${k} GET ${u}`).toBe(false);
    }
  });

  it("company A cannot read company B's records by id", async () => {
    for (const k of ["Aa", "Ad"]) for (const u of [`/api/distributors/${B.dist}/profile`, `/api/payments/${B.payment}`, `/api/payments/${B.payment}/print`, `/api/outlets/${B.shop}/photo`,
      `/api/credit-check?shopId=${B.shop}&amount=1`]) {
      const r = await request(app).get(u).set(H(k));
      expect(leaks(r), `${k} GET ${u}`).toBe(false);
    }
  });

  it("company A cannot change company B's orders, shops, users, stock or distributors", async () => {
    const tries: [string, string, any][] = [
      ["put", `/api/orders/${B.order}`, { lines: [{ variantId: B.variant, qty: 99 }] }],
      ["post", `/api/orders/${B.order}/approve`, {}], ["post", `/api/orders/${B.order}/cancel`, { reason: "x" }],
      ["post", `/api/orders/${B.order}/status`, { status: "dispatched" }], ["post", `/api/orders/${B.order}/invoice`, {}],
      ["patch", `/api/shops/${B.shop}`, { name: "hacked" }], ["post", `/api/shops/${B.shop}/distributor`, { distributorId: B.dist }],
      ["put", `/api/shops/${B.shop}/geofence`, { lat: 1, lng: 1, radius: 50 }], ["put", `/api/shops/${B.shop}/type`, { type: "x" }],
      ["post", `/api/outlets/${B.shop}/decision`, { approve: false }],
      ["patch", `/api/users/${B.rep}`, { name: "hacked", active: false }], ["delete", `/api/users/${B.rep}`, {}],
      ["post", `/api/users/${B.rep}/reset-code`, {}], ["put", `/api/users/${B.rep}/hierarchy`, { reportsTo: null }],
      ["put", `/api/distributors/${B.dist}/profile`, { legal_name: "hacked" }],
      ["put", `/api/products/item/${B.item}`, { name: "hacked" }],
      ["post", `/api/payments/${B.payment}/bounce`, {}],
    ];
    for (const k of ["Aa", "Am", "Ad"]) for (const [m, u, body] of tries) {
      const r = await (request(app) as any)[m](u).set(H(k)).send(body);
      expect(r.status, `${k} ${m.toUpperCase()} ${u} -> ${r.status}`).toBeGreaterThanOrEqual(400);
    }
    // B's data is unchanged
    const o = (await request(app).get("/api/orders").set(H("Ba"))).body.find((x: any) => x.id === B.order);
    expect(o.status).toBe("placed");
    expect((await request(app).get("/api/shops").set(H("Ba"))).body[0].name).toContain(MARK);
    expect((await request(app).get("/api/users").set(H("Ba"))).body.find((u: any) => u.id === B.rep).name).toContain(MARK);
  });

  it("company A's rep cannot order against B's shop or products", async () => {
    const r = await request(app).post("/api/orders").set(H("Ar")).send({ clientRef: "x1", shopId: B.shop, lines: [{ variantId: B.variant, qty: 1 }] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const s = await request(app).post("/api/import/stock").set(H("Ad")).attach("file", csv([["SKU", "Qty"], [`${MARK}-2Y`, "5"]]), "st.csv");
    expect(JSON.stringify(s.body)).not.toMatch(/"(imported|updated)":\s*[1-9]/);
  });

  it("every :id route rejects or hides another company's ids", async () => {
    // Sweep all id routes found in the source with B's ids; nothing may come back containing B's data.
    const dir = path.join(__dirname, "../src"); const routes = new Set<string>();
    const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) for (const m of fs.readFileSync(p, "utf8").matchAll(/app\.(get|put|patch|post|delete)\("(\/api\/[^"]*:id[^"]*)"/g)) routes.add(m[1] + " " + m[2]); } };
    walk(dir);
    const ids = [...new Set(Object.values(B))];
    const bad: string[] = [];
    for (const rt of routes) { const [m, p] = rt.split(" "); if (p.startsWith("/api/platform")) continue;
      for (const id of ids) { const u = p.replace(":id", String(id)).replace(":did", String(id));
        const r = await (request(app) as any)[m](u).set(H("Aa")).send({});
        if (leaks(r)) bad.push(`${m} ${u}`);
      } }
    expect(bad).toEqual([]);
    expect(leaks(await request(app).get("/api/shops").set(H("Ba")))).toBe(true); // control: the check does see B's own data
  });
});

describe("reset-code brute force", () => {
  it("blocks repeated reset attempts", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post("/api/auth/reset").set("X-Forwarded-For", "10.7.7.7").send({ companyCode: "ISOA", email: "r@isoa.com", code: "BAD" + i, password: "newpass123" })).status;
    expect(last).toBe(429);
  });
});
