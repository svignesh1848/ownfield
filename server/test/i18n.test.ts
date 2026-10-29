// Every language: valid file, only known keys, same {0} placeholders, and every English key resolves
// (missing ones fall back to English). Also checks that every t("…") in the web app is in en.json.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LANGS, RTL, SCRIPT, translateWith } from "../../web/src/i18n";

const dir = path.resolve(__dirname, "../../web/src/locales");
const en: Record<string, string> = JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"));
const ph = (s: string) => (s.match(/\{\d+\}/g) || []).sort().join(",");

describe("i18n", () => {
  it("has English + the 22 Eighth Schedule languages, RTL for Urdu, Kashmiri, Sindhi", () => {
    expect(Object.keys(LANGS)).toHaveLength(23);
    expect([...RTL].sort()).toEqual(["ks", "sd", "ur"]);
    for (const l of Object.keys(LANGS)) if (l !== "en") expect(SCRIPT[l], l).toBeTruthy();
  });
  for (const l of Object.keys(LANGS).filter(l => l !== "en")) it(`${l}: file is complete after English fallback`, () => {
    const d: Record<string, string> = JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), "utf8"));
    for (const [k, v] of Object.entries(d)) {
      expect(k in en, `${l}: unknown key "${k}"`).toBe(true);
      expect(typeof v === "string" && v.trim().length > 0, `${l}: empty "${k}"`).toBe(true);
      expect(ph(v), `${l}: placeholders in "${k}"`).toBe(ph(k));
    }
    for (const k of Object.keys(en)) expect(translateWith(d, k).length, `${l}: "${k}"`).toBeGreaterThan(0);
    expect(translateWith(d, "__missing__ {0}", 5)).toBe("__missing__ 5");
  });
  it("every t(\"…\") string in the web app is in en.json", () => {
    const src = path.resolve(__dirname, "../../web/src");
    const missing: string[] = [];
    for (const f of fs.readdirSync(src).filter(f => /\.tsx?$/.test(f))) {
      for (const m of fs.readFileSync(path.join(src, f), "utf8").matchAll(/\b(?:t|i18n)\("((?:[^"\\]|\\.)*)"/g)) {
        const k = JSON.parse(`"${m[1]}"`); if (/[A-Za-z]/.test(k) && !(k in en)) missing.push(`${f}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
