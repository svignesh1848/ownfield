import type { Express, NextFunction, Request, Response } from "express";
import helmet from "helmet";
import type { Db } from "./db.js";

/** Security headers. CSP allows only same-origin scripts/workers (PWA + service worker) plus data:/blob: images. */
export function securityHeaders(app: Express) {
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"], "font-src": ["'self'", "data:"], "connect-src": ["'self'"],
        "worker-src": ["'self'"], "manifest-src": ["'self'"], "object-src": ["'none'"], "base-uri": ["'self'"],
        "form-action": ["'self'"], "frame-ancestors": ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: "deny" },
    crossOriginEmbedderPolicy: false,
  }));
}

/** Tight CORS: same-origin only by default; extra origins via CORS_ORIGINS (comma separated). */
export function tightCors(app: Express, allowed = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)) {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS" && origin) return res.sendStatus(origin && allowed.includes(origin) ? 204 : 403);
    next();
  });
}

/** Small in-memory sliding-window counter keyed by string; pruned so it stays small. */
export class HitCounter {
  private m = new Map<string, number[]>();
  constructor(public max: number, public windowMs: number) {}
  private live(k: string, now = Date.now()) { const h = (this.m.get(k) || []).filter(t => now - t < this.windowMs); if (h.length) this.m.set(k, h); else this.m.delete(k); return h; }
  count(k: string) { return this.live(k).length; }
  hit(k: string) { const h = this.live(k); h.push(Date.now()); this.m.set(k, h); if (this.m.size > 10000) this.prune(); return h.length; }
  blocked(k: string) { return this.live(k).length >= this.max; }
  reset(k: string) { this.m.delete(k); }
  prune() { for (const k of [...this.m.keys()]) this.live(k); }
}

/** Login protection: per-IP request cap, and per-account lockout after repeated failures. */
export function loginGuard() {
  const ipHits = new HitCounter(Number(process.env.LOGIN_IP_MAX || 30), 15 * 60_000);
  const fails = new HitCounter(Number(process.env.LOGIN_FAIL_MAX || 5), Number(process.env.LOGIN_LOCK_MS || 15 * 60_000));
  return {
    ipLimiter(req: Request, res: Response, next: NextFunction) {
      if (ipHits.hit(req.ip || "?") > ipHits.max) return res.status(429).json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
      next();
    },
    locked: (acct: string) => fails.blocked(acct),
    failed: (acct: string) => fails.hit(acct),
    succeeded: (acct: string) => fails.reset(acct),
  };
}

export async function audit(db: Db, e: { companyId?: number | null; userId?: number | null; action: string; target?: string; detail?: unknown; ip?: string }) {
  try {
    await db.query("INSERT INTO security_audit_log (company_id,user_id,action,target,detail,ip) VALUES ($1,$2,$3,$4,$5,$6)",
      [e.companyId ?? null, e.userId ?? null, e.action, e.target ?? null, e.detail == null ? null : JSON.stringify(e.detail), e.ip ?? null]);
  } catch (err: any) { console.error("audit log write failed:", err.message); }
}

/** Final error handler: users see a generic message; details stay in server logs. Deliberate 4xx messages pass through. */
export function errorHandler(err: any, req: Request, res: Response, _n: NextFunction) {
  const dup = err.code === "23505" || /duplicate key|unique constraint/i.test(err.message || "");
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "photo is too large — please take a smaller photo" });
  if (dup) return res.status(409).json({ error: "already exists" });
  // A missing or non-numeric id (e.g. no outlet picked) reaches SQL as NaN: that is a bad request, not a server fault.
  if (err.code === "22P02" || /invalid input syntax for (type )?(integer|bigint|numeric)/i.test(err.message || "")) return res.status(400).json({ error: "Invalid request — a required item (outlet, order or product) is missing or wrong" });
  const status = Number(err.status || err.statusCode) || 500;
  if (status < 500 && err.expose !== false && err.status) return res.status(status).json({ error: err.type === "entity.parse.failed" ? "Invalid request" : err.message });
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err);
  res.status(status >= 500 && status < 600 ? status : 500).json({ error: "Something went wrong. Please try again." });
}
