import fs from "node:fs";
import * as XLSX from "xlsx";
import { TEMPLATES } from "../src/templates.ts";
for (const [id, t] of Object.entries(TEMPLATES)) {
  const dir = new URL(`../../sample-data/${id}`, import.meta.url).pathname; fs.mkdirSync(dir, { recursive: true });
  for (const k of ["shops", "products", "stock"] as const) if (t.sample[k].length)
    fs.writeFileSync(`${dir}/sample-${k}.csv`, XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(t.sample[k])) + "\n");
}
