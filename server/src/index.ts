import { createApp, ensurePlatformOwner } from "./app.js";
import { createPool, migrate } from "./db.js";
import { seedDemo } from "./seed.js";
const db = createPool();
await migrate(db);
await ensurePlatformOwner(db, process.env.OWNER_EMAIL || "owner@example.com", process.env.OWNER_PASSWORD || "change-me-now");
await seedDemo(db).catch(e => console.error("demo seed skipped:", e.message));
const port = Number(process.env.PORT || 8080);
createApp(db).listen(port, () => console.log(`FieldForce OSS listening on :${port}`));
