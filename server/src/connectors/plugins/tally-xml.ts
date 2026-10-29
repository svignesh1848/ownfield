// Tally: XML vouchers (Sales for orders/invoices, Receipt for collections) to import via Tally's XML import / ODBC port.
// File export only; mapped fields expected: voucher_type, voucher_no, date (YYYYMMDD), party, narration, amount, lines[] {item, qty, uom, rate, amount}, sales_ledger.
import type { ConnectorPlugin } from "../types.js";

const x = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (v: unknown) => (Math.round(Number(v || 0) * 100) / 100).toFixed(2);
export function tallyXml(rows: Record<string, any>[], company = "") {
  const vouchers = rows.map(r => {
    const type = r.voucher_type || "Sales";
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const inv = lines.map((l: any) => `
     <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${x(l.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <RATE>${amt(l.rate)}/${x(l.uom || "Nos")}</RATE><AMOUNT>${amt(l.amount)}</AMOUNT><ACTUALQTY>${x(l.qty)} ${x(l.uom || "Nos")}</ACTUALQTY><BILLEDQTY>${x(l.qty)} ${x(l.uom || "Nos")}</BILLEDQTY>
      <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${x(r.sales_ledger || "Sales")}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(l.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`).join("");
    const counter = type === "Receipt" ? `
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(r.cash_ledger || "Cash")}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(r.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>` : "";
    return `
   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="${x(type)}" ACTION="Create">
     <DATE>${x(r.date)}</DATE><VOUCHERTYPENAME>${x(type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${x(r.voucher_no)}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${x(r.party)}</PARTYLEDGERNAME><NARRATION>${x(r.narration)}</NARRATION>${inv}
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(r.party)}</LEDGERNAME><ISDEEMEDPOSITIVE>${type === "Receipt" ? "No" : "Yes"}</ISDEEMEDPOSITIVE><AMOUNT>${type === "Receipt" ? "" : "-"}${amt(r.amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>${counter}
    </VOUCHER>
   </TALLYMESSAGE>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA>
  <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${x(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
  <REQUESTDATA>${vouchers}
  </REQUESTDATA>
 </IMPORTDATA></BODY>
</ENVELOPE>
`;
}

const plugin: ConnectorPlugin = {
  type: "tally-xml",
  label: "Tally XML vouchers",
  description: "Export orders, invoices or collections as Tally XML vouchers for import into Tally.",
  configFields: [{ key: "company", label: "Tally company name", kind: "text" }],
  out: ["orders", "invoices", "collections"],
  in: [],
  formats: ["tally-xml"],
  exportFile({ entity, rows, config }) {
    return { filename: `tally-${entity}-${new Date().toISOString().slice(0, 10)}.xml`, contentType: "application/xml", body: tallyXml(rows, config.company) };
  },
};
export default plugin;
