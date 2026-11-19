import { expect, test } from "@playwright/test";
import {
  CO, E2E_PASSWORD, OWNER_EMAIL, OWNER_PASSWORD, PLATFORM_CODE, ctx,
  api, consoleBugs, enrollOwnerTotp, expectSignedIn, go, importXlsx, loginApi, q, requireSecrets,
  sampleProducts, sampleShops, sampleStock, sampleUsers, shot, tinyPng, totpCode,
  trackConsole, uiLogin, uiLogout,
} from "./helpers.js";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => { trackConsole(page); });

test.beforeAll(async () => {
  requireSecrets();
  const h = await api(null, "/api/health");
  expect(h.body, "server is up").toEqual({ ok: true });
});

test("platform owner sets up two-step sign-in and creates a company", async ({ page }) => {
  const first = await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ companyCode: PLATFORM_CODE, email: OWNER_EMAIL, password: OWNER_PASSWORD }) });
  expect(first.status, `platform login: ${typeof first.body === "string" ? first.body : first.body?.error || first.raw}`).toBe(200);
  expect(first.body?.token, "platform login should return a token so two-step can be set up").toBeTruthy();
  const secret = await enrollOwnerTotp(first.body.token);
  const code = totpCode(secret);
  const session = await loginApi(PLATFORM_CODE, OWNER_EMAIL, OWNER_PASSWORD, code);
  ctx.owner = session.token;

  await uiLogin(page, PLATFORM_CODE, OWNER_EMAIL, OWNER_PASSWORD, code);
  await expect(page.getByRole("heading", { name: "New company" })).toBeVisible({ timeout: 15_000 });
  await shot(page, "01-platform-home");
  await page.getByText("Apparel / Kidswear").click();
  await page.getByPlaceholder("code", { exact: true }).fill(CO.code);
  await page.getByPlaceholder("name", { exact: true }).fill(CO.name);
  await page.getByPlaceholder("userLimit", { exact: true }).fill("12");
  await page.getByPlaceholder("email", { exact: true }).fill(CO.admin);
  await page.getByPlaceholder("adminName", { exact: true }).fill("Sample E2E Admin");
  await page.getByPlaceholder("password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Created")).toBeVisible();
  await expect(page.getByText(CO.code)).toBeVisible();
  await shot(page, "02-platform-company-created");
  const companies = (await api(ctx.owner!, "/api/platform/companies")).body as any[];
  const created = companies.find((c: any) => c.code === CO.code);
  expect(created, "company row exists").toBeTruthy();
  ctx.companyId = Number(created.id);
  const rows = await q("SELECT id, code, name, industry FROM companies WHERE code=$1", [CO.code]);
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe(CO.name);
  expect(rows[0].industry).toBe("apparel");
  await uiLogout(page);
});

test("admin enables stock and approval, then uploads users, outlets, SKUs and stock", async ({ page }) => {
  await uiLogin(page, CO.code, CO.admin, E2E_PASSWORD);
  ctx.admin = (await loginApi(CO.code, CO.admin, E2E_PASSWORD)).token;
  const settings = await api(ctx.admin!, "/api/company/settings", {
    method: "PUT",
    body: JSON.stringify({ features: { stock: true, gps: false, photos: true, schemes: false }, approval: { levels: 1, above: 0 } }),
  });
  expect(settings.ok, settings.raw).toBe(true);
  expect(settings.body.settings.features.stock).toBe(true);
  expect(settings.body.settings.approval.levels).toBe(1);

  const users = await importXlsx(ctx.admin!, "users", sampleUsers());
  expect(users.inserted).toBe(3);
  const shops = await importXlsx(ctx.admin!, "shops", sampleShops());
  expect(shops.inserted).toBe(2);
  const products = await importXlsx(ctx.admin!, "products", sampleProducts());
  expect(products.inserted).toBeGreaterThanOrEqual(1);
  const stock = await importXlsx(ctx.admin!, "stock", sampleStock());
  expect(stock.inserted + stock.updated).toBe(2);

  await go(page, "users", "Users");
  await expect(page.getByText("Sample E2E Manager").first()).toBeVisible();
  await expect(page.getByText("Sample E2E Rep").first()).toBeVisible();
  await expect(page.getByText("Sample E2E Distributor").first()).toBeVisible();
  await shot(page, "03-admin-users");

  await go(page, "shops", /Outlets|Shops/);
  await expect(page.getByText(CO.shopName)).toBeVisible();
  await shot(page, "04-admin-outlets");

  await go(page, "beats", "Beat plans");
  await expect(page.getByText(CO.beat)).toBeVisible();
  await shot(page, "05-admin-beats");

  const cid = ctx.companyId!;
  const team = await q("SELECT email, role, reports_to, company_id FROM users WHERE company_id=$1 ORDER BY role", [cid]);
  expect(team.every(u => u.company_id === cid)).toBe(true);
  expect(team.map(u => u.email).sort()).toEqual([CO.admin, CO.distributor, CO.manager, CO.rep].sort());
  const repRow = (await q("SELECT reports_to FROM users WHERE email=$1 AND company_id=$2", [CO.rep, cid]))[0];
  const mgrId = (await q("SELECT id FROM users WHERE email=$1 AND company_id=$2", [CO.manager, cid]))[0].id;
  expect(repRow.reports_to).toBe(mgrId);

  const outlets = await q("SELECT code, approval_status, distributor_id, company_id FROM shops WHERE company_id=$1", [cid]);
  expect(outlets).toHaveLength(2);
  expect(outlets.every(s => s.company_id === cid)).toBe(true);
  const distId = (await q("SELECT id FROM users WHERE email=$1 AND company_id=$2", [CO.distributor, cid]))[0].id;
  expect(outlets.every(s => s.distributor_id === distId)).toBe(true);
  ctx.shopId = (await q("SELECT id FROM shops WHERE company_id=$1 AND code=$2", [cid, CO.shop]))[0].id;

  const beats = await q("SELECT name FROM beats WHERE company_id=$1", [cid]);
  expect(beats.some((b: any) => b.name === CO.beat)).toBe(true);
  const st = await q("SELECT v.sku, s.qty FROM stock s JOIN variants v ON v.id=s.variant_id WHERE s.company_id=$1 AND v.sku=$2", [cid, CO.sku]);
  expect(Number(st[0].qty)).toBe(CO.stock);
  await uiLogout(page);
});

