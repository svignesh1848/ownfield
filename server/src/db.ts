import pg from "pg";
export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  user_limit INTEGER NOT NULL DEFAULT 10, created_at TIMESTAMP NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id), email TEXT NOT NULL,
  name TEXT NOT NULL, phone TEXT, role TEXT NOT NULL, password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE (company_id, email));
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), code TEXT NOT NULL,
  name TEXT NOT NULL, owner_name TEXT, phone TEXT, address TEXT, city TEXT, gstin TEXT,
  distributor_id INTEGER REFERENCES users(id),
  UNIQUE (company_id, code));
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), style TEXT NOT NULL,
  sku TEXT NOT NULL, size TEXT, hsn TEXT, mrp NUMERIC NOT NULL, billing_price NUMERIC NOT NULL,
  UNIQUE (company_id, sku));
CREATE TABLE IF NOT EXISTS beats (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL,
  rep_id INTEGER REFERENCES users(id), weekday INTEGER);
CREATE TABLE IF NOT EXISTS beat_shops (
  beat_id INTEGER NOT NULL REFERENCES beats(id), shop_id INTEGER NOT NULL REFERENCES shops(id), seq INTEGER NOT NULL,
  PRIMARY KEY (beat_id, shop_id));
CREATE TABLE IF NOT EXISTS visits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), rep_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id), check_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), in_lat NUMERIC, in_lng NUMERIC,
  check_out_at TIMESTAMPTZ, out_lat NUMERIC, out_lng NUMERIC, notes TEXT);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), client_ref TEXT NOT NULL,
  rep_id INTEGER NOT NULL REFERENCES users(id), shop_id INTEGER NOT NULL REFERENCES shops(id),
  distributor_id INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'placed', total NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (company_id, client_ref));
CREATE TABLE IF NOT EXISTS order_lines (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL, price NUMERIC NOT NULL);
`;

export function createPool(url = process.env.DATABASE_URL): Db {
  return new pg.Pool({ connectionString: url });
}
export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) await db.query(stmt);
}
