// SPDX-License-Identifier: AGPL-3.0-only
// Ready-made report templates. Companies copy one and edit it; the copy is theirs. Add more by appending here.
import type { ReportDef } from "./engine.js";

type T = { key: string; name: string; description: string; def: Omit<ReportDef, "version" | "conditions" | "columns" | "compare" | "filters"> & Partial<ReportDef> };
const month = { dateRange: { preset: "this_month" } };
export const TEMPLATES: T[] = [
  { key: "sales_by_rep", name: "Sales by rep", description: "Order value, orders and outlets per sales rep, vs the previous period.",
    def: { source: "orders", filters: month, groupBy: ["rep"], metrics: [{ fn: "sum", field: "value" }, { fn: "count" }, { fn: "distinct", field: "outlet" }], view: { type: "bar" }, compare: "prev" } },
  { key: "sales_by_distributor", name: "Sales by distributor", description: "Order value per distributor.",
    def: { source: "orders", filters: month, groupBy: ["distributor"], metrics: [{ fn: "sum", field: "value" }, { fn: "count" }], view: { type: "bar" } } },
  { key: "sales_by_product", name: "Sales by product", description: "Quantity and value per product.",
    def: { source: "order_lines", filters: month, groupBy: ["product"], metrics: [{ fn: "sum", field: "qty" }, { fn: "sum", field: "value" }], view: { type: "table" }, sort: { by: "sum_value", dir: "desc" } } },
  { key: "sales_by_category", name: "Sales by category", description: "Share of order value per product category.",
    def: { source: "order_lines", filters: month, groupBy: ["category"], metrics: [{ fn: "sum", field: "value" }], view: { type: "pie" } } },
  { key: "daily_sales_trend", name: "Daily sales trend", description: "Order value per day, vs the same days last month.",
    def: { source: "orders", filters: { dateRange: { preset: "last_30" } }, groupBy: ["_day"], metrics: [{ fn: "sum", field: "value" }], view: { type: "line" }, compare: "prev" } },
  { key: "month_sales_kpi", name: "Sales this month", description: "One number: order value this month vs last month.",
    def: { source: "orders", filters: month, groupBy: [], metrics: [{ fn: "sum", field: "value" }], view: { type: "kpi" }, compare: "prev" } },
  { key: "visits_planned_vs_done", name: "Visits planned vs done", description: "Planned beat calls, visited and missed, per rep.",
    def: { source: "beat_plan", filters: { dateRange: { preset: "this_week" } }, groupBy: ["rep"], metrics: [{ fn: "sum", field: "planned" }, { fn: "sum", field: "visited" }, { fn: "sum", field: "missed" }], view: { type: "bar" } } },
  { key: "productive_calls", name: "Productive calls", description: "Visits and productive calls (an order was taken) per rep.",
    def: { source: "visits", filters: month, groupBy: ["rep"], metrics: [{ fn: "count", label: "Calls" }, { fn: "sum", field: "productive", label: "Productive calls" }], view: { type: "bar" } } },
  { key: "collections_ageing", name: "Collections ageing", description: "Unpaid invoice value by age bucket (0-30, 31-60, 61-90, 90+ days).",
    def: { source: "outstanding", filters: {}, groupBy: ["bucket"], metrics: [{ fn: "sum", field: "outstanding" }, { fn: "count", label: "Invoices" }], view: { type: "pie" }, sort: { by: "bucket", dir: "asc" } } },
  { key: "collections_by_mode", name: "Collections by mode", description: "Money collected by cash, UPI, cheque and NEFT.",
    def: { source: "collections", filters: month, groupBy: ["mode"], metrics: [{ fn: "sum", field: "amount" }], view: { type: "pie" } } },
  { key: "at_risk_shops", name: "At-risk outlets", description: "Outlets with no order in the last 30 days, longest gap first.",
    def: { source: "shops", filters: {}, groupBy: [], metrics: [], columns: ["outlet", "area", "distributor", "last_order", "days_since_order", "value_90d"],
      conditions: [{ field: "at_risk", op: "eq", value: "yes" }], sort: { by: "days_since_order", dir: "desc" }, view: { type: "table" } } },
];
export const templateDef = (t: T): ReportDef => ({ version: 1, columns: [], conditions: [], compare: "none", filters: {}, ...t.def } as ReportDef);
