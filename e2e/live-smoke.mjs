#!/usr/bin/env node
// Live smoke for https://app.ownfield.in. Never prints passwords or tokens.
const base = process.env.LIVE_BASE_URL || "https://app.ownfield.in";
const password = process.env.OWNFIELD_DEMO_PASSWORD || "";
const company = process.env.OWNFIELD_DEMO_COMPANY || "DEMO";
const email = process.env.OWNFIELD_DEMO_EMAIL || "admin@example.com";

const fail = (m) => { console.error(m); process.exit(1); };

const health = await fetch(`${base}/api/health`);
if (!health.ok) fail(`health ${health.status}`);
const h = await health.json();
if (!h || h.ok !== true) fail("health body was not { ok: true }");
console.log("health: ok");

const home = await fetch(base + "/");
if (!home.ok) fail(`home ${home.status}`);
const html = await home.text();
const asset = html.match(/assets\/(index-[^"']+\.js)/);
if (!asset) fail("home page did not include the app bundle");
const js = await fetch(`${base}/assets/${asset[1]}`);
if (!js.ok) fail(`bundle ${asset[1]} returned ${js.status}`);
console.log(`bundle: ${asset[1]}`);

if (!password) {
  console.log("Skipping live login: repository secret OWNFIELD_DEMO_PASSWORD is not set.");
  process.exit(0);
}

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ companyCode: company, email, password }),
});
if (!login.ok) fail(`demo admin login returned ${login.status}`);
const body = await login.json();
const role = body?.user?.role;
const hasToken = Boolean(body?.token);
if (!hasToken || role !== "company_admin") fail(`demo admin login did not return a company admin session`);
console.log("demo admin login: ok");
