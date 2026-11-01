// Retailer master upload: full columns, template with labelled sample rows, row-level errors, update-or-insert by Code.
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import { createApp, ensurePlatformOwner } from "../src/app.js";
import { migrate, type Db } from "../src/db.js";
import { txDb } from "./txdb.js";
import { SHOP_COLUMNS } from "../src/catalog.js";

let app: any, db: Db; const T: Record<string, string> = {};
const login = async (c: string, e: string) => (await request(app).post("/api/auth/login").send({ companyCode: c, email: e, password: "pw" })).body.token;
const as = (t: string) => ({ Authorization: `Bearer ${T[t]}` });
const xlsx = (rows: unknown[][]) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "R"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; };
const up = (rows: unknown[][]) => request(app).post("/api/import/shops").set(as("adm")).attach("file", xlsx(rows), "r.xlsx");

beforeAll(async () => {
  db = txDb(); await migrate(db); await ensurePlatformOwner(db, "o@x.com", "pw"); app = createApp(db, "t");
  const o = await login("PLATFORM", "o@x.com");
  await request(app).post("/api/platform/companies").set("Authorization", `Bearer ${o}`)
    .send({ code: "RM", name: "RM (sample)", industry: "fmcg", userLimit: 10, admin: { email: "a@x.com", name: "Admin", password: "pw" } }).expect(201);
  T.adm = await login("RM", "a@x.com");
  const csv = Buffer.from("Name,Email,Role,Password\nRep A,r@x.com,sales_rep,pw\nDist A,d@x.com,distributor,pw\nMgr,m@x.com,manager,pw");
  await request(app).post("/api/import/users").set(as("adm")).attach("file", csv, "u.csv").expect(200);
  T.rep = await login("RM", "r@x.com"); T.mgr = await login("RM", "m@x.com");
});

