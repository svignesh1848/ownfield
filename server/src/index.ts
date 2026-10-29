import { createApp, ensurePlatformOwner } from "./app.js";
import { createPool, migrate } from "./db.js";
import { seedDemo } from "./seed.js";
import { scheduleBackups } from "./backup.js";
import { startWebhookWorker } from "./integrations/webhooks.js";
import { startConnectorScheduler } from "./connectors/service.js";
const db = createPool();
await migrate(db);
await ensurePlatformOwner(db, process.env.OWNER_EMAIL || "owner@example.com", process.env.OWNER_PASSWORD || "change-me-now");
await seedDemo(db).catch(e => console.error("demo seed skipped:", e.message));
const port = Number(process.env.PORT || 8080);
createApp(db).listen(port, process.env.HOST || "127.0.0.1", () => console.log(`FieldForce OSS listening on ${process.env.HOST || "127.0.0.1"}:${port}`));
if (process.env.NODE_ENV === "production") scheduleBackups();
if (process.env.WEBHOOKS_DISABLED !== "1") { startWebhookWorker(db); startConnectorScheduler(db); }
