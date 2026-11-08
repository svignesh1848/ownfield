// App-level encryption for sensitive columns (TOTP secrets, webhook signing secrets).
// AES-256-GCM with a key from DATA_ENCRYPTION_KEY (any long random string; hashed to 32 bytes).
// Without the key, values are stored as before (plain), and old plain values keep working after the key is set.
import crypto from "node:crypto";

const PREFIX = "enc1:";
const key = () => { const k = process.env.DATA_ENCRYPTION_KEY; return k ? crypto.createHash("sha256").update(k).digest() : null; };

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