test("wrong roles, bad input and the other company are rejected", async () => {
  ctx.manager = (await loginApi(CO.code, CO.manager, E2E_PASSWORD)).token;
  ctx.rep = (await loginApi(CO.code, CO.rep, E2E_PASSWORD)).token;
  ctx.distributor = (await loginApi(CO.code, CO.distributor, E2E_PASSWORD)).token;

  expect((await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ companyCode: "", email: CO.admin, password: E2E_PASSWORD }) })).status).toBe(400);
  expect((await api(null, "/api/auth/login", { method: "POST", body: JSON.stringify({ companyCode: CO.code, email: CO.admin, password: "wrong-password-xxxx" }) })).status).toBe(401);
  expect((await api(ctx.rep!, "/api/users", { method: "POST", body: JSON.stringify({ email: "x@example.com", name: "X", role: "manager", password: E2E_PASSWORD }) })).status).toBe(403);
  expect((await api(ctx.rep!, "/api/company/settings", { method: "PUT", body: JSON.stringify({ approval: { levels: 0, above: 0 } }) })).status).toBe(403);
  expect((await api(ctx.distributor!, "/api/visits/checkin", { method: "POST", body: JSON.stringify({ shopId: ctx.shopId }) })).status).toBe(403);
  expect((await api(ctx.rep!, "/api/orders", { method: "POST", body: JSON.stringify({ clientRef: "bad-1", shopId: ctx.shopId, lines: [] }) })).status).toBeGreaterThanOrEqual(400);
  expect((await api(ctx.manager!, "/api/import/products", { method: "POST", body: new FormData() })).status).toBeGreaterThanOrEqual(400);

  // Second company: isolation
  const other = await api(ctx.owner!, "/api/platform/companies", {
    method: "POST",
    body: JSON.stringify({ code: CO.other, name: CO.otherName, industry: "apparel", userLimit: 8, admin: { email: "admin.other@example.com", name: "Sample Other Admin", password: E2E_PASSWORD } }),
  });
  expect(other.status).toBe(201);
  ctx.otherId = Number(other.body.company.id);
  ctx.otherAdmin = (await loginApi(CO.other, "admin.other@example.com", E2E_PASSWORD)).token;
  const foreignShop = await api(ctx.otherAdmin!, `/api/shops`);
  expect((foreignShop.body as any[]).find((s: any) => s.id === ctx.shopId)).toBeFalsy();
  const steal = await api(ctx.otherAdmin!, "/api/orders", { method: "POST", body: JSON.stringify({ clientRef: "x", shopId: ctx.shopId, lines: [{ sku: CO.sku, qty: 1 }] }) });
  expect([400, 403, 404]).toContain(steal.status);
  const usersOther = await api(ctx.otherAdmin!, "/api/users");
  expect((usersOther.body as any[]).every((u: any) => u.email !== CO.admin)).toBe(true);
  const leak = await q("SELECT count(*)::int AS n FROM shops WHERE id=$1 AND company_id=$2", [ctx.shopId, ctx.otherId]);
  expect(leak[0].n).toBe(0);
});

