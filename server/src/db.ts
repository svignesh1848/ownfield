import pg from "pg";
export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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
  name TEXT NOT NULL, owner_name TEXT, phone TEXT, address TEXT, city TEXT, gstin TEXT, drug_licence TEXT, custom TEXT,
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
  min_qty INTEGER NOT NULL DEFAULT 1, discount_pct NUMERIC NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE);
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
  distributor_id INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'placed', total NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (company_id, client_ref));
CREATE TABLE IF NOT EXISTS order_lines (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), variant_id INTEGER NOT NULL REFERENCES variants(id),
  uom TEXT NOT NULL, qty INTEGER NOT NULL, base_qty INTEGER NOT NULL, price NUMERIC NOT NULL,
  discount_pct NUMERIC NOT NULL DEFAULT 0, amount NUMERIC NOT NULL);
CREATE TABLE IF NOT EXISTS order_allocations (
  id SERIAL PRIMARY KEY, order_line_id INTEGER NOT NULL REFERENCES order_lines(id), stock_id INTEGER NOT NULL REFERENCES stock(id),
  batch_no TEXT, expiry TEXT, qty INTEGER NOT NULL);
`;

export function createPool(url = process.env.DATABASE_URL): Db {
  return new pg.Pool({ connectionString: url });
}
export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) await db.query(stmt);
}
