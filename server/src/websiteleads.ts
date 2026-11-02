// Website lead form (www.ownfield.in "Start free" / "Book a demo"): stores a request for the platform owner to follow up.
// Public, validated, rate-limited per IP. Sends nothing (no email/SMS/WhatsApp). Platform owner reads them at GET /api/platform/leads.
import express, { Express, Request, Response, NextFunction } from "express";
import type { Db } from "./db.js";
import { HitCounter } from "./security.js";

const SITE_ORIGINS = ["https://www.ownfield.in", "https://ownfield.in", ...(process.env.WEBSITE_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)];
export const LEAD_SIZES = ["1-10", "11-50", "51-200", "200+"] as const;
export const LEAD_INDUSTRIES = ["FMCG and food", "Apparel and footwear", "Pharma and OTC", "Electricals and electronics", "Building materials", "Other"] as const;

export function registerWebsiteLeadRoutes(app: Express, db: Db, auth: (...roles: any[]) => any) {
  const hits = new HitCounter(Number(process.env.WEBSITE_LEAD_RATE_MAX || 5), 60 * 60_000);
  const allowOrigin = (req: Request, res: Response) => { const o = req.headers.origin; if (o && SITE_ORIGINS.includes(o)) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); } };
  // Sent as text/plain JSON from the website so the browser needs no preflight.
  app.post("/api/public/website-leads", express.text({ type: "text/plain", limit: "8kb" }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      allowOrigin(req, res);
      let b: any = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { return res.status(400).json({ error: "Invalid request" }); } }
      b = b && typeof b === "object" ? b : {};
      if (hits.hit(req.ip || "?") > hits.max) return res.status(429).json({ error: "Too many requests from this network. Please try again in an hour, or email hello@ownfield.in." });
      if (b.website) return res.status(400).json({ error: "Invalid request" }); // honeypot
      const s = (k: string, max: number) => String(b[k] ?? "").trim().slice(0, max + 1);
      const f = { kind: s("kind", 20), name: s("name", 80), company: s("company", 120), email: s("email", 120).toLowerCase(), phone: s("phone", 20), size: s("size", 10), industry: s("industry", 40), message: s("message", 2000) };
      if (!["trial", "demo"].includes(f.kind)) return res.status(400).json({ field: "kind", error: "Choose Start free trial or Book a demo" });
      if (f.name.length < 2 || f.name.length > 80) return res.status(400).json({ field: "name", error: "Enter your name" });
      if (f.company.length < 2 || f.company.length > 120) return res.status(400).json({ field: "company", error: "Enter your company name" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email) || f.email.length > 120) return res.status(400).json({ field: "email", error: "Enter a valid work email" });
      if (!/^[+\d][\d\s-]{6,18}$/.test(f.phone)) return res.status(400).json({ field: "phone", error: "Enter a valid phone number" });
      if (!(LEAD_SIZES as readonly string[]).includes(f.size)) return res.status(400).json({ field: "size", error: "Pick a team size" });
      if (!(LEAD_INDUSTRIES as readonly string[]).includes(f.industry)) return res.status(400).json({ field: "industry", error: "Pick an industry" });
      if (f.message.length > 2000) return res.status(400).json({ field: "message", error: "Message is too long" });
      await db.query("INSERT INTO website_leads (kind,name,company,email,phone,team_size,industry,message,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [f.kind, f.name, f.company, f.email, f.phone, f.size, f.industry, f.message || null, req.ip || null]);
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get("/api/platform/leads", auth("platform_owner"), async (_q: Request, res: Response, next: NextFunction) => {
    try { res.json((await db.query("SELECT id,created_at,kind,name,company,email,phone,team_size,industry,message FROM website_leads ORDER BY id DESC LIMIT 500")).rows); } catch (e) { next(e); }
  });
}