test("rep logs in, adds an outlet, checks in, uploads a photo and places a stock-capped order", async ({ page }) => {
  await uiLogin(page, CO.code, CO.rep, E2E_PASSWORD);
  await shot(page, "06-rep-home");

  await go(page, "addoutlet", "Add outlet");
  await page.getByLabel("Outlet name").fill(CO.newOutlet);
  await page.getByLabel("City").fill("Chennai");
  // The location button sits inside the "GPS location" label, so that is its accessible name.
  await page.getByRole("button", { name: /GPS location|Capture location/ }).click();
  await expect(page.getByText(/13\.08/)).toBeVisible({ timeout: 10_000 });
  await page.locator("form.card input[type='file']").setInputFiles({ name: "sample-photo.png", mimeType: "image/png", buffer: tinyPng });
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByText(/Sent for approval/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(CO.newOutlet)).toBeVisible();
  await shot(page, "07-rep-add-outlet");
  const pending = await q("SELECT id, approval_status, company_id, added_by FROM shops WHERE company_id=$1 AND name=$2", [ctx.companyId, CO.newOutlet]);
  expect(pending).toHaveLength(1);
  expect(pending[0].approval_status).toBe("pending");
  ctx.newShopId = pending[0].id;

  await go(page, "beat", "My beat");
  await expect(page.getByText(CO.shopName)).toBeVisible();
  await page.getByRole("button", { name: /Check in/ }).first().click();
  await expect(page.getByText(/In visit/)).toBeVisible({ timeout: 15_000 });
  const visits = await q("SELECT id, shop_id, check_out_at FROM visits WHERE company_id=$1 AND check_out_at IS NULL ORDER BY id DESC", [ctx.companyId]);
  expect(visits.length).toBeGreaterThan(0);
  ctx.visitId = visits[0].id;
  await page.locator(".photos input[type='file'], .addphoto input[type='file']").first().setInputFiles({ name: "visit-photo.png", mimeType: "image/png", buffer: tinyPng });
  await expect.poll(async () => (await q("SELECT id FROM visit_photos WHERE visit_id=$1 AND company_id=$2", [ctx.visitId, ctx.companyId])).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await shot(page, "08-rep-checkin-photo");

  const over = await api(ctx.rep!, "/api/orders", {
    method: "POST",
    body: JSON.stringify({ clientRef: `over-${Date.now()}`, shopId: ctx.shopId, lines: [{ sku: CO.sku, qty: CO.stock + 5 }] }),
  });
  expect(over.status).toBe(409);
  expect(String(over.body?.error || over.raw)).toMatch(/insufficient stock/i);
  const stockStill = await q("SELECT qty FROM stock s JOIN variants v ON v.id=s.variant_id WHERE s.company_id=$1 AND v.sku=$2", [ctx.companyId, CO.sku]);
  expect(Number(stockStill[0].qty)).toBe(CO.stock);

  await go(page, "order", /Which outlet is this order for/);
  await page.getByRole("button", { name: new RegExp(CO.shopName) }).click();
  await expect(page.getByRole("heading", { name: "Add products" })).toBeVisible();
  await page.getByLabel(`Quantity ${CO.sku}`).fill(String(CO.orderQty));
  await page.getByRole("button", { name: /Review order/ }).click();
  await expect(page.getByRole("heading", { name: "Review order" })).toBeVisible();
  await shot(page, "09-rep-review-order");
  await page.getByRole("button", { name: /Place order/ }).click();
  await expect(page.getByRole("heading", { name: /Order placed|Waiting for approval/ })).toBeVisible({ timeout: 20_000 });
  await shot(page, "10-rep-order-placed");

  const orders = await q("SELECT id, status, total, company_id, shop_id, distributor_id FROM orders WHERE company_id=$1 ORDER BY id DESC LIMIT 1", [ctx.companyId]);
  expect(orders).toHaveLength(1);
  expect(orders[0].status).toBe("pending_approval");
  expect(orders[0].shop_id).toBe(ctx.shopId);
  expect(Number(orders[0].total)).toBe(CO.orderQty * 280);
  ctx.orderId = orders[0].id;
  ctx.orderTotal = Number(orders[0].total);
  const held = await q("SELECT qty FROM stock s JOIN variants v ON v.id=s.variant_id WHERE s.company_id=$1 AND v.sku=$2", [ctx.companyId, CO.sku]);
  expect(Number(held[0].qty)).toBe(CO.stock - CO.orderQty);
  const alloc = await q("SELECT a.qty FROM order_allocations a JOIN order_lines l ON l.id=a.order_line_id WHERE l.order_id=$1", [ctx.orderId]);
  expect(Number(alloc[0].qty)).toBe(CO.orderQty);

  await go(page, "beat", "My beat");
  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByRole("button", { name: /Check in/ })).toBeVisible({ timeout: 15_000 });
  const done = await q("SELECT check_out_at, no_order_reason FROM visits WHERE id=$1", [ctx.visitId]);
  expect(done[0].check_out_at).toBeTruthy();
  expect(done[0].no_order_reason).toBeNull();
  await shot(page, "11-rep-checked-out");
  await uiLogout(page);
});

