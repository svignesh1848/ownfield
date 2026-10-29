// In-memory demo (no Postgres needed): `npm run demo -w server`. Uses SAMPLE data only.
import { newDb } from "pg-mem";
import fs from "node:fs";
import path from "node:path";
import { createApp, ensurePlatformOwner } from "./app.js";
import { migrate } from "./db.js";
const { Pool } = newDb().adapters.createPg();
const db = new Pool();
await migrate(db);
await ensurePlatformOwner(db, "owner@example.com", "demo");
const app = createApp(db);
const port = Number(process.env.PORT || 8080);
app.listen(port, async () => {
  const base = `http://localhost:${port}`;
  const post = (u: string, t: string | null, body: any) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) }).then(r => r.json());
  const owner = (await post("/api/auth/login", null, { companyCode: "PLATFORM", email: "owner@example.com", password: "demo" })).token;
  await post("/api/platform/companies", owner, { code: "DEMO", name: "Demo Kidswear Co (sample)", userLimit: 5, admin: { email: "admin@example.com", name: "Demo Admin", password: "demo" } });
  const admin = (await post("/api/auth/login", null, { companyCode: "DEMO", email: "admin@example.com", password: "demo" })).token;
  for (const k of ["users", "shops", "products"]) {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(path.resolve(process.cwd(), `../sample-data/sample-${k}.csv`))]), `${k}.csv`);
    await fetch(`${base}/api/import/${k}`, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: fd });
  }
  const get = (u: string, t: string) => fetch(base + u, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json());
  const shops = await get("/api/shops", admin); const reps = await get("/api/reps", admin);
  await post("/api/beats", admin, { name: "Monday – Chennai (sample)", repId: reps[0].id, shopIds: shops.map((x: any) => x.id) });
  const rep = (await post("/api/auth/login", null, { companyCode: "DEMO", email: "rep@example.com", password: "changeme123" })).token;
  const v = await post("/api/visits/checkin", rep, { shopId: shops[0].id, lat: 13.0827, lng: 80.2707 });
  await post(`/api/visits/${v.id}/checkout`, rep, { lat: 13.0828, lng: 80.2708 });
  const o = await post("/api/orders", rep, { clientRef: "demo-1", shopId: shops.find((x: any) => x.distributor_id).id, lines: [{ sku: "SR01-0-3M", qty: 6 }, { sku: "ST02-2Y", qty: 4 }] });
  await post("/api/orders", rep, { clientRef: "demo-2", shopId: shops.find((x: any) => x.distributor_id).id, lines: [{ sku: "ST02-4Y", qty: 10 }] });
  void o;
  console.log(`Demo on ${base} — owner: PLATFORM/owner@example.com/demo, admin: DEMO/admin@example.com/demo`);
});
