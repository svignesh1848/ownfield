// Module audit fixes (2 Nov 2026): single outlet add/edit with full fields, beat edit + visiting day,
// offline visit keeps the no-order reason, distributors see only their own outlets.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate, type Db } from "../src/db.js";
import { txDb } from "./txdb.js";

let app: any, db: Db; const T: Record<string, string> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code: "AU", name: "Audit (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T.adm = await login("AU", "a@x.com");
  const csv = Buffer.from("Name,Email,Role,Password\nRep A,r@x.com,sales_rep,pw\nDist A,d@x.com,distributor,pw\nDist B,d2@x.com,distributor,pw\nMgr,m@x.com,manager,pw");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv, "u.csv").expect(200);
  T.rep = await login("AU", "r@x.com"); T.mgr = await login("AU", "m@x.com"); T.d1 = await login("AU", "d@x.com"); T.d2 = await login("AU", "d2@x.com");
});

describe("single outlet add / edit", () => {
  let id = 0;
  it("adds one outlet with all master fields and the same checks as the upload", async () => {
    await request(app).post("/api/shops").set(as("mgr")).send({ code: "S1", name: "Sample Shop", gstin: "33BBBBB1111B1ZX" }).expect(400);
    await request(app).post("/api/shops").set(as("rep")).send({ code: "S1", name: "Sample Shop" }).expect(403);
    const r = await request(app).post("/api/shops").set(as("mgr")).send({ code: "S1", name: "Sample Shop", owner_name: "Owner", phone: "9000000001", email: "s1@example.com",
      gstin: "33BBBBB1111B1ZU", address: "1 Sample St", city: "Chennai", state: "Tamil Nadu", pincode: "600001", latitude: 13.08, longitude: 80.27, channel: "General trade",
      outlet_type: "Kirana", outlet_class: "A", beat: "Sample Beat", distributor_email: "d@x.com", rep_email: "r@x.com", payment_terms: "15 days", active: "Yes" }).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ code: "S1", pan: "BBBBB1111B", state_code: "33", channel: "General trade", outlet_class: "A", outlet_type: "Kirana", payment_terms: "15 days", active: true });
    expect(Number(r.body.lat)).toBe(13.08);
    await request(app).post("/api/shops").set(as("adm")).send({ code: "S1", name: "Again" }).expect(409);
    const beats = (await request(app).get("/api/beats").set(as("adm"))).body;
    expect(beats.find((b: any) => b.name === "Sample Beat").shops.map((s: any) => s.code)).toEqual(["S1"]);
  });
  it("edits the new fields on one outlet, keeps blanks and custom values, rejects bad input", async () => {
    const r = await request(app).patch(`/api/shops/${id}`).set(as("mgr")).send({ name: "Sample Shop Renamed", channel: "Modern trade", outlet_class: "B", phone: "9000000009", active: "No", creditLimit: 5000 }).expect(200);
    expect(r.body).toMatchObject({ name: "Sample Shop Renamed", channel: "Modern trade", outlet_class: "B", phone: "9000000009", active: false, city: "Chennai", gstin: "33BBBBB1111B1ZU" });
    expect(Number(r.body.credit_limit)).toBe(5000);
    await request(app).patch(`/api/shops/${id}`).set(as("mgr")).send({ pincode: "12" }).expect(400);
    await request(app).patch(`/api/shops/${id}`).set(as("mgr")).send({ name: "" }).expect(400);
    await request(app).patch(`/api/shops/${id}`).set(as("rep")).send({ name: "x" }).expect(403);
  });
});

describe("beat edit and visiting day (journey plan)", () => {
  it("sets weekday, edits rep / outlets / order, and validates", async () => {
    const shops = (await request(app).get("/api/shops").set(as("adm"))).body;
    await request(app).post("/api/shops").set(as("adm")).send({ code: "S2", name: "Sample Shop Two" }).expect(201);
    const s2 = (await request(app).get("/api/shops").set(as("adm"))).body.find((x: any) => x.code === "S2");
    const reps = (await request(app).get("/api/reps").set(as("adm"))).body;
    await request(app).post("/api/beats").set(as("mgr")).send({ name: "Bad", weekday: 9 }).expect(400);
    const b = (await request(app).post("/api/beats").set(as("mgr")).send({ name: "Mon route (sample)", weekday: 1, shopIds: [shops[0].id] }).expect(201)).body;
    expect(b.weekday).toBe(1);
    const e = (await request(app).put(`/api/beats/${b.id}`).set(as("mgr")).send({ repId: reps[0].id, weekday: null, shopIds: [s2.id, shops[0].id] }).expect(200)).body;
    expect(e).toMatchObject({ rep_id: reps[0].id, weekday: null, name: "Mon route (sample)" });
    const mine = (await request(app).get("/api/beats").set(as("rep"))).body.find((x: any) => x.id === b.id);
    expect(mine.shops.map((x: any) => x.code)).toEqual(["S2", "S1"]);
    expect(typeof mine.today).toBe("boolean");
    await request(app).put(`/api/beats/${b.id}`).set(as("rep")).send({ name: "x" }).expect(403);
    await request(app).put(`/api/beats/999999`).set(as("mgr")).send({ name: "x" }).expect(404);
  });
});

describe("offline visit", () => {
  it("keeps the no-order reason and check-out location", async () => {
    const shops = (await request(app).get("/api/shops").set(as("rep"))).body;
    const s2 = shops.find((x: any) => x.code === "S2");
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const v = (await request(app).post("/api/visits/offline").set(as("rep")).send({ clientRef: "off-1", shopId: s2.id, checkInAt: at, checkOutAt: new Date().toISOString(),
      lat: 13.1, lng: 80.2, outLat: 13.2, outLng: 80.3, noOrderReason: "Owner not available" }).expect(201)).body;
    expect(v.no_order_reason).toBe("Owner not available");
    expect(Number(v.out_lat)).toBe(13.2);
  });
});

describe("distributor outlet scope", () => {
  it("a distributor sees only outlets mapped to it", async () => {
    expect((await request(app).get("/api/shops").set(as("d1"))).body.map((x: any) => x.code)).toEqual(["S1"]);
    expect((await request(app).get("/api/shops").set(as("d2"))).body).toEqual([]);
  });
});
