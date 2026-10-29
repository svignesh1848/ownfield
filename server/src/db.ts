import pg from "pg";
export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>; connect?: () => Promise<any> };

/** Run fn inside a database transaction (BEGIN/COMMIT, ROLLBACK on any error). Nested calls reuse the outer transaction. */
export async function withTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (!db.connect) return fn(db); // already a transaction client
  const c = await db.connect();
  const tx: Db = { query: (t, p) => c.query(t, p) };
  try { await c.query("BEGIN"); const r = await fn(tx); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}

// JSON payloads (settings, attributes, units, custom fields) are stored as TEXT holding JSON for portability.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, industry TEXT NOT NULL DEFAULT 'custom', settings TEXT,
  user_limit INTEGER NOT NULL DEFAULT 10, created_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id), email TEXT NOT NULL,
  name TEXT NOT NULL, phone TEXT, role TEXT NOT NULL, password_hash TEXT NOT NULL, drug_licence TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE (company_id, email));
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), code TEXT NOT NULL,
  name TEXT NOT NULL, owner_name TEXT, phone TEXT, address TEXT, city TEXT, pincode TEXT, state_code TEXT, gstin TEXT, drug_licence TEXT, custom TEXT, credit_days INTEGER, credit_limit NUMERIC,
  distributor_id INTEGER REFERENCES users(id), UNIQUE (company_id, code));
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), code TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT, kind TEXT NOT NULL DEFAULT 'goods', hsn TEXT, uoms TEXT, custom TEXT, UNIQUE (company_id, code));
CREATE TABLE IF NOT EXISTS variants (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), item_id INTEGER NOT NULL REFERENCES items(id),
  sku TEXT NOT NULL, attrs TEXT, mrp NUMERIC NOT NULL, billing_price NUMERIC NOT NULL, UNIQUE (company_id, sku));
CREATE TABLE IF NOT EXISTS stock (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), distributor_id INTEGER REFERENCES users(id),
  variant_id INTEGER NOT NULL REFERENCES variants(id), batch_no TEXT NOT NULL DEFAULT '', expiry TEXT, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS schemes (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, item_id INTEGER REFERENCES items(id),
  min_qty INTEGER NOT NULL DEFAULT 1, discount_pct NUMERIC NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
  type TEXT NOT NULL DEFAULT 'percent', category TEXT, distributor_id INTEGER REFERENCES users(id), starts_on TEXT, ends_on TEXT, config TEXT);
CREATE TABLE IF NOT EXISTS beats (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
  rep_id INTEGER REFERENCES users(id), weekday INTEGER);
CREATE TABLE IF NOT EXISTS beat_shops (
  beat_id INTEGER NOT NULL REFERENCES beats(id), shop_id INTEGER NOT NULL REFERENCES shops(id), seq INTEGER NOT NULL,
  PRIMARY KEY (beat_id, shop_id));
CREATE TABLE IF NOT EXISTS visits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), rep_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id), check_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), in_lat NUMERIC, in_lng NUMERIC,
  check_out_at TIMESTAMPTZ, out_lat NUMERIC, out_lng NUMERIC, notes TEXT, custom TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), client_ref TEXT NOT NULL,
  rep_id INTEGER NOT NULL REFERENCES users(id), shop_id INTEGER NOT NULL REFERENCES shops(id),
  distributor_id INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'placed', total NUMERIC NOT NULL, savings NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (company_id, client_ref));
CREATE TABLE IF NOT EXISTS order_lines (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id),
  uom TEXT NOT NULL, qty INTEGER NOT NULL, base_qty INTEGER NOT NULL, price NUMERIC NOT NULL,
  discount_pct NUMERIC NOT NULL DEFAULT 0, amount NUMERIC NOT NULL, gross NUMERIC, scheme_id INTEGER REFERENCES schemes(id), free BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS order_allocations (
  id SERIAL PRIMARY KEY, order_line_id INTEGER NOT NULL REFERENCES order_lines(id), stock_id INTEGER NOT NULL REFERENCES stock(id),
  batch_no TEXT, expiry TEXT, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS doc_series (
  company_id INTEGER NOT NULL REFERENCES companies(id), kind TEXT NOT NULL, fy TEXT NOT NULL, next_no INTEGER NOT NULL,
  PRIMARY KEY (company_id, kind, fy));
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), issuer TEXT NOT NULL DEFAULT 'company', kind TEXT NOT NULL, number TEXT NOT NULL, fy TEXT NOT NULL,
  doc_date TEXT NOT NULL, order_id INTEGER REFERENCES orders(id), ref_invoice_id INTEGER REFERENCES invoices(id), shop_id INTEGER NOT NULL REFERENCES shops(id),
  seller TEXT NOT NULL, buyer TEXT NOT NULL, place_of_supply TEXT, intra_state BOOLEAN NOT NULL, reason TEXT,
  taxable NUMERIC NOT NULL, cgst NUMERIC NOT NULL, sgst NUMERIC NOT NULL, igst NUMERIC NOT NULL, round_off NUMERIC NOT NULL, total NUMERIC NOT NULL,
  created_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  irn TEXT, ack_no TEXT, einv_ack_at TIMESTAMPTZ, signed_qr TEXT, einv_status TEXT, einv_provider TEXT, einv_cancelled_at TIMESTAMPTZ, einv_cancel_reason TEXT,
  UNIQUE (company_id, issuer, number));
CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), order_line_id INTEGER REFERENCES order_lines(id),
  ref_line_id INTEGER REFERENCES invoice_lines(id), variant_id INTEGER NOT NULL REFERENCES variants(id), description TEXT NOT NULL, hsn TEXT,
  base_qty INTEGER NOT NULL, uom TEXT NOT NULL, rate NUMERIC NOT NULL, taxable NUMERIC NOT NULL, gst_rate NUMERIC NOT NULL,
  cgst NUMERIC NOT NULL, sgst NUMERIC NOT NULL, igst NUMERIC NOT NULL, total NUMERIC NOT NULL);
CREATE TABLE IF NOT EXISTS targets (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), rep_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL, metric TEXT NOT NULL, target NUMERIC NOT NULL, UNIQUE (company_id, rep_id, month, metric));
CREATE TABLE IF NOT EXISTS visit_photos (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), visit_id INTEGER NOT NULL REFERENCES visits(id),
  file TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, caption TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS distributor_profiles (
  distributor_id INTEGER PRIMARY KEY REFERENCES users(id), company_id INTEGER NOT NULL REFERENCES companies(id),
  margin_pct NUMERIC, discount_pct NUMERIC NOT NULL DEFAULT 0, legal_name TEXT, gstin TEXT, state_code TEXT, address TEXT, city TEXT, pincode TEXT,
  invoice_prefix TEXT, credit_prefix TEXT, number_format TEXT, credit_days INTEGER, credit_limit NUMERIC);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), distributor_id INTEGER NOT NULL REFERENCES users(id),
  number TEXT, fy TEXT, status TEXT NOT NULL DEFAULT 'draft', notes TEXT, reject_reason TEXT, intra_state BOOLEAN,
  taxable NUMERIC NOT NULL DEFAULT 0, tax NUMERIC NOT NULL DEFAULT 0, total NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), submitted_at TIMESTAMPTZ, decided_at TIMESTAMPTZ, decided_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS po_lines (
  id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id),
  uom TEXT NOT NULL, qty_requested INTEGER NOT NULL, qty_approved INTEGER, qty_dispatched INTEGER NOT NULL DEFAULT 0, qty_received INTEGER NOT NULL DEFAULT 0,
  base_price NUMERIC NOT NULL, margin_pct NUMERIC NOT NULL, product_disc_pct NUMERIC NOT NULL, dist_disc_pct NUMERIC NOT NULL,
  computed_rate NUMERIC NOT NULL, rate NUMERIC NOT NULL, gst_rate NUMERIC NOT NULL, taxable NUMERIC NOT NULL, tax NUMERIC NOT NULL, total NUMERIC NOT NULL);
CREATE TABLE IF NOT EXISTS po_price_audit (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  old_rate NUMERIC NOT NULL, new_rate NUMERIC NOT NULL, reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS po_dispatches (
  id SERIAL PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), received_at TIMESTAMPTZ, received_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS po_dispatch_lines (
  id SERIAL PRIMARY KEY, dispatch_id INTEGER NOT NULL REFERENCES po_dispatches(id), po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  qty INTEGER NOT NULL, batch_no TEXT NOT NULL DEFAULT '', expiry TEXT);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), issuer TEXT NOT NULL, number TEXT NOT NULL, fy TEXT NOT NULL,
  shop_id INTEGER NOT NULL REFERENCES shops(id), pay_date TEXT NOT NULL, mode TEXT NOT NULL, reference TEXT, cheque_date TEXT, amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'cleared', bounce_reason TEXT, bounced_at TIMESTAMPTZ, collected_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (company_id, issuer, number));
CREATE TABLE IF NOT EXISTS payment_allocations (
  id SERIAL PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id), invoice_id INTEGER NOT NULL REFERENCES invoices(id), amount NUMERIC NOT NULL);
CREATE TABLE IF NOT EXISTS audit_templates (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, questions TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE);
CREATE TABLE IF NOT EXISTS audits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), visit_id INTEGER NOT NULL REFERENCES visits(id), template_id INTEGER NOT NULL REFERENCES audit_templates(id),
  rep_id INTEGER NOT NULL REFERENCES users(id), shop_id INTEGER NOT NULL REFERENCES shops(id), answers TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS audit_photos (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), audit_id INTEGER NOT NULL REFERENCES audits(id), question TEXT NOT NULL,
  file TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
`;

export function createPool(url = process.env.DATABASE_URL): Db {
  return new pg.Pool({ connectionString: url }) as unknown as Db;
}
export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) await db.query(stmt);
}
