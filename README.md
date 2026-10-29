# FieldForce OSS

Open-source, **industry-agnostic** field sales and distributor management for FMCG, pharma, retail and consumer durables, apparel, and services companies. It's meant as a self-hostable alternative to commercial field-force SaaS tools.

**License:** AGPL-3.0-only (see `LICENSE`).
**Hosted version:** free up to a fixed number of users per company. The platform owner sets each company's user limit. Admins see a warning at 80% of the limit, and new users are blocked once the limit is reached. You can self-host it with no limits.

## Step 1 features
- Multi-company with tenant isolation: every query is scoped to the company in the signed-in user's token.
- Login with company code + email + password. The platform owner uses the code `PLATFORM`.
- Roles: platform owner, company admin, manager, sales rep, distributor.
- Per-company user limit set by the platform owner: warning at 80%, blocked at the limit.
- Excel/CSV upload for **shops**, **products** (style, SKU, size, HSN, MRP, billing price) and **users**. Uploads add new rows or update existing ones, and errors are reported per row.
- Mobile-first React PWA with admin pages (users, shops, products, import, platform companies).

## Step 2 features
- **Beat/route plans:** managers create ordered shop routes and assign them to sales reps. Reps see only their own beats.
- **Visits with GPS check-in/out:** coordinates are required. A rep can have only one open visit at a time.
- **Order taking with a size grid per style:** prices come from the billing price. Orders are saved in an **offline queue** in the PWA and synced automatically. The server ignores repeats of the same order (`clientRef`), so retries never create duplicates.
- **Distributor mapping:** set per shop in the UI, or with the `Distributor Email` column in the shop upload. Orders go to the mapped distributor's **inbox**, where they can be accepted, rejected, or marked fulfilled.
- **Manager dashboard:** visits, orders and order value by rep and day for the last 1, 7 or 30 days. Days use `REPORT_TZ`, default Asia/Kolkata.

## Step 3 features (industry-agnostic)
- **Industry templates chosen at setup:** Apparel, FMCG, Pharma, Retail/Consumer durables, Services or Custom. A template presets features, variant attributes, units and custom fields. Admins can change all of it later in **Settings**, or re-apply a template.
- **Configurable product model:** item → variants with company-defined attributes (size/colour, pack size/flavour, strength/form, model/colour, plan…). Each item has units with conversions (e.g. `PCS=1|BOX=12|CASE=144`, `STRIP=1|BOX=10`), and each variant has its own MRP and billing price. Orders store the unit, the quantity and the base-unit quantity.
- **Pharma:** stock carries batch number + expiry. Orders are allocated **first-expiry-first-out (FEFO)** when accepted, and expired batches are never allocated. Outlets and distributors can carry an optional drug licence number.
- **Services:** non-stock items (service visit, AMC…) are never stock-checked.
- **Feature toggles per company:** stock tracking, batches, size-grid ordering, GPS check-in, schemes, drug licence, service items. The app adapts to them. For example, the size grid appears only for items whose variants differ by attribute; other items get a simple quantity + unit list.
- **Custom fields** on outlets, products and visits (text / number / date / select, optionally required). They're validated on import, on the API and in the visit check-out form.
- **Schemes:** percentage discount above a minimum base quantity, for one item or for all items.
- **Stock:** per distributor or company stock. Orders are checked against sellable stock when placed and allocated when accepted.
- **Excel/CSV import adapts** to each company's attributes, units and custom fields. Each import has a downloadable template. Stock upload sets the quantity per SKU/batch/location.
- **A sample dataset per template** (Settings → Load sample data). Every record is fictitious and named "Sample …".

## Stack
Node 20 + TypeScript + Express + PostgreSQL. React + Vite on the front end. Tests use Vitest + Supertest against in-memory Postgres (pg-mem).

> Pre-1.0: the database schema may still change between steps. Recreate the database when upgrading.

## Self-host
```bash
OWNER_EMAIL=you@example.com OWNER_PASSWORD=strong JWT_SECRET=random docker compose up -d --build
# open http://localhost:8080 , sign in with company code PLATFORM
```

## Develop
```bash
npm install
npm test                 # API tests
npm run demo -w server   # in-memory demo with SAMPLE data on :8080 (run `npm run build -w web` first)
npm run dev -w web       # Vite dev server proxying /api
```
Demo logins: `PLATFORM / owner@example.com / demo`, `DEMO / admin@example.com / demo`, `DEMO / rep@example.com / changeme123`, `DEMO / distributor@example.com / changeme123`.

Upload templates are in `sample-data/`. All sample data there is made up.

## Roadmap
Step 4 (proposed): invoices/GST tax lines and returns, targets vs achievement, photo capture on visits, report exports, and wrapping stock allocation in DB transactions.