describe("retailer master upload", () => {
  it("template has every column and sample rows labelled as sample; uploading it unchanged adds nothing", async () => {
    const r = await request(app).get("/api/import/shops/template").set(as("adm")).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on("data", (c: Buffer) => d.push(c)); res.on("end", () => cb(null, Buffer.concat(d))); }).expect(200);
    const wb = XLSX.read(r.body, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Retailers", "Read me"]);
    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets.Retailers, { header: 1 });
    for (const c of SHOP_COLUMNS) expect(rows[0]).toContain(c);
    for (const h of ["GSTIN", "PAN", "Latitude", "Longitude", "Channel", "Outlet Class", "Beat", "Distributor Email", "Rep Email", "Credit Limit", "Credit Days", "Payment Terms", "Active", "Email", "Contact Person"]) expect(rows[0]).toContain(h);
    expect(rows.slice(1).every((x: any[]) => /^SAMPLE-ROW/.test(x[0]) && /sample/i.test(x[1]))).toBe(true);
    const res = (await request(app).post("/api/import/shops").set(as("adm")).attach("file", r.body, "t.xlsx").expect(200)).body;
    expect(res).toMatchObject({ inserted: 0, updated: 0, skipped: 2 }); expect(res.errors).toEqual([]);
    await request(app).get("/api/import/shops/template?format=csv").set(as("adm")).expect(200).expect("content-type", /csv/);
    await request(app).get("/api/import/shops/template").set(as("rep")).expect(403);
  });
  it("inserts with all details, reports bad rows by row number, and updates by code", async () => {
    const H = ["Code", "Name", "Owner Name", "Contact Person", "Phone", "Email", "GSTIN", "PAN", "Address", "City", "State", "PIN Code", "Latitude", "Longitude", "Channel", "Outlet Type", "Outlet Class", "Beat", "Distributor Email", "Rep Email", "Credit Limit", "Credit Days", "Payment Terms", "Active"];
    const res = (await up([H,
      ["R1", "Sample Retailer One", "Owner One", "", "90000 00011", "one@example.com", "33BBBBB1111B1ZU", "BBBBB1111B", "1 Sample St", "Chennai", "Tamil Nadu", "600001", 13.08, 80.27, "General trade", "Kirana", "A", "Sample Beat Mon", "d@x.com", "r@x.com", 25000, 15, "15 days", "Yes"],
      ["R2", "Sample Retailer Two", "", "Contact Two", "9000000012", "", "", "", "", "Bengaluru", "29", "560001", "", "", "Pharmacy", "", "B", "Sample Beat Mon", "", "", "", "", "Cash", "No"],
      ["R3", "Bad GSTIN", "", "", "", "", "33BBBBB1111B1ZX", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["R4", "Bad PAN", "", "", "", "", "33BBBBB1111B1ZU", "CCCCC2222C", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["R5", "Bad email", "", "", "", "nope", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["R6", "Unknown rep", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "x@x.com", "", "", "", ""],
      ["R7", "Bad lat", "", "", "", "", "", "", "", "", "", "", 123, 80, "", "", "", "", "", "", "", "", "", ""],
      ["", "No code", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
      ["R9", "Bad active", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "maybe"],
    ]).expect(200)).body;
    expect(res.inserted).toBe(2);
    expect(res.errors.map((e: any) => e.row)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(res.errors[0]).toMatchObject({ code: "R3" }); expect(res.errors[1].error).toMatch(/PAN/); expect(res.errors[2].error).toMatch(/email/);
    expect(res.errors[3].error).toMatch(/rep/); expect(res.errors[4].error).toMatch(/Latitude/); expect(res.errors[5].error).toMatch(/Code/); expect(res.errors[6].error).toMatch(/Active/);
    const s1 = (await db.query("SELECT s.*, u.email AS dist_email, r.email AS rep_email FROM shops s LEFT JOIN users u ON u.id=s.distributor_id LEFT JOIN users r ON r.id=s.rep_id WHERE s.code='R1'")).rows[0];
    expect(s1).toMatchObject({ owner_name: "Owner One", phone: "9000000011", email: "one@example.com", gstin: "33BBBBB1111B1ZU", pan: "BBBBB1111B", state_code: "33", pincode: "600001",
      channel: "General trade", outlet_type: "Kirana", outlet_class: "A", payment_terms: "15 days", dist_email: "d@x.com", rep_email: "r@x.com", active: true });
    expect([Number(s1.lat), Number(s1.lng), Number(s1.credit_limit), Number(s1.credit_days)]).toEqual([13.08, 80.27, 25000, 15]);
    const s2 = (await db.query("SELECT * FROM shops WHERE code='R2'")).rows[0];
    expect(s2).toMatchObject({ owner_name: "Contact Two", state_code: "29", active: false });
    const beat = (await db.query("SELECT b.id, b.rep_id, COUNT(bs.shop_id) AS n FROM beats b JOIN beat_shops bs ON bs.beat_id=b.id WHERE b.name='Sample Beat Mon' GROUP BY b.id, b.rep_id")).rows[0];
    expect(Number(beat.n)).toBe(2);
    // inactive retailers are hidden from reps and cannot take orders
    expect((await request(app).get("/api/shops").set(as("rep"))).body.map((s: any) => s.code)).not.toContain("R2");
    // update by code: changed fields replace, blank optional cells keep the old value
    const u = (await up([["Code", "Name", "Phone", "Credit Limit", "Active", "Email"], ["R1", "Sample Retailer One (renamed)", "9000000099", 30000, "No", ""]]).expect(200)).body;
    expect(u).toMatchObject({ inserted: 0, updated: 1 });
    const s1b = (await db.query("SELECT * FROM shops WHERE code='R1'")).rows[0];
    expect(s1b).toMatchObject({ name: "Sample Retailer One (renamed)", phone: "9000000099", email: "one@example.com", owner_name: "Owner One", gstin: "33BBBBB1111B1ZU", city: "Chennai", active: false }); expect(Number(s1b.credit_limit)).toBe(30000);
    expect(Number((await db.query("SELECT COUNT(*) AS n FROM shops WHERE code='R1'")).rows[0].n)).toBe(1);
  });
});
