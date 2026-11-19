// Helpers for the OwnField end-to-end suite. Sample data only; passwords come from the environment.
import { expect, type Page, type ConsoleMessage } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as XLSX from "xlsx";

export const base = process.env.E2E_BASE_URL || "http://127.0.0.1:8080";
export const OWNER_EMAIL = process.env.OWNER_EMAIL || process.env.E2E_OWNER_EMAIL || "owner@example.com";
export const OWNER_PASSWORD = process.env.OWNER_PASSWORD || process.env.E2E_OWNER_PASSWORD || "";
export const E2E_PASSWORD = process.env.E2E_PASSWORD || "";
export const PLATFORM_CODE = "PLATFORM";
const DIR = path.dirname(fileURLToPath(import.meta.url));
export const SHOT_DIR = path.join(DIR, "screenshots");

export const CO = {
  code: "E2E1",
  name: "Sample E2E Apparel Co (sample)",
  other: "E2E2",
  otherName: "Sample E2E Other Co (sample)",
  admin: "admin.e2e@example.com",
  manager: "manager.e2e@example.com",
  rep: "rep.e2e@example.com",
  distributor: "distributor.e2e@example.com",
  shop: "SAMPLE-E2E-OUT-1",
  shopName: "Sample E2E Baby Shop",
  shop2: "SAMPLE-E2E-OUT-2",
  shop2Name: "Sample E2E Little Wear",
  newOutlet: "Sample E2E New Street Shop",
  beat: "Sample Monday Beat",
  sku: "STEE-E2E-2Y-RED",
  sku2: "STEE-E2E-2Y-BLUE",
  item: "SAMPLE-E2E-TEE",
  itemName: "Sample E2E Crew Tee",
  stock: 20,
  orderQty: 2,
  lat: 13.0827,
  lng: 80.2707,
};

export type Tokens = {
  owner?: string;
  admin?: string;
  manager?: string;
  rep?: string;
  distributor?: string;
  otherAdmin?: string;
  companyId?: number;
  otherId?: number;
  shopId?: number;
  newShopId?: number;
  orderId?: number;
  visitId?: number;
  orderTotal?: number;
};
export const ctx: Tokens = {};

let pool: pg.Pool | undefined;
export function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database assertions");
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}
export async function q<T = any>(sql: string, params: unknown[] = []) {
  return (await db().query(sql, params)).rows as T[];
}

export async function api(token: string | null, url: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !(init.body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const r = await fetch(base + url, { ...init, headers });
  const raw = await r.text();
  let body: any = raw;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* keep text */ }
  return { status: r.status, ok: r.ok, body, raw, headers: r.headers };
}

