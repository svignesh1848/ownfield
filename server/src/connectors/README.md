# Connectors

Generic connector framework. The core never talks to a specific ERP; SAP, Odoo, Tally, Logic ERP and WMS are only
**presets** (`presets.ts`): a starting config plus a field mapping on top of a generic plugin.

| File | What it is |
|---|---|
| `types.ts` | The `ConnectorPlugin` interface |
| `mapping.ts` | No-code field mapping engine (rename, constant, date, number, lookup, upper/lower, template, nested line rules) |
| `records.ts` | Canonical FieldForce records that mappings read from, and the field lists shown in the mapper |
| `service.ts` | Runs connectors: queued event deliveries, schedules, pulls, inbound webhooks, file import/export |
| `registry.ts` | Loads every file in `plugins/` |
| `plugins/custom-rest.ts` | Any REST/JSON API, configured in the UI (auth: none / API key header / basic / bearer / OAuth2 client credentials) |
| `plugins/file.ts` | CSV / Excel / JSON import and export, optional server drop folder |
| `plugins/tally-xml.ts` | Tally XML vouchers |

## Add a connector by dropping one file

Create `plugins/my-system.ts`:

```ts
import type { ConnectorPlugin } from "../types.js";
const plugin: ConnectorPlugin = {
  type: "my-system", label: "My System", description: "Sends orders to My System",
  configFields: [{ key: "baseUrl", label: "Base URL", kind: "text" }, { key: "apiKey", label: "API key", kind: "secret" }, { key: "events", label: "Send on events", kind: "text" }],
  out: ["orders"], in: [],
  async send({ config, mapped, sample, fetchImpl }) {
    const request = { url: config.baseUrl + "/orders", body: mapped };
    if (sample) return { status: 0, request };            // sample mode: never call out
    const r = await fetchImpl(request.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Key": config.apiKey }, body: JSON.stringify(mapped) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);         // throwing = retry with backoff
    return { status: r.status };
  },
};
export default plugin;
```

Restart the server. It appears under Admin → Integrations → Connectors. `send` runs from the retrying delivery queue;
`pull` returns raw rows that the company mapping turns into FieldForce fields; `exportFile` renders mapped rows as a file.
Fields of kind `secret` are masked in the UI and API.
