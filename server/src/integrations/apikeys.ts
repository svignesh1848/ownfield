// Per-company API keys for the public /api/v1 API. Only a SHA-256 hash is stored; the full key is shown once at creation.
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db.js";
import { HitCounter } from "../security.js";

export const RESOURCES = ["products", "stock", "customers", "distributors", "orders", "invoices", "collections", "users"] as const;
export const READ_ONLY = new Set(["invoices", "collections", "users"]);
export const ALL_SCOPES = RESOURCES.flatMap(r => READ_ONLY.has(r) ? [`${r}:read`] : [`${r}:read`, `${r}:write`]);
export type ApiCtx = { keyId: number; companyId: number; scopes: string[]; name: string };
export type ApiReq = Request & { api: ApiCtx };

export const hashKey = (k: string) => crypto.createHash("sha256").update(k).digest("hex");
export function newKey() {
  const prefix = crypto.randomBytes(4).toString("hex");
  return { prefix, key: `ffk_${prefix}_${crypto.randomBytes(24).toString("base64url")}` };
}
export function cleanScopes(s: unknown): string[] | null {
  const list = Array.isArray(s) ? s.map(String) : [];
  if (!list.length || list.some(x => !ALL_SCOPES.includes(x))) return null;
  return [...new Set(list)];
}

/** Express middleware: authenticates an API key and applies a per-key rate limit (API_RATE_MAX per minute, default 120). */
export function apiKeyAuth(db: Db) {
  const hits = new HitCounter(Number(process.env.API_RATE_MAX || 120), 60_000);
  const touched = new Map<number, number>();
  return (req: Request, res: Response, next: NextFunction) => {
    const h = String(req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    const m = /^ffk_([0-9a-f]{8})_[A-Za-z0-9_-]{20,}$/.exec(h);
    if (!m) return res.status(401).json({ error: "missing or malformed API key" });
    db.query("SELECT k.*, c.code FROM api_keys k JOIN companies c ON c.id=k.company_id WHERE k.prefix=$1", [m[1]]).then(r => {
      const k = r.rows[0];
      const ok = k && !k.revoked_at && crypto.timingSafeEqual(Buffer.from(k.key_hash), Buffer.from(hashKey(h)));
      if (!ok) return res.status(401).json({ error: "invalid or revoked API key" });
      const n = hits.hit(`k${k.id}`);
      res.setHeader("X-RateLimit-Limit", String(hits.max)); res.setHeader("X-RateLimit-Remaining", String(Math.max(0, hits.max - n)));
      if (n > hits.max) { res.setHeader("Retry-After", "60"); return res.status(429).json({ error: "rate limit exceeded, retry in a minute" }); }
      const now = Date.now();
      if (now - (touched.get(k.id) || 0) > 60_000) { touched.set(k.id, now); db.query("UPDATE api_keys SET last_used_at=NOW() WHERE id=$1", [k.id]).catch(() => {}); }
      (req as ApiReq).api = { keyId: k.id, companyId: k.company_id, scopes: JSON.parse(k.scopes), name: k.name };
      next();
    }).catch(next);
  };
}
export const need = (scope: string) => (req: Request, res: Response, next: NextFunction) =>
  (req as ApiReq).api.scopes.includes(scope) ? next() : res.status(403).json({ error: `this key lacks scope ${scope}` });
