# Integrating FieldForce with ERP, accounting and warehouse systems

FieldForce has one generic integration layer. Nothing is tied to one vendor: SAP, Odoo, Tally, Logic ERP and WMS
support are **presets** (ready-made field mappings) on top of generic connectors that you can change in the UI.

Admin → **Integrations** has four tabs: **API keys**, **Webhooks**, **Connectors**, **Delivery log**.

## 1. Public REST API (`/api/v1`)

* Docs: `https://<your-site>/api/v1/docs` · Spec: `https://<your-site>/api/v1/openapi.json` (OpenAPI 3.0).
* Generate a client: `npx @openapitools/openapi-generator-cli generate -i https://<your-site>/api/v1/openapi.json -g python -o ff-client`
* Auth: `Authorization: Bearer ffk_...` or `X-API-Key: ffk_...`. Keys are per company, created by the company admin,
  shown once, stored only as a SHA-256 hash, revocable, and every write is written to the security audit log.
* Scopes: `products:read|write`, `stock:read|write`, `customers:read|write`, `distributors:read|write`,
  `orders:read|write`, `invoices:read`, `collections:read`, `users:read`.
* Rate limit: 120 requests per minute per key (`API_RATE_MAX`). Over the limit you get `429` with `Retry-After`.

| Resource | Read | Write |
|---|---|---|
| Products / SKUs | `GET /products`, `/products/{id}` | `POST /products/upsert` (match `external_id`, then `sku`) |
| Stock | `GET /stock` | `POST /stock/upsert` (sets qty for location + sku + batch) |
| Customers (outlets) | `GET /customers`, `/customers/{id}` | `POST /customers/upsert` (match `external_id`, then `code`) |
| Distributors | `GET /distributors` | `POST /distributors/upsert` (match `external_id`, then `email`) |
| Orders | `GET /orders`, `/orders/{id}` (`?status=`) | `PUT /orders/{id}/external-id` (write back the ERP number) |
| Invoices | `GET /invoices` (with lines) | – |
| Collections | `GET /collections` | – |
| Users | `GET /users` | – |

**Incremental sync:** every list takes `limit` (≤500), `page` and `updated_since` (ISO time). Save the `server_time`
from a response and pass it as `updated_since` next time. Upserts take `{"items": [...]}` (≤500); each row succeeds or
fails alone and the response lists `errors` with the row `index`.

```bash
curl -H "X-API-Key: $KEY" "https://<site>/api/v1/products?limit=100&updated_since=2026-10-01T00:00:00Z"
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"items":[{"external_id":"ERP-1001","sku":"SAMPLE-1","name":"Sample item","mrp":120,"price":100}]}' \
  https://<site>/api/v1/products/upsert
```

## 2. Outgoing webhooks

Events: `order.created`, `order.approved` (order accepted), `order.status_changed`, `invoice.created`,
`credit_note.created`, `collection.created`, `stock.low`, `van.closed`, `claim.submitted`, `claim.settled`, `lead.converted` (stock at or below the company low-stock level, default 10).

Every POST carries `X-FieldForce-Event`, `X-FieldForce-Delivery`, `X-FieldForce-Timestamp` and
`X-FieldForce-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw body)>`. Check it like this:

```js
const ok = sig === "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
```

Deliveries go through a small queue table (`webhook_deliveries`): any non-2xx or timeout is retried after 30 s, 1, 2, 4 …
minutes, up to 8 attempts, then marked failed (retry by hand from the Delivery log). URLs must be https and must not
point at private or cloud-metadata addresses. Logs older than 30 days are trimmed. No extra infrastructure.

## 3. Connectors (generic, configured in the UI)

* **Custom REST** — base URL, auth (none / API key header / basic / bearer / OAuth2 client credentials), one endpoint per
  record type with method, path and a JSON template (`"{{$mapped}}"` = the mapped record, `"{{field}}"` = one value,
  `{{config.x}}` = a template variable). Trigger: events (e.g. `order.created,invoice.created`) and/or every N minutes
  (pushes records changed since the last run). Can also **pull** products, customers, stock or distributors.
* **File** — CSV, Excel or JSON download/upload with your own column names; optional scheduled drop folder
  (`INTEGRATION_DROP_DIR/<company id>/<folder>`). For SFTP, mount the remote folder on the server (sshfs/rclone) and point
  the drop folder at it; no SFTP client is bundled to keep the server small.
* **Tally XML** — Sales, Sales Order and Receipt vouchers for Tally import.
* **Inbound webhook** — every connector has its own URL `POST /api/v1/inbound/<token>/<products|stock|customers|distributors>`.
  The connector's mapping turns the sender's fields into FieldForce fields. Optional `inboundSecret` in the config makes
  FieldForce require `X-Signature: sha256=<hex HMAC of the raw body>`.

**Field mapper**: each rule is *FieldForce field → external field* with a transform: rename, constant, date format
(`DD.MM.YYYY`, `YYYYMMDD` …), number (decimals), lookup table (`cash=Cash;*=Bank`), upper/lower, or template
(`Order {{client_ref}}`). Order/invoice lines use nested rules (`each`). Mappings are saved per company per connector.

**Safety**: new connectors start **off** and in **sample mode**. Sample mode builds the exact request and stores it in the
delivery log, but never calls the network. Secrets are masked in the UI and API.

### Presets

| Preset | Built on | What it does |
|---|---|---|
| Odoo | Custom REST | JSON-RPC `execute_kw`: create `sale.order` on `order.created`; pull `product.product` |
| SAP S/4HANA | Custom REST | OData `API_SALES_ORDER_SRV/A_SalesOrder` mapping and `API_PRODUCT_SRV` pull (stub until you add your gateway) |
| Tally | Tally XML | Sales / Receipt vouchers |
| Logic ERP | File | **Parked**: CSV export only; live mode is blocked |
| WMS pick list | Custom REST | Pick list on `order.approved`; use a File connector for CSV pick lists |
| Generic CSV / Excel | File | FieldForce column names, rename as needed |

### Writing your own connector

Drop one file in `server/src/connectors/plugins/`. See `server/src/connectors/README.md`.

## 4. Typical two-way setup

1. Create an API key with the write scopes. The ERP pushes products, customers, distributors and stock with the upserts
   **or** FieldForce pulls them: in a Custom REST connector set *Sync every N minutes* and *Pull on schedule* to
   `products,stock` (and/or `customers,distributors`) with one endpoint per record type and a mapping.
2. Add a webhook or a connector for `order.created` / `invoice.created` / `collection.created` so documents go to the ERP.
3. The ERP writes its document number back with `PUT /orders/{id}/external-id`.
