import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../deploy");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

describe("WAF-lite config in the repo", () => {
  it("rate-limits auth and general traffic and blocks probe paths, with no host addresses", () => {
    const http = read("nginx/ownfield-waf-http.conf");
    const srv = read("nginx/ownfield-waf-server.conf");
    const jail = read("fail2ban/ownfield.local");
    const filter = read("fail2ban/ownfield-login.conf");
    expect(http).toMatch(/limit_req_zone.*ownfield_login/);
    expect(http).toMatch(/limit_req_zone.*ownfield_general/);
    expect(http).toContain("^/api/auth/");
    expect(srv).toContain("limit_req zone=ownfield_login");
    expect(srv).toContain("limit_req zone=ownfield_general");
    for (const p of [".env", ".git", "wp-admin", "phpmyadmin", "\\.\\./"]) expect(srv).toContain(p);
    expect(filter).toContain("/api/auth/");
    expect(filter).toContain("401|429");
    expect(jail).toMatch(/\[sshd\]/);
    expect(jail).toMatch(/\[ownfield-login\]/);
    const all = (http + srv + jail + filter).replaceAll("127.0.0.1", "").replaceAll("::1", "");
    expect(all).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});