test("manager approves the new outlet and the order; dashboard totals match", async ({ page }) => {
  await uiLogin(page, CO.code, CO.manager, E2E_PASSWORD);
  await go(page, "outletapprovals", /New outlets|Waiting/);
  await expect(page.getByText(CO.newOutlet)).toBeVisible();
  await shot(page, "12-manager-outlet-approval");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await q("SELECT approval_status FROM shops WHERE id=$1", [ctx.newShopId]))[0].approval_status, { timeout: 15_000 }).toBe("approved");

  await go(page, "orders", "Orders");
  await expect(page.getByText(/Waiting for approval/)).toBeVisible();
  await shot(page, "13-manager-order-approval");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/^New$|placed/i).or(page.getByText("New"))).toBeVisible({ timeout: 15_000 });
  const o = await q("SELECT status, approval_level FROM orders WHERE id=$1", [ctx.orderId]);
  expect(o[0].status).toBe("placed");

  await go(page, "dashboard", "Team activity");
  await shot(page, "14-manager-dashboard");
  const dash = (await api(ctx.manager!, "/api/dashboard?days=7")).body as { visits: number; orders: number; value: number }[];
  const tot = dash.reduce((a, r) => ({ v: a.v + r.visits, o: a.o + r.orders, val: a.val + Number(r.value) }), { v: 0, o: 0, val: 0 });
  expect(tot.v).toBeGreaterThanOrEqual(1);
  expect(tot.o).toBe(1);
  expect(tot.val).toBe(ctx.orderTotal);
  await expect(page.locator(".kpis")).toContainText(String(tot.o));
  await uiLogout(page);
});

test("distributor accepts, delivers and downloads the order file", async ({ page }) => {
  await uiLogin(page, CO.code, CO.distributor, E2E_PASSWORD);
  await go(page, "inbox", "Order inbox");
  await expect(page.getByText(CO.shopName)).toBeVisible();
  await shot(page, "15-distributor-inbox");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted")).toBeVisible({ timeout: 15_000 });
  expect((await q("SELECT status FROM orders WHERE id=$1", [ctx.orderId]))[0].status).toBe("accepted");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download order file" }).click(),
  ]);
  const name = download.suggestedFilename();
  expect(name).toMatch(/\.xlsx$/i);
  const filePath = await download.path();
  expect(filePath, "file was downloaded").toBeTruthy();
  const fs = await import("node:fs");
  expect(fs.statSync(filePath!).size).toBeGreaterThan(100);
  await shot(page, "16-distributor-download");

  await page.getByRole("button", { name: "Out for delivery" }).click();
  await expect(page.getByText("Dispatched")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByText("Delivered")).toBeVisible({ timeout: 15_000 });
  await shot(page, "17-distributor-delivered");
  expect((await q("SELECT status FROM orders WHERE id=$1", [ctx.orderId]))[0].status).toBe("fulfilled");
  const leftover = await q("SELECT qty FROM stock s JOIN variants v ON v.id=s.variant_id WHERE s.company_id=$1 AND v.sku=$2", [ctx.companyId, CO.sku]);
  expect(Number(leftover[0].qty)).toBe(CO.stock - CO.orderQty);
  const isolation = await q("SELECT count(*)::int AS n FROM orders WHERE id=$1 AND company_id<>$2", [ctx.orderId, ctx.companyId]);
  expect(isolation[0].n).toBe(0);
  await uiLogout(page);
});

test("admin, manager and rep can still open the app after the full day", async ({ page }) => {
  for (const [role, email] of [["admin", CO.admin], ["manager", CO.manager], ["rep", CO.rep]] as const) {
    await uiLogin(page, CO.code, email, E2E_PASSWORD);
    await expectSignedIn(page);
    await shot(page, `18-${role}-still-works`);
    expect(consoleBugs(page)).toEqual([]);
    await uiLogout(page);
  }
  expect((await api(null, "/api/health")).body).toEqual({ ok: true });
});