export async function loginApi(companyCode: string, email: string, password: string, totp?: string) {
  const r = await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ companyCode, email, password, totp }) });
  if (!r.ok || !r.body?.token) throw new Error(`login failed ${r.status}: ${typeof r.body === "string" ? r.body : r.body?.error || r.raw}`);
  return r.body as { token: string; enrollTotp?: boolean; user: { id: number; role: string; companyCode: string } };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s: string) {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const v = B32.indexOf(ch); if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
/** Same algorithm as server/src/accounts.ts. */
export function totpCode(secret: string, at = Date.now()) {
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", b32decode(secret)).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

export async function enrollOwnerTotp(token: string) {
  const setup = await api(token, "/api/me/totp/setup", { method: "POST" });
  if (!setup.ok || !setup.body?.secret) throw new Error(`totp setup failed ${setup.status}: ${setup.raw}`);
  const code = totpCode(setup.body.secret);
  const en = await api(token, "/api/me/totp/enable", { method: "POST", body: JSON.stringify({ code }) });
  if (!en.ok) throw new Error(`totp enable failed ${en.status}: ${en.raw}`);
  return setup.body.secret as string;
}

export function xlsxBuffer(rows: Record<string, unknown>[]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

export async function importXlsx(token: string, kind: string, rows: Record<string, unknown>[]) {
  const fd = new FormData();
  fd.append("file", new Blob([xlsxBuffer(rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `sample-${kind}.xlsx`);
  const r = await api(token, `/api/import/${kind}`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`import ${kind} failed ${r.status}: ${r.raw}`);
  if (r.body?.errors?.length) throw new Error(`import ${kind} errors: ${JSON.stringify(r.body.errors)}`);
  return r.body as { inserted: number; updated: number; skipped: number; errors: any[] };
}

export const sampleUsers = () => [
  { Name: "Sample E2E Manager", Email: CO.manager, Phone: "9000000010", Role: "manager", Password: E2E_PASSWORD },
  { Name: "Sample E2E Rep", Email: CO.rep, Phone: "9000000011", Role: "sales_rep", Password: E2E_PASSWORD, "Reports To": CO.manager },
  { Name: "Sample E2E Distributor", Email: CO.distributor, Phone: "9000000012", Role: "distributor", Password: E2E_PASSWORD },
];
export const sampleShops = () => [
  { Code: CO.shop, Name: CO.shopName, "Owner Name": "Sample Owner", Phone: "9000000020", City: "Chennai", "State Code": "33", "Store type": "Kids store", "Distributor Email": CO.distributor, "Rep Email": CO.rep, Beat: CO.beat, Latitude: CO.lat, Longitude: CO.lng, Active: "Yes" },
  { Code: CO.shop2, Name: CO.shop2Name, "Owner Name": "Sample Owner", Phone: "9000000021", City: "Coimbatore", "State Code": "33", "Store type": "Multi-brand", "Distributor Email": CO.distributor, "Rep Email": CO.rep, Beat: CO.beat, Latitude: CO.lat, Longitude: CO.lng, Active: "Yes" },
];
export const sampleProducts = () => [
  { "Item Code": CO.item, "Item Name": CO.itemName, Category: "Tops", HSN: "6109", SKU: CO.sku, Size: "2Y", Colour: "Red", MRP: 399, "Billing Price": 280, Fabric: "Cotton", Season: "SS" },
  { "Item Code": CO.item, "Item Name": CO.itemName, Category: "Tops", HSN: "6109", SKU: CO.sku2, Size: "2Y", Colour: "Blue", MRP: 399, "Billing Price": 280, Fabric: "Cotton", Season: "SS" },
];
export const sampleStock = () => [
  { SKU: CO.sku, Qty: CO.stock, Unit: "PCS", "Distributor Email": CO.distributor },
  { SKU: CO.sku2, Qty: CO.stock, Unit: "PCS", "Distributor Email": CO.distributor },
];

export const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const consoleErrors = new WeakMap<Page, string[]>();
export function trackConsole(page: Page) {
  const errs: string[] = [];
  consoleErrors.set(page, errs);
  page.on("pageerror", e => errs.push(e.message));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|Download the React DevTools|net::ERR_ABORTED/i.test(t)) return;
    errs.push(t);
  });
}
export function consoleBugs(page: Page) {
  return consoleErrors.get(page) || [];
}

export async function shot(page: Page, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) - document.documentElement.clientWidth);
  expect(overflow, `${name}: horizontal overflow ${overflow}px`).toBeLessThanOrEqual(24);
  const bugs = consoleBugs(page);
  expect(bugs, `${name}: console errors\n${bugs.join("\n")}`).toEqual([]);
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

export async function uiLogin(page: Page, companyCode: string, email: string, password: string, totp?: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "OwnField" })).toBeVisible();
  await page.getByRole("textbox", { name: /^Company code/ }).fill(companyCode);
  await page.getByRole("textbox", { name: /^Email/ }).fill(email);
  // The password field's accessible name is "Password Show password" because the show/hide button sits inside the same label.
  await page.locator("form.login input[autocomplete='current-password']").fill(password);
  const totpBox = page.getByRole("textbox", { name: /6-digit code/ });
  if (totp && await totpBox.isVisible().catch(() => false)) await totpBox.fill(totp);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (totp && await totpBox.isVisible().catch(() => false)) {
    await totpBox.fill(totp);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 20_000 });
}

export async function uiLogout(page: Page) {
  const btn = page.getByRole("button", { name: "Sign out" });
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }
}

export async function go(page: Page, tab: string, heading?: string | RegExp) {
  await page.evaluate((t) => { location.hash = t; }, tab);
  if (heading) await expect(page.getByRole("heading", { name: heading })).toBeVisible({ timeout: 15_000 });
}

export function requireSecrets() {
  if (!OWNER_PASSWORD || !E2E_PASSWORD) throw new Error("OWNER_PASSWORD (or E2E_OWNER_PASSWORD) and E2E_PASSWORD must be set; they are generated in CI and never committed.");
}
