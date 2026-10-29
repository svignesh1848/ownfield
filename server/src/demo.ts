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
  for (const k of ["shops", "products", "users"]) {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(path.resolve(process.cwd(), `../sample-data/sample-${k}.csv`))]), `${k}.csv`);
    await fetch(`${base}/api/import/${k}`, { method: "POST", headers: { Authorization: `Bearer ${admin}` }, body: fd });
  }
  console.log(`Demo on ${base} — owner: PLATFORM/owner@example.com/demo, admin: DEMO/admin@example.com/demo`);
});
