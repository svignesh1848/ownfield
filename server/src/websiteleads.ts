// Website lead form (www.ownfield.in "Start free pilot"): stores a request for the platform owner to follow up.
// Public, validated, rate-limited per IP. Always stored in the database and written as an in-app notification
// for the platform owner. Email is sent only when both LEAD_NOTIFY_EMAIL and SMTP (see mail.ts) are configured
// on the server — neither address is hardcoded here.
import express, { Express, Request, Response, NextFunction } from "express";
import type { Db } from "./db.js";
import rateLimit from "express-rate-limit";
import { notify } from "./field.js";
import { sendMailIfConfigured } from "./mail.js";

const SITE_ORIGINS = ["https://www.ownfield.in", "https://ownfield.in", ...(process.env.WEBSITE_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)];
export const LEAD_SIZES = ["1-10", "11-50", "51-200", "200+"] as const;
export const LEAD_INDUSTRIES = ["FMCG and food", "Apparel and footwear", "Pharma and OTC", "Electricals and electronics", "Building materials", "Other"] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{6,18}$/;

const isEmail = (s: string) => EMAIL_RE.test(s) && s.length <= 120;
const isPhone = (s: string) => PHONE_RE.test(s);

function leadNotifyEmail() {
  return String(process.env.LEAD_NOTIFY_EMAIL || "").trim();
}

export function parseLeadContact(b: { contact?: string; email?: string; phone?: string }): { email: string; phone: string; field?: string; error?: string } {
  const contact = String(b.contact ?? "").trim();
  let email = String(b.email ?? "").trim().toLowerCase();
  let phone = String(b.phone ?? "").trim();
  if (contact) {
    if (isEmail(contact)) email = email || contact.toLowerCase();
    else if (isPhone(contact)) phone = phone || contact;
    else return { email: "", phone: "", field: "contact", error: "Enter a valid email or phone number" };
  }
  if (email && !isEmail(email)) return { email, phone, field: email && !contact ? "email" : "contact", error: email && !contact ? "Enter a valid work email" : "Enter a valid email or phone number" };
  if (phone && !isPhone(phone)) return { email, phone, field: phone && !contact ? "phone" : "contact", error: phone && !contact ? "Enter a valid phone number" : "Enter a valid email or phone number" };
  if (!email && !phone) return { email: "", phone: "", field: "contact", error: "Enter a valid email or phone number" };
  return { email, phone };
}

export function registerWebsiteLeadRoutes(app: Express, db: Db, auth: (...roles: any[]) => any) {
  // express-rate-limit on the route so CodeQL recognises the per-IP cap (default 5 per hour).
  const leadLimit = rateLimit({ windowMs: 60 * 60_000, max: Number(process.env.WEBSITE_LEAD_RATE_MAX || 5), standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests from this network. Please try again in an hour." } });
  const allowOrigin = (req: Request, res: Response, next?: NextFunction) => { const o = req.headers.origin; if (o && SITE_ORIGINS.includes(o)) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); } if (next) next(); };
  // Sent as text/plain JSON from the website so the browser needs no preflight.
  app.post("/api/public/website-leads", allowOrigin, leadLimit, express.text({ type: "text/plain", limit: "8kb" }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      let b: any = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { return res.status(400).json({ error: "Invalid request" }); } }
      b = b && typeof b === "object" ? b : {};
      if (b.website) return res.status(400).json({ error: "Invalid request" }); // honeypot
      const s = (k: string, max: number) => String(b[k] ?? "").trim().slice(0, max + 1);
      const kind = s("kind", 20) || "trial";
      const name = s("name", 80);
      const company = s("company", 120);
      const size = s("size", 10);
      const industry = s("industry", 40);
      const message = s("message", 2000);
      if (!["trial", "demo"].includes(kind)) return res.status(400).json({ field: "kind", error: "Choose Start free trial or Book a demo" });
      if (name.length < 2 || name.length > 80) return res.status(400).json({ field: "name", error: "Enter your name" });
      if (company && (company.length < 2 || company.length > 120)) return res.status(400).json({ field: "company", error: "Enter your company name" });
      const contact = parseLeadContact(b);
      if (contact.error) return res.status(400).json({ field: contact.field, error: contact.error });
      if (!(LEAD_SIZES as readonly string[]).includes(size)) return res.status(400).json({ field: "size", error: "Pick a team size" });
      if (industry && !(LEAD_INDUSTRIES as readonly string[]).includes(industry)) return res.status(400).json({ field: "industry", error: "Pick an industry" });
      if (message.length > 2000) return res.status(400).json({ field: "message", error: "Message is too long" });
      await db.query("INSERT INTO website_leads (kind,name,company,email,phone,team_size,industry,message,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [kind, name, company, contact.email, contact.phone, size, industry || null, message || null, req.ip || null]);
      const owners = (await db.query("SELECT id FROM users WHERE role='platform_owner' AND company_id IS NULL")).rows;
      const note = [name, company, contact.email, contact.phone, `team ${size}`, industry, message].filter(Boolean).join(" · ");
      try {
        for (const o of owners) {
          await notify(db, null, Number(o.id), "New website lead from {0}", [name], note, null);
        }
        const to = leadNotifyEmail();
        if (to) {
          const body = [`Name: ${name}`, company && `Company: ${company}`, contact.email && `Email: ${contact.email}`, contact.phone && `Phone: ${contact.phone}`, `Team size: ${size}`, industry && `Industry: ${industry}`, message && `Message: ${message}`].filter(Boolean).join("\n");
          await sendMailIfConfigured(to, `OwnField website lead: ${name}`, body);
        }
      } catch (err: any) { console.error("website lead notify:", err?.message || err); }
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });
  app.get("/api/platform/leads", auth("platform_owner"), async (_q: Request, res: Response, next: NextFunction) => {
    try { res.json((await db.query("SELECT id,created_at,kind,name,company,email,phone,team_size,industry,message FROM website_leads ORDER BY id DESC LIMIT 500")).rows); } catch (e) { next(e); }
  });
}
