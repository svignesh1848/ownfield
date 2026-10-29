// Test helper: pg-mem's pool adapter does not roll back, so emulate BEGIN/COMMIT/ROLLBACK with pg-mem snapshots.
// Tests run requests sequentially, so a snapshot per transaction is equivalent. Production uses real Postgres transactions.
import { newDb } from "pg-mem";
import type { Db } from "../src/db.js";
export function txDb(): Db {
  const mem = newDb(); const { Pool } = mem.adapters.createPg(); const pool = new Pool();
  return {
    query: (t, p) => pool.query(t, p),
    connect: async () => {
      let snap: ReturnType<typeof mem.backup> | null = null;
      return {
        query: async (t: string, p?: unknown[]) => {
          const k = t.trim().toUpperCase();
          if (k === "BEGIN") { snap = mem.backup(); return { rows: [] }; }
          if (k === "COMMIT") { snap = null; return { rows: [] }; }
          if (k === "ROLLBACK") { snap?.restore(); snap = null; return { rows: [] }; }
          return pool.query(t, p);
        },
        release: () => {},
      };
    },
  };
}
