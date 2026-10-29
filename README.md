<p><img src="web/public/logo-wordmark.svg" alt="OwnField" width="300"/></p>

# OwnField

**Own your sales.**

Open-source, **industry-agnostic** field sales and distributor management for FMCG, pharma, retail and consumer durables, apparel, and services companies. It's meant as a self-hostable alternative to commercial field-force SaaS tools.

**License:** AGPL-3.0-only (see `LICENSE`, `NOTICE`). **Trademark:** the OwnField name and logo are not covered by the code licence — see `TRADEMARKS.md`.

> OwnField was previously called FieldForce OSS. Internal identifiers (database names, env vars, package names, `X-FieldForce-*` webhook headers) keep the old name for compatibility.
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

## Step 4 features
- **GST invoices** from accepted or fulfilled orders:
  - Each line's GST rate comes from its HSN/SAC code: the company sets a default rate plus a rate per code prefix, and the longest matching prefix wins.
  - **CGST + SGST** apply when the outlet's state (state code or GSTIN) matches the company's; otherwise **IGST** applies.
  - Totals are rounded to the rupee and the round-off is shown.
  - Numbers are gapless and **restart every financial year (April–March)**. The format is configurable (`{prefix}/{fy}/{seq:4}`, at most 16 characters).
  - Invoices print as a tax invoice with an HSN summary.
- **Returns / credit notes** against an invoice line: tax is reduced in proportion, you can't return more than was invoiced, and you can optionally **put the goods back into the same batches** they were allocated from.
- **Targets vs achievement:** monthly targets per rep for order value, order count and visits. Set them in the UI or import them from Excel/CSV. Managers see the whole team; reps see their own progress.
- **Visit photos:** reps take photos during a visit. Photos are shrunk on the phone to at most 1280 px, only JPEG/PNG/WebP is accepted (the file content is checked), and there's a limit of 10 per visit. They're stored on disk (`UPLOAD_DIR`, a Docker volume) and visible only to the rep who took them and to managers.
- **Excel/CSV report exports:** orders (line level), visits (with custom fields and photo counts), GST register (invoices and negative credit notes), stock, and targets vs achievement.
- **Database transactions:** placing an order, accepting it (with first-expiry-first-out stock allocation), invoicing, and credit notes with restocking each commit as one transaction or roll back completely. Stock and document numbers are also protected by compare-and-set updates.

## Step 5 features
- **(a) Purchase orders (distributor → company).**
  - The distributor drafts a PO, then submits it, which gives it a number `PO/<FY>/<seq>` that runs separately for each distributor.
  - The company approves it, optionally changing quantities or overriding a price (a reason is required and every override is logged), or rejects it with a reason.
  - Dispatches can be partial. When the company tracks stock, goods are picked from company stock first-expiry-first-out, and their batch and expiry carry through when the distributor receives them into their own stock.
  - Each PO can be printed or exported to CSV/Excel.
  - **Pricing:** start from the price base (billing price or MRP, set per company), take off the margin % (company default, can be overridden per distributor), then any product/category discount %, then the distributor's discount %. GST is charged on the final rate.

- **(b) Distributor billing** (a toggle per company). Distributors invoice their own orders under their own GSTIN, legal name and address, with their own invoice and credit-note numbering. Every document belongs to one issuer: the company or a single distributor. Each issuer sees and credits only its own documents, while the company can view all of them. When the toggle is on, the company can't invoice orders that belong to a distributor.

- **(c) Schemes.** Four types: percent off, flat ₹ off per unit, buy X get Y free, and quantity or value slabs. Each can be limited to a product, category, distributor or date range. The best price scheme is applied to each order line automatically, and buy-X-get-Y adds free lines at ₹0. Invoices carry the same scheme pricing and free goods. The rep app previews savings before the order is placed (`POST /api/orders/preview`). The scheme-cost report (`/api/reports/schemes`) shows the discount given plus the value of free goods for each scheme.

- **(d) Collections.**
  - **Outstanding:** tracked per outlet for each issuer (the company or a billing distributor) as invoices − credit notes − payments, with advances shown separately.
  - **Payments:** cash, UPI, cheque or NEFT (UPI, cheque and NEFT need a reference). Each payment is allocated FIFO or against the invoices you choose.
  - **Receipts:** printable, numbered `RCPT/<FY>/<seq>` per issuer.
  - **Cheque bounce:** reverses the allocations, so the invoices re-open, and the receipt is marked bounced.
  - **Credit terms:** credit days and credit limit are set per company under Settings, and an outlet can override them with `PATCH /api/shops/:id {creditDays, creditLimit}`. A breach either warns (the order is placed with `creditWarning`) or blocks the order (409).
  - **Ageing report:** buckets of 0-30, 31-60, 61-90 and 90+ days, exportable to Excel or CSV.
  - **Rep app:** a Collect tab and an inline credit warning on the order form.

