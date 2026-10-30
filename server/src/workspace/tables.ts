// SPDX-License-Identifier: AGPL-3.0-only
// Developer Data Workspace: the tables (as company-scoped views) a company's own analysts may query with SQL.
// Each entry becomes a view ff_c<companyId>.<name> that only returns that company's rows. Secret columns
// (password hashes, TOTP secrets, API keys, webhook secrets, connector configs, file paths) are never exposed.
// To expose a new table or column: add it here, add a doc line, and add a test in server/test/workspace.test.ts.
export type WsTable = { doc: string; cols: Record<string, string>; from?: string; alias?: string; where?: string };
const scoped = (doc: string, cols: Record<string, string>): WsTable => ({ doc, cols });
export const WS_TABLES: Record<string, WsTable> = {
  orders: scoped("Orders (header). created_at is a timestamp (UTC).", { id: "Order id", client_ref: "App reference", rep_id: "→ users.id", shop_id: "→ shops.id", distributor_id: "→ users.id (null = company)", status: "placed / accepted / rejected / dispatched / delivered…", total: "Order value", savings: "Discount given", created_at: "When placed", van_load_id: "→ van load" }),
  order_lines: { doc: "Products in each order.", alias: "l", from: "public.order_lines l JOIN public.orders p ON p.id=l.order_id", where: "p.company_id",
    cols: { id: "Line id", order_id: "→ orders.id", variant_id: "→ variants.id", uom: "Unit", qty: "Qty in unit", base_qty: "Qty in base units", price: "Price", discount_pct: "Discount %", amount: "Line value", gross: "Before discount", scheme_id: "→ schemes.id", free: "Free item" } },
  shops: scoped("Outlets.", { id: "Outlet id", code: "Outlet code", name: "Name", owner_name: "Owner", phone: "Phone", city: "City / area", pincode: "PIN", state_code: "GST state code", gstin: "GSTIN", outlet_type: "Type", distributor_id: "→ users.id", credit_days: "Credit days", credit_limit: "Credit limit", lat: "Latitude", lng: "Longitude" }),
  users: scoped("People (no passwords or secrets).", { id: "User id", name: "Name", email: "Email", phone: "Phone", role: "company_admin / manager / sales_rep / distributor / retailer", active: "Active" }),
  items: scoped("Products.", { id: "Product id", code: "Code", name: "Name", category: "Category", kind: "goods / service", hsn: "HSN" }),
  variants: scoped("Product variants (SKUs).", { id: "Variant id", item_id: "→ items.id", sku: "SKU", attrs: "Attributes (JSON text)", mrp: "MRP", billing_price: "Billing price", barcode: "Barcode" }),
  stock: scoped("Current stock by location and batch.", { id: "Row id", distributor_id: "→ users.id (null = company)", variant_id: "→ variants.id", batch_no: "Batch", expiry: "Expiry", qty: "Qty (base units)" }),
  beats: scoped("Beat plans.", { id: "Beat id", name: "Name", rep_id: "→ users.id", weekday: "0 = Sunday … 6 = Saturday, null = every working day" }),
  beat_shops: { doc: "Outlets in each beat.", alias: "x", from: "public.beat_shops x JOIN public.beats p ON p.id=x.beat_id", where: "p.company_id", cols: { beat_id: "→ beats.id", shop_id: "→ shops.id", seq: "Order in route" } },
  visits: scoped("Outlet visits.", { id: "Visit id", rep_id: "→ users.id", shop_id: "→ shops.id", check_in_at: "Check-in time", check_out_at: "Check-out time", no_order_reason: "Reason if no order", notes: "Notes" }),
  rep_days: scoped("Attendance (work day start/end).", { id: "Row id", rep_id: "→ users.id", day: "YYYY-MM-DD", start_at: "Start", end_at: "End" }),
  invoices: scoped("Invoices and credit notes (kind).", { id: "Id", issuer: "company or distributor", kind: "invoice / credit_note", number: "Number", doc_date: "YYYY-MM-DD", order_id: "→ orders.id", ref_invoice_id: "Credit note → invoice", shop_id: "→ shops.id", reason: "Credit note reason", taxable: "Taxable value", cgst: "CGST", sgst: "SGST", igst: "IGST", total: "Total" }),
  invoice_lines: { doc: "Invoice lines.", alias: "l", from: "public.invoice_lines l JOIN public.invoices p ON p.id=l.invoice_id", where: "p.company_id",
    cols: { id: "Line id", invoice_id: "→ invoices.id", variant_id: "→ variants.id", description: "Description", hsn: "HSN", base_qty: "Qty", rate: "Rate", taxable: "Taxable", gst_rate: "GST %", total: "Total" } },
  payments: scoped("Payments received.", { id: "Id", issuer: "company or distributor", number: "Receipt no.", shop_id: "→ shops.id", pay_date: "YYYY-MM-DD", mode: "cash / upi / cheque / neft", amount: "Amount", status: "cleared / bounced", collected_by: "→ users.id" }),
  payment_allocations: { doc: "Which invoices each payment paid.", alias: "a", from: "public.payment_allocations a JOIN public.payments p ON p.id=a.payment_id", where: "p.company_id", cols: { payment_id: "→ payments.id", invoice_id: "→ invoices.id", amount: "Amount" } },
  targets: scoped("Monthly targets.", { rep_id: "→ users.id", month: "YYYY-MM", metric: "Metric", target: "Target" }),
  schemes: scoped("Offers and schemes.", { id: "Id", name: "Name", type: "Type", item_id: "→ items.id", category: "Category", discount_pct: "Discount %", active: "Active", starts_on: "Start", ends_on: "End" }),
  expenses: scoped("Expense claims.", { id: "Id", rep_id: "→ users.id", spent_on: "Date", amount: "Amount", category: "Category", status: "pending / approved / rejected" }),
  leaves: scoped("Leave requests.", { id: "Id", rep_id: "→ users.id", from_date: "From", to_date: "To", kind: "Kind", status: "Status" }),
  leads: scoped("Leads.", { id: "Id", name: "Name", kind: "Kind", city: "City", source: "Source", status: "Status", assigned_to: "→ users.id", shop_id: "→ shops.id when converted", created_at: "Created" }),
  claims: scoped("Distributor claims.", { id: "Id", distributor_id: "→ users.id", kind: "Kind", amount: "Amount", approved_amount: "Approved", status: "Status", created_at: "Created" }),
  purchase_orders: scoped("Distributor purchase orders.", { id: "Id", distributor_id: "→ users.id", number: "Number", status: "Status", total: "Total", created_at: "Created" }),
};
