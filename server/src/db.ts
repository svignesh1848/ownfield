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
  UNIQUE (company_id, code));
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), style TEXT NOT NULL,
  sku TEXT NOT NULL, size TEXT, hsn TEXT, mrp NUMERIC NOT NULL, billing_price NUMERIC NOT NULL,
  UNIQUE (company_id, sku));
`;

export function createPool(url = process.env.DATABASE_URL): Db {
  return new pg.Pool({ connectionString: url });
}
export async function migrate(db: Db) {
  for (const stmt of SCHEMA.split(";").map(s => s.trim()).filter(Boolean)) await db.query(stmt);
}
