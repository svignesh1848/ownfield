// Loads every plugin file in ./plugins. Adding a connector = dropping one file there (see README.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConnectorPlugin } from "./types.js";

let cache: Map<string, ConnectorPlugin> | null = null;
export async function plugins(): Promise<Map<string, ConnectorPlugin>> {
  if (cache) return cache;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugins");
  const m = new Map<string, ConnectorPlugin>();
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.(js|ts)$/.test(f) || /\.d\.ts$|\.test\./.test(f)) continue;
    try {
      const p: ConnectorPlugin = (await import(pathToFileURL(path.join(dir, f)).href)).default;
      if (!p || !/^[a-z0-9-]{2,40}$/.test(p.type) || !p.label) { console.error(`connector plugin ${f} skipped: no valid default export`); continue; }
      m.set(p.type, p);
    } catch (e: any) { console.error(`connector plugin ${f} failed to load:`, e.message); }
  }
  return (cache = m);
}
export async function plugin(type: string) {
  const p = (await plugins()).get(type); if (!p) throw Object.assign(new Error(`unknown connector type ${type}`), { status: 400 });
  return p;
}
