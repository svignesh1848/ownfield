// The connector plugin interface. Drop one file into plugins/ that default-exports a ConnectorPlugin and it shows up
// in the admin Integrations screen. See README.md in this folder.
import type { Rule } from "./mapping.js";

/** FieldForce entities a connector can send out (events / schedule / export) or take in (inbound webhook / file import). */
export type OutEntity = "orders" | "invoices" | "collections" | "stock";
export type InEntity = "products" | "stock" | "customers" | "distributors";
export type Mapping = Partial<Record<OutEntity | InEntity, Rule[]>>;

export type ConfigField = { key: string; label: string; kind: "text" | "secret" | "select" | "number" | "json" | "textarea"; options?: string[]; help?: string };

export type SendCtx = {
  config: Record<string, any>; entity: OutEntity; event: string;
  /** The record after the company's field mapping was applied. */
  mapped: Record<string, any>; record: Record<string, any>;
  /** true in sample mode: build the request but do not call the network. */
  sample: boolean; fetchImpl: typeof fetch;
};
export type SendResult = { status: number; request?: unknown; response?: string };
export type FileOut = { filename: string; contentType: string; body: string | Buffer };

export interface ConnectorPlugin {
  /** Stable id, saved in the database. Lowercase letters, digits and dashes. */
  type: string;
  label: string;
  description: string;
  configFields: ConfigField[];
  /** Entities it can send out and take in. */
  out: OutEntity[];
  in: InEntity[];
  /** File formats it can export (e.g. "csv", "xlsx", "json", "tally-xml"). */
  formats?: string[];
  /** Push one mapped record somewhere (REST call, queue ...). Called from the retrying delivery queue. Throw to retry. */
  send?(ctx: SendCtx): Promise<SendResult>;
  /** Fetch external records for an inbound entity (e.g. products from an ERP). Return raw rows; the mapping turns them into FieldForce fields. */
  pull?(ctx: { config: Record<string, any>; entity: InEntity; sample: boolean; fetchImpl: typeof fetch }): Promise<Record<string, any>[]>;
  /** Render a batch of mapped records as a file. */
  exportFile?(ctx: { entity: OutEntity | InEntity; rows: Record<string, any>[]; format: string; config: Record<string, any> }): FileOut;
}
