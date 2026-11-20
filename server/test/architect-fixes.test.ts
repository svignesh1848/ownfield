// Regression tests for the architect review fixes: SSRF guard for IPv4 hidden in IPv6 forms, and the OAuth2
// token request of the custom REST connector never following redirects (which could reach internal addresses).
import { describe, it, expect } from "vitest";
import { checkUrl } from "../src/integrations/webhooks.js";
import plugin from "../src/connectors/plugins/custom-rest.js";

describe("checkUrl: private addresses hidden in IPv6 forms", () => {
  for (const u of ["https://[::ffff:a9fe:a9fe]/x", "https://[::ffff:169.254.169.254]/x", "https://[::ffff:7f00:1]/x", "https://[::a9fe:a9fe]/x",
    "https://[64:ff9b::a9fe:a9fe]/x", "https://[::1]/x", "https://[fe80::1]/x", "https://[fd00:ec2::254]/x", "https://169.254.169.254/x", "https://127.0.0.1/x"])
    it(`refuses ${u}`, async () => { expect(await checkUrl(u, true)).toMatch(/Private/); });
  it("allows a public IPv4 / IPv6 literal", async () => {
    expect(await checkUrl("https://8.8.8.8/hook", true)).toBeNull();
    expect(await checkUrl("https://[2001:4860:4860::8888]/hook", true)).toBeNull();
  });
});

describe("custom REST connector: OAuth2 token request", () => {
  it("does not follow redirects", async () => {
    const calls: { url: string; init: any }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: "t1", expires_in: 300 }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const config = { baseUrl: "https://8.8.8.8/api", authType: "oauth2", tokenUrl: "https://8.8.4.4/token", clientId: "redirect-test", clientSecret: "s",
      endpoints: { orders: { method: "POST", path: "/orders" } } };
    await plugin.send!({ config, entity: "orders", event: "order.created", mapped: {}, record: {}, sample: false, fetchImpl: fake } as any);
    const tok = calls.find(c => c.url.includes("/token"))!;
    expect(tok.init.redirect).toBe("manual");
    expect(calls.every(c => c.init.redirect === "manual")).toBe(true);
  });
});
