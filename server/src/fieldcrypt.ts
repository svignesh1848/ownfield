// App-level encryption for sensitive columns (TOTP secrets, webhook signing secrets, connector passwords).
// AES-256-GCM with a key from DATA_ENCRYPTION_KEY (any long random string; hashed to 32 bytes).
// Without the key, values are stored as before (plain), and old plain values keep working after the key is set.
import crypto from "node:crypto";

const PREFIX = "enc1:";
const key = () => { const k = process.env.DATA_ENCRYPTION_KEY; return k ? crypto.createHash("sha256").update(k).digest() : null; };
let warnedNoKey = false;
export function warnIfNoEncryptionKey() {
  if (!key() && !warnedNoKey) {
    warnedNoKey = true;
    console.warn("DATA_ENCRYPTION_KEY is not set: connector passwords are stored as plain text. Set the key to encrypt them at rest.");
  }
}

export function sealField(v: string | null | undefined): string | null {
  if (v == null) return null; const k = key(); if (!k) return v;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(String(v), "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function openField(v: string | null | undefined): string | null {
  if (v == null || !String(v).startsWith(PREFIX)) return v ?? null;
  const k = key(); if (!k) throw new Error("DATA_ENCRYPTION_KEY is not set but encrypted data exists");
  const b = Buffer.from(String(v).slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

/** Known connector config keys that hold secrets (plus any plugin field with kind "secret"). */
export const CONNECTOR_SECRET_KEYS = ["password", "apiKey", "token", "clientSecret", "inboundSecret", "secret"];
export function connectorSecretKeys(fields?: { key: string; kind: string }[]): string[] {
  return [...new Set([...(fields || []).filter(f => f.kind === "secret").map(f => f.key), ...CONNECTOR_SECRET_KEYS])];
}

/** Decrypt any enc1: string values in a connector config object. Legacy plaintext is returned as-is. */
export function openConfig(cfg: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...cfg };
  for (const [k, v] of Object.entries(out)) if (typeof v === "string" && v.startsWith(PREFIX)) out[k] = openField(v);
  return out;
}

/** Encrypt secret fields when the key is set. Already-encrypted or empty values are left alone. */
export function sealConfig(cfg: Record<string, any>, secretKeys: string[] = CONNECTOR_SECRET_KEYS): Record<string, any> {
  warnIfNoEncryptionKey();
  const out: Record<string, any> = { ...cfg };
  if (!key()) return out;
  for (const k of secretKeys) {
    if (typeof out[k] === "string" && out[k] && !String(out[k]).startsWith(PREFIX)) out[k] = sealField(out[k]);
  }
  return out;
}

/** One-time / catch-up: encrypt plaintext connector secrets already in the database. No-op without a key. */
export async function encryptConnectorSecrets(db: { query: (sql: string, args?: any[]) => Promise<{ rows: any[] }> }) {
  if (!key()) { warnIfNoEncryptionKey(); return { updated: 0 }; }
  const rows = (await db.query("SELECT id, config FROM connectors")).rows;
  let updated = 0;
  for (const row of rows) {
    let cfg: Record<string, any> = {};
    try { cfg = typeof row.config === "string" ? JSON.parse(row.config || "{}") : (row.config || {}); } catch { continue; }
    const sealed = sealConfig(cfg);
    if (JSON.stringify(sealed) !== JSON.stringify(cfg)) {
      await db.query("UPDATE connectors SET config=$1 WHERE id=$2", [JSON.stringify(sealed), row.id]);
      updated++;
    }
  }
  return { updated };
}
