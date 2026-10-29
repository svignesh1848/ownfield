// Industry templates. Each one presets features, variant attributes, units and custom fields.
// Everything stays editable per company afterwards. All sample data is fictitious and labelled "Sample".
export const FEATURE_KEYS = ["stock", "batches", "sizeGrid", "gps", "schemes", "drugLicence", "services", "photos", "invoicing", "purchaseOrders", "distributorBilling", "eInvoice", "audits"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;
export const FIELD_TYPES = ["text", "number", "date", "select"] as const;
export type CustomField = { key: string; label: string; type: (typeof FIELD_TYPES)[number]; options?: string[]; required?: boolean };
export const ENTITIES = ["outlet", "product", "visit"] as const;
export type Uom = { code: string; factor: number }; // factor = base units per unit; the base unit has factor 1
export type Gst = { legalName: string; gstin: string; stateCode: string; address: string; city?: string; pincode?: string; defaultRate: number; hsnRates: { prefix: string; rate: number }[];
  invoicePrefix: string; creditPrefix: string; numberFormat: string };
export type PoPricing = { priceBase: "billing" | "mrp"; marginPct: number; productDiscounts: { scope: "item" | "category"; key: string; pct: number }[]; numberFormat: string };
export type Settings = { features: Features; attributes: string[]; uoms: Uom[]; customFields: Record<(typeof ENTITIES)[number], CustomField[]>; gst: Gst; po: PoPricing; credit: Credit; einvoice: { provider: "test" | "gsp" } };
export type Credit = { days: number; limit: number; onBreach: "warn" | "block" };
export const INDUSTRIES = ["apparel", "fmcg", "pharma", "retail", "services", "custom"] as const;
export type Industry = (typeof INDUSTRIES)[number];
type Row = Record<string, string | number>;
type Template = { label: string; description: string; settings: Omit<Settings, "gst" | "po" | "credit" | "einvoice">; sample: { shops: Row[]; products: Row[]; stock: Row[] } };

const F = (on: FeatureKey[]): Features => Object.fromEntries(FEATURE_KEYS.map(k => [k, on.includes(k)])) as Features;
const sel = (key: string, label: string, options: string[], required = false): CustomField => ({ key, label, type: "select", options, required });
const fld = (key: string, label: string, type: CustomField["type"], required = false): CustomField => ({ key, label, type, required });
const shops = (extra: (i: number) => Row = () => ({})) => ["Chennai", "Coimbatore", "Madurai"].map((city, i) =>
  ({ Code: `SAMPLE-OUT-${i + 1}`, Name: `Sample Outlet ${i + 1}`, "Owner Name": "Sample Owner", Phone: `90000000${10 + i}`, City: city, "State Code": "33", ...extra(i) }));

export const TEMPLATES: Record<Industry, Template> = {
  apparel: {
    label: "Apparel / Kidswear", description: "Styles with size × colour variants, size-grid ordering, schemes.",
    settings: { features: F(["sizeGrid", "gps", "schemes", "photos", "invoicing", "purchaseOrders"]), attributes: ["size", "colour"], uoms: [{ code: "PCS", factor: 1 }, { code: "BOX", factor: 6 }],
      customFields: { outlet: [sel("store_type", "Store type", ["Kids store", "Multi-brand", "Department store"])],
        product: [fld("fabric", "Fabric", "text"), sel("season", "Season", ["SS", "AW"])], visit: [sel("display_ok", "Display OK", ["Yes", "No"])] } },
    sample: {
      shops: shops(i => ({ "Store type": ["Kids store", "Multi-brand", "Department store"][i] })),
      products: [
        ...["2Y", "3Y", "4Y"].flatMap(size => ["Red", "Blue"].map(colour => ({ "Item Code": "SAMPLE-TEE", "Item Name": "Sample Crew Tee", Category: "Tops", HSN: "6109",
          SKU: `STEE-${size}-${colour.toUpperCase()}`, Size: size, Colour: colour, MRP: 399, "Billing Price": 280, Fabric: "Cotton", Season: "SS" }))),
        ...["0-3M", "3-6M", "6-12M"].map(size => ({ "Item Code": "SAMPLE-ROMPER", "Item Name": "Sample Romper", Category: "Infant", HSN: "6111",
          SKU: `SROM-${size}`, Size: size, Colour: "White", MRP: 599, "Billing Price": 420, Fabric: "Cotton", Season: "AW" })) ],
      stock: [] } },
  fmcg: {
    label: "FMCG", description: "Pack size / flavour variants, piece-box-case units, stock tracking, schemes.",
    settings: { features: F(["stock", "gps", "schemes", "photos", "invoicing", "purchaseOrders"]), attributes: ["pack_size", "flavour"], uoms: [{ code: "PCS", factor: 1 }, { code: "BOX", factor: 12 }, { code: "CASE", factor: 144 }],
      customFields: { outlet: [sel("outlet_class", "Outlet class", ["A", "B", "C"])], product: [fld("shelf_life_days", "Shelf life days", "number")],
        visit: [fld("competitor_activity", "Competitor activity", "text")] } },
    sample: {
      shops: shops(i => ({ "Outlet class": ["A", "B", "C"][i] })),
      products: [
        { "Item Code": "SAMPLE-BISCUIT", "Item Name": "Sample Glucose Biscuits", Category: "Biscuits", HSN: "1905", SKU: "SBIS-100G", "Pack Size": "100g", Flavour: "Classic", MRP: 10, "Billing Price": 8.5, Units: "PCS=1|BOX=24|CASE=96", "Shelf life days": 180 },
        { "Item Code": "SAMPLE-BISCUIT", "Item Name": "Sample Glucose Biscuits", Category: "Biscuits", HSN: "1905", SKU: "SBIS-250G", "Pack Size": "250g", Flavour: "Classic", MRP: 30, "Billing Price": 25, Units: "PCS=1|BOX=12|CASE=48", "Shelf life days": 180 },
        { "Item Code": "SAMPLE-DRINK", "Item Name": "Sample Mango Drink", Category: "Beverages", HSN: "2202", SKU: "SDRK-200ML", "Pack Size": "200ml", Flavour: "Mango", MRP: 20, "Billing Price": 16, Units: "PCS=1|CASE=30", "Shelf life days": 120 } ],
      stock: [{ SKU: "SBIS-100G", Qty: 20, Unit: "CASE" }, { SKU: "SBIS-250G", Qty: 10, Unit: "CASE" }, { SKU: "SDRK-200ML", Qty: 15, Unit: "CASE" }] } },
  pharma: {
    label: "Pharma", description: "Strength / form variants, strip-box units, batch + expiry with FEFO, drug licence numbers.",
    settings: { features: F(["stock", "batches", "gps", "drugLicence", "photos", "invoicing", "purchaseOrders"]), attributes: ["strength", "form"], uoms: [{ code: "STRIP", factor: 1 }, { code: "BOX", factor: 10 }],
      customFields: { outlet: [sel("chemist_type", "Chemist type", ["Retail", "Hospital", "Wholesale"])],
        product: [sel("schedule", "Schedule", ["OTC", "H", "H1"]), fld("composition", "Composition", "text")],
        visit: [fld("doctor_met", "Doctor met", "text"), fld("next_visit", "Next visit", "date")] } },
    sample: {
      shops: shops(i => ({ "Chemist type": ["Retail", "Hospital", "Wholesale"][i], "Drug Licence": `SAMPLE-DL-${1001 + i}` })),
      products: [
        { "Item Code": "SAMPLE-PARA", "Item Name": "Sample Paracetamol Tablets", Category: "Analgesic", HSN: "3004", SKU: "SPARA-500", Strength: "500mg", Form: "Tablet", MRP: 30, "Billing Price": 22, Schedule: "OTC", Composition: "Paracetamol (sample)" },
        { "Item Code": "SAMPLE-PARA", "Item Name": "Sample Paracetamol Tablets", Category: "Analgesic", HSN: "3004", SKU: "SPARA-650", Strength: "650mg", Form: "Tablet", MRP: 35, "Billing Price": 26, Schedule: "OTC", Composition: "Paracetamol (sample)" },
        { "Item Code": "SAMPLE-SYRUP", "Item Name": "Sample Cough Syrup", Category: "Respiratory", HSN: "3004", SKU: "SSYR-100ML", Strength: "100ml", Form: "Syrup", MRP: 110, "Billing Price": 85, Units: "BOTTLE=1|BOX=20", Schedule: "H", Composition: "Sample composition" } ],
      stock: [
        { SKU: "SPARA-500", Batch: "SB-EXPIRED", Expiry: "2026-01-31", Qty: 50, Unit: "STRIP" },
        { SKU: "SPARA-500", Batch: "SB-0127", Expiry: "2027-01-31", Qty: 30, Unit: "STRIP" },
        { SKU: "SPARA-500", Batch: "SB-0627", Expiry: "2027-06-30", Qty: 20, Unit: "BOX" },
        { SKU: "SPARA-650", Batch: "SB-0927", Expiry: "2027-09-30", Qty: 10, Unit: "BOX" },
        { SKU: "SSYR-100ML", Batch: "SB-SY01", Expiry: "2027-03-31", Qty: 5, Unit: "BOX" } ] } },
  retail: {
    label: "Retail / Consumer durables", description: "Model / colour variants, serial-free stock tracking, schemes.",
    settings: { features: F(["stock", "gps", "schemes", "photos", "invoicing", "purchaseOrders"]), attributes: ["model", "colour"], uoms: [{ code: "PCS", factor: 1 }],
      customFields: { outlet: [fld("showroom_sqft", "Showroom sqft", "number")], product: [fld("warranty_months", "Warranty months", "number")], visit: [fld("demo_units", "Demo units on display", "number")] } },
    sample: {
      shops: shops(i => ({ "Showroom sqft": [800, 1500, 2500][i] })),
      products: [
        { "Item Code": "SAMPLE-AC", "Item Name": "Sample 1.5T Split AC", Category: "Cooling", HSN: "8415", SKU: "SAC-15-WH", Model: "SAC-15", Colour: "White", MRP: 42000, "Billing Price": 36500, "Warranty months": 12 },
        { "Item Code": "SAMPLE-TV", "Item Name": "Sample 32in LED TV", Category: "Television", HSN: "8528", SKU: "STV-32-BK", Model: "STV-32", Colour: "Black", MRP: 18000, "Billing Price": 15200, "Warranty months": 24 } ],
      stock: [{ SKU: "SAC-15-WH", Qty: 12 }, { SKU: "STV-32-BK", Qty: 25 }] } },
  services: {
    label: "Services", description: "Non-stock service items (service visit, AMC), plans as variants, visit reports.",
    settings: { features: F(["gps", "services", "photos", "invoicing"]), attributes: ["plan"], uoms: [{ code: "UNIT", factor: 1 }],
      customFields: { outlet: [fld("contract_end", "Contract end", "date")], product: [fld("sla_hours", "SLA hours", "number")],
        visit: [fld("work_done", "Work done", "text", true), sel("customer_rating", "Customer rating", ["1", "2", "3", "4", "5"])] } },
    sample: {
      shops: shops(i => ({ "Contract end": ["2027-03-31", "2027-06-30", "2026-12-31"][i] })),
      products: [
        { "Item Code": "SAMPLE-AMC", "Item Name": "Sample Annual Maintenance Contract", Type: "service", Category: "AMC", HSN: "998719", SKU: "SAMC-BASIC", Plan: "Basic", MRP: 5000, "Billing Price": 4500, "SLA hours": 48 },
        { "Item Code": "SAMPLE-AMC", "Item Name": "Sample Annual Maintenance Contract", Type: "service", Category: "AMC", HSN: "998719", SKU: "SAMC-PREMIUM", Plan: "Premium", MRP: 9000, "Billing Price": 8000, "SLA hours": 8 },
        { "Item Code": "SAMPLE-VISIT", "Item Name": "Sample Service Visit", Type: "service", Category: "Visit", HSN: "998719", SKU: "SVIS-STD", Plan: "Standard", "Billing Price": 750, "SLA hours": 24 } ],
      stock: [] } },
  custom: {
    label: "Custom", description: "Start minimal and configure everything yourself.",
    settings: { features: F(["gps", "photos", "invoicing"]), attributes: ["variant"], uoms: [{ code: "UNIT", factor: 1 }], customFields: { outlet: [], product: [], visit: [] } },
    sample: { shops: shops(), products: [{ "Item Code": "SAMPLE-ITEM", "Item Name": "Sample Item", SKU: "SITEM-STD", Variant: "Standard", MRP: 100, "Billing Price": 80 }], stock: [] } },
};

// SAMPLE GST rates only — every company must verify rates for its own HSN/SAC codes with its tax advisor.
const SAMPLE_RATES: Record<Industry, [number, { prefix: string; rate: number }[]]> = {
  apparel: [5, [{ prefix: "61", rate: 5 }, { prefix: "62", rate: 5 }]], fmcg: [18, [{ prefix: "1905", rate: 18 }, { prefix: "2202", rate: 18 }]],
  pharma: [5, [{ prefix: "3004", rate: 5 }]], retail: [18, [{ prefix: "8415", rate: 18 }, { prefix: "8528", rate: 18 }]],
  services: [18, [{ prefix: "9987", rate: 18 }]], custom: [18, []],
};
export const defaultGst = (ind: Industry): Gst => ({ legalName: "", gstin: "", stateCode: "", address: "", defaultRate: SAMPLE_RATES[ind][0],
  hsnRates: SAMPLE_RATES[ind][1], invoicePrefix: "INV", creditPrefix: "CN", numberFormat: "{prefix}/{fy}/{seq:4}" });
const asIndustry = (ind: string): Industry => (INDUSTRIES as readonly string[]).includes(ind) ? (ind as Industry) : "custom";
export const templateSettings = (ind: string): Settings =>
  ({ ...JSON.parse(JSON.stringify(TEMPLATES[asIndustry(ind)].settings)), gst: defaultGst(asIndustry(ind)),
     po: { priceBase: "billing", marginPct: 0, productDiscounts: [], numberFormat: "{prefix}/{fy}/{seq:4}" }, credit: { days: 0, limit: 0, onBreach: "warn" }, einvoice: { provider: "test" } });
/** Fill keys added in later versions (new features, gst) from the industry template. */
export const withDefaults = (ind: string, s: Partial<Settings>): Settings => {
  const t = templateSettings(ind);
  return { ...t, ...s, features: { ...t.features, ...(s.features || {}) }, gst: { ...t.gst, ...(s.gst || {}) }, po: { ...t.po, ...(s.po || {}) }, credit: { ...t.credit, ...(s.credit || {}) }, einvoice: { ...t.einvoice, ...(s.einvoice || {}) } } as Settings;
};