- **(e) E-invoicing** (a toggle per company, plus a provider setting).
  - **JSON:** builds NIC e-invoice schema **v1.1** JSON for invoices (INV) and credit notes (CRN, linked to the original invoice), B2B only, with UQC unit mapping (`GET /api/invoices/:id/einvoice/json`).
  - **Provider interface:** `EinvProvider` with two adapters:
    - **TEST mock:** fake IRN (sha256) and QR, marked *TEST — NOT VALID FOR GST* in the payload and on the print.
    - **GSP stub:** reads `EINV_GSP_BASE_URL`, `EINV_GSP_CLIENT_ID`, `EINV_GSP_CLIENT_SECRET`, `EINV_GSP_USERNAME` and `EINV_GSP_PASSWORD`. Returns 503 if they are missing and 501 otherwise. Connect your GSP there.
  - **Printed invoice:** shows the IRN, acknowledgement number and date, and the QR code.
  - **Cancellation:** allowed within 24 hours of generation, with a NIC reason code.
  - **No real API calls are made.**

> GST rates in the industry templates are **samples**. Verify the rate for every HSN/SAC code with your tax advisor. E-invoicing (IRN/QR) and e-way bills are not included yet.

## Phase 3 features (each is a company feature toggle in Company settings)
- **Store checks (audits)** — admin builds checklists (yes/no, number, text, photo questions); reps fill them during a visit and add shelf photos; managers see a report with scores and photos.
- **Expenses** — reps claim an amount with a category and a bill photo; managers approve or reject (with a reason); monthly summary per rep and category.
- **Leave & attendance** — reps apply for leave; managers approve; on approved leave days the beat shows "on leave" and check-ins are paused; monthly attendance (days worked / on leave).
- **Incentives** — admin sets simple rules: reach X% of a target → earn ₹Y (highest step counts); reps see "earned this month" on their home screen.
- **Retailer app** — a `retailer` login linked to one outlet (users sheet: Role `retailer` + `Shop Code`) can browse products, place orders that go to its distributor's inbox, and see its order history.

Photos are shrunk on the phone (about 1280px JPEG) before upload; the server accepts images up to 1 MB (`PHOTO_MAX_BYTES`).
On start the server adds labelled sample data for these features to the company with code DEMO only, if missing.

## Field operations (each is a company feature toggle; DEMO has sample data for all)

- **Van sales**: load a van, sell and print the invoice on the spot, count and close the day (van stock is its own ledger).
- **Distributor inventory**: stock per distributor with a movement log (receipts, sales, adjustments).
- **Claims**: distributors claim damage/scheme amounts; approve, part-approve or reject; settle with a credit note (CCN-…).
- **Two-way sync**: through Integrations (connectors push events, pull masters).
- **Barcode / QR**: scan with the phone camera (BarcodeDetector) or type the code.
- **Leads**: prospects with follow-ups, converted into outlets.
- **Location trail & geofence**: light GPS pings while the rep app is open (working hours, 30 days kept); check-in warns when far from the outlet.
- **Coverage**: planned vs visited outlets per rep and beat.
- **Languages & offline**: English, Hindi, Tamil, Kannada (picked per phone); lists are cached and orders, payments, van sales, visits and surveys are queued offline and deduped on the server.
- **Surveys**: build forms (text, number, yes/no, choice, competitor price); competitor price report.
- **WhatsApp / SMS**: mock provider by default — messages are only logged. Real sends happen only after an admin sets an HTTP gateway URL and key.

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
Demo logins (hosted demo, sample data): `DEMO / admin@example.com / Demo@2026`, `DEMO / rep@example.com / Demo@2026`, `DEMO / distributor@example.com / Demo@2026`, `DEMO / retailer@example.com / Demo@2026` (retailer app). Local `npm run demo`: `PLATFORM / owner@example.com / demo`, `DEMO / admin@example.com / demo`, `DEMO / rep@example.com / changeme123`.

Upload templates are in `sample-data/`. All sample data there is made up.

## Roadmap
Next (proposed): offline photo queue, a real GSP adapter for e-invoicing (needs your GSP credentials), and e-way bills.

## UI walkthrough (mobile)

![OwnField login (phone)](docs/ui-9-ownfield-login.png)

| Login | Rep home | New order | Admin home |
|---|---|---|---|
| ![](docs/ui-1-login.png) | ![](docs/ui-2-rep-home.png) | ![](docs/ui-3-order.png) | ![](docs/ui-4-admin-home.png) |

Screenshots use the in-memory DEMO company (`npm run demo -w server`). All of its data is sample data.

## Security & privacy
- Sign-in: per-IP rate limit and per-account lockout (5 failures → 15 min), optional TOTP two-step sign-in (admins can require it), optional one-phone binding for sales reps, idle sign-out (default 60 min, per company), one-time admin reset codes (plug a mailer in with `setMailer()`).
- Tokens are revoked at once when a user is disabled, deleted, or changes/resets their password.
- Helmet headers (HSTS, CSP, frame deny, nosniff), same-origin CORS (`CORS_ORIGINS` to allow more), app binds to `127.0.0.1` (`HOST` to change), `trust proxy` = 1.
- Activity log of sign-ins, alerts (new device/IP, failures, lockouts) and admin changes under **Security & privacy**; data export (JSON/CSV) and user/company deletion by anonymisation; privacy notice at `/privacy.html`.
- Nightly gzip `pg_dump` at 02:30 into `~/backups` (7 kept; `BACKUP_DIR`, `BACKUP_KEEP`, optional `BACKUP_S3_BUCKET`).

## Copyright & trademark

© 2026 Vignesh S. OwnField is a trademark of Vignesh S.

SPDX-License-Identifier: AGPL-3.0-only. You may use, change and share the code under the AGPL. You may not use the OwnField name or logo for your own product or service without permission; see [TRADEMARKS.md](TRADEMARKS.md).
