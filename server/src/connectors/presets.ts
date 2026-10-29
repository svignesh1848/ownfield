// Preset mapping templates. A preset is only a starting config + field mapping on top of a generic plugin;
// the admin can change every field afterwards. All presets start in sample mode (no network calls).
import type { Mapping } from "./types.js";

export type Preset = { id: string; label: string; type: string; note: string; parked?: boolean; config: Record<string, any>; mapping: Mapping };

const customerIn = [
  { to: "external_id", from: "id" }, { to: "code", from: "ref" }, { to: "name", from: "name" }, { to: "phone", from: "phone" },
  { to: "city", from: "city" }, { to: "pincode", from: "zip" }, { to: "gstin", from: "vat" },
];
export const PRESETS: Preset[] = [
  {
    id: "odoo", label: "Odoo (JSON-RPC)", type: "custom-rest",
    note: "Pushes sale orders with execute_kw and pulls products. Set Base URL to your Odoo URL, and set db and uid in the endpoint config JSON and paste an Odoo API key.",
    config: {
      baseUrl: "https://odoo.example.com", authType: "none", apiKey: "", vars: { db: "sample-db", uid: 2 }, events: "order.created", scheduleMinutes: 0,
      endpoints: {
        orders: { method: "POST", path: "/jsonrpc", template: { jsonrpc: "2.0", method: "call", params: { service: "object", method: "execute_kw",
          args: ["{{config.db}}", "{{config.uid}}", "{{config.apiKey}}", "sale.order", "create", ["{{$mapped}}"]] } } },
        products: { method: "POST", path: "/jsonrpc", itemsPath: "result", template: { jsonrpc: "2.0", method: "call", params: { service: "object", method: "execute_kw",
          args: ["{{config.db}}", "{{config.uid}}", "{{config.apiKey}}", "product.product", "search_read", [[["sale_ok", "=", true]]], { fields: ["id", "default_code", "name", "list_price", "lst_price", "categ_id"], limit: 500 }] } },
          sample: [{ id: 101, default_code: "SAMPLE-ODOO-1", name: "Sample Odoo product", list_price: 120, lst_price: 100, categ_id: [1, "Sample"] }] },
      },
    },
    mapping: {
      orders: [
        { to: "partner_id", from: "customer.external_id", transform: "number" }, { to: "client_order_ref", from: "client_ref" },
        { to: "date_order", from: "created_at", transform: "date", format: "YYYY-MM-DD HH:mm:ss" }, { to: "note", value: "From FieldForce", transform: "constant" },
        { to: "order_line", from: "lines", each: [{ to: "0", value: 0, transform: "constant" }, { to: "1", value: 0, transform: "constant" },
          { to: "2.product_id", from: "product_external_id", transform: "number" }, { to: "2.product_uom_qty", from: "base_qty" }, { to: "2.price_unit", from: "price" }] },
      ],
      products: [{ to: "external_id", from: "id" }, { to: "sku", from: "default_code" }, { to: "name", from: "name" }, { to: "mrp", from: "list_price" }, { to: "price", from: "lst_price" }, { to: "category", from: "categ_id.1" }],
      customers: customerIn,
    },
  },
  {
    id: "sap", label: "SAP S/4HANA (OData, stub)", type: "custom-rest",
    note: "OData API_SALES_ORDER_SRV mapping. Stays in sample mode until you fill in your SAP gateway URL and auth; IDoc users can export the same mapping as JSON via a File connector.",
    config: {
      baseUrl: "https://sap.example.com", authType: "basic", events: "order.approved", scheduleMinutes: 0,
      endpoints: {
        orders: { method: "POST", path: "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder", template: "{{$mapped}}" },
        products: { method: "GET", path: "/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?$format=json&$top=500", itemsPath: "d.results",
          sample: [{ Product: "SAMPLE-SAP-1", ProductDescription: "Sample SAP material", ProductGroup: "SAMPLE", BaseUnit: "EA" }] },
      },
    },
    mapping: {
      orders: [
        { to: "SalesOrderType", value: "OR", transform: "constant" }, { to: "SalesOrganization", value: "1000", transform: "constant" },
        { to: "DistributionChannel", value: "10", transform: "constant" }, { to: "OrganizationDivision", value: "00", transform: "constant" },
        { to: "SoldToParty", from: "customer.external_id", default: "SAMPLE-CUST" }, { to: "PurchaseOrderByCustomer", from: "client_ref" },
        { to: "SalesOrderDate", from: "created_at", transform: "template", value: "/Date({{created_ms}})/" },
        { to: "to_Item.results", from: "lines", each: [{ to: "Material", from: "product_external_id", default: "SAMPLE-MAT" }, { to: "RequestedQuantity", from: "base_qty", transform: "template", value: "{{base_qty}}" }, { to: "RequestedQuantityUnit", from: "uom", transform: "lookup", table: { PCS: "EA", BOX: "BX", "*": "EA" } }] },
      ],
      products: [{ to: "external_id", from: "Product" }, { to: "sku", from: "Product" }, { to: "name", from: "ProductDescription" }, { to: "category", from: "ProductGroup" }, { to: "mrp", value: 1, transform: "constant" }, { to: "price", value: 1, transform: "constant" }],
    },
  },
  {
    id: "tally", label: "Tally (XML vouchers)", type: "tally-xml",
    note: "Download Sales / Receipt vouchers as XML and import them in Tally (Gateway > Import > Vouchers).",
    config: { company: "Sample Company" },
    mapping: {
      invoices: [{ to: "voucher_type", value: "Sales", transform: "constant" }, { to: "voucher_no", from: "number" }, { to: "date", from: "doc_date", transform: "date", format: "YYYYMMDD" },
        { to: "party", from: "customer.name" }, { to: "amount", from: "total" }, { to: "narration", transform: "template", value: "FieldForce invoice {{number}}" },
        { to: "lines", from: "lines", each: [{ to: "item", from: "description" }, { to: "qty", from: "base_qty" }, { to: "uom", from: "uom" }, { to: "rate", from: "rate" }, { to: "amount", from: "taxable" }] }],
      orders: [{ to: "voucher_type", value: "Sales Order", transform: "constant" }, { to: "voucher_no", from: "client_ref" }, { to: "date", from: "created_at", transform: "date", format: "YYYYMMDD" },
        { to: "party", from: "customer.name" }, { to: "amount", from: "total" },
        { to: "lines", from: "lines", each: [{ to: "item", from: "name" }, { to: "qty", from: "base_qty" }, { to: "uom", from: "uom" }, { to: "rate", from: "price" }, { to: "amount", from: "amount" }] }],
      collections: [{ to: "voucher_type", value: "Receipt", transform: "constant" }, { to: "voucher_no", from: "number" }, { to: "date", from: "pay_date", transform: "date", format: "YYYYMMDD" },
        { to: "party", from: "customer.name" }, { to: "amount", from: "amount" }, { to: "cash_ledger", from: "mode", transform: "lookup", table: { cash: "Cash", "*": "Bank" } }],
    },
  },
  {
    id: "logic-erp", label: "Logic ERP (export file, parked)", type: "file", parked: true,
    note: "Parked: no live calls. Download orders as CSV in a Logic ERP friendly column layout and import it on the Logic ERP side.",
    config: { format: "csv" },
    mapping: {
      orders: [{ to: "Bill No", from: "client_ref" }, { to: "Bill Date", from: "created_at", transform: "date", format: "DD/MM/YYYY" }, { to: "Party Code", from: "customer.code" },
        { to: "Party Name", from: "customer.name" }, { to: "items", from: "lines", each: [{ to: "Item Code", from: "sku" }, { to: "Qty", from: "base_qty" }, { to: "Rate", from: "price" }, { to: "Disc %", from: "discount_pct" }, { to: "Amount", from: "amount" }] }],
    },
  },
  {
    id: "wms", label: "Warehouse / WMS pick list", type: "custom-rest",
    note: "Sends a pick list to your WMS when an order is approved (accepted). Use a File connector with the same mapping if your WMS reads CSV.",
    config: { baseUrl: "https://wms.example.com", authType: "apikey", authHeader: "X-API-Key", events: "order.approved", scheduleMinutes: 0,
      endpoints: { orders: { method: "POST", path: "/picklists", template: "{{$mapped}}" } } },
    mapping: {
      orders: [{ to: "reference", from: "client_ref" }, { to: "ship_to.code", from: "customer.code" }, { to: "ship_to.name", from: "customer.name" }, { to: "ship_to.city", from: "customer.city" },
        { to: "warehouse", from: "distributor.external_id", default: "MAIN" }, { to: "lines", from: "lines", each: [{ to: "sku", from: "sku" }, { to: "qty", from: "base_qty" }, { to: "batch", from: "batch_no" }] }],
    },
  },
  {
    id: "csv", label: "Generic CSV / Excel", type: "file",
    note: "Plain files with FieldForce column names. Change the mapping to rename columns.",
    config: { format: "csv" }, mapping: {},
  },
];
