// i18n: English text is the key (and the fallback). Each language lives in ./locales/<code>.json and is
// loaded on demand, so only the chosen language (and its Noto font) is downloaded. The choice is stored on
// the phone (localStorage "ff-lang"). Missing keys fall back to English. See ./locales/README.md.

/** English + the 22 languages of the Eighth Schedule, each shown in its own script. */
export const LANGS: Record<string, string> = {
  en: "English", as: "অসমীয়া", bn: "বাংলা", brx: "बड़ो", doi: "डोगरी", gu: "ગુજરાતી", hi: "हिन्दी", kn: "ಕನ್ನಡ",
  ks: "کٲشُر", kok: "कोंकणी", mai: "मैथिली", ml: "മലയാളം", mni: "ꯃꯤꯇꯩꯂꯣꯟ", mr: "मराठी", ne: "नेपाली", or: "ଓଡ଼ିଆ",
  pa: "ਪੰਜਾਬੀ", sa: "संस्कृतम्", sat: "ᱥᱟᱱᱛᱟᱲᱤ", sd: "سنڌي", ta: "தமிழ்", te: "తెలుగు", ur: "اردو",
};
export const RTL = new Set(["ur", "ks", "sd"]);
/** Script of each language → lazily loaded Noto font (self-hosted; the CSP allows only 'self' fonts). */
const FONTS: Record<string, [string, () => Promise<unknown>]> = {
  deva: ["Noto Sans Devanagari", () => import("@fontsource/noto-sans-devanagari/devanagari-400.css")],
  beng: ["Noto Sans Bengali", () => import("@fontsource/noto-sans-bengali/bengali-400.css")],
  gujr: ["Noto Sans Gujarati", () => import("@fontsource/noto-sans-gujarati/gujarati-400.css")],
  guru: ["Noto Sans Gurmukhi", () => import("@fontsource/noto-sans-gurmukhi/gurmukhi-400.css")],
  orya: ["Noto Sans Oriya", () => import("@fontsource/noto-sans-oriya/oriya-400.css")],
  taml: ["Noto Sans Tamil", () => import("@fontsource/noto-sans-tamil/tamil-400.css")],
  telu: ["Noto Sans Telugu", () => import("@fontsource/noto-sans-telugu/telugu-400.css")],
  knda: ["Noto Sans Kannada", () => import("@fontsource/noto-sans-kannada/kannada-400.css")],
  mlym: ["Noto Sans Malayalam", () => import("@fontsource/noto-sans-malayalam/malayalam-400.css")],
  mtei: ["Noto Sans Meetei Mayek", () => import("@fontsource/noto-sans-meetei-mayek/meetei-mayek-400.css")],
  olck: ["Noto Sans Ol Chiki", () => import("@fontsource/noto-sans-ol-chiki/ol-chiki-400.css")],
  arab: ["Noto Naskh Arabic", () => import("@fontsource/noto-naskh-arabic/arabic-400.css")],
};
export const SCRIPT: Record<string, string> = {
  as: "beng", bn: "beng", brx: "deva", doi: "deva", gu: "gujr", hi: "deva", kn: "knda", ks: "arab", kok: "deva", mai: "deva", ml: "mlym",
  mni: "mtei", mr: "deva", ne: "deva", or: "orya", pa: "guru", sa: "deva", sat: "olck", sd: "arab", ta: "taml", te: "telu", ur: "arab",
};
const FILES = import.meta.glob<{ default: Record<string, string> }>(["./locales/*.json", "!./locales/en.json"]);
let D: Record<string, string> = {};

export const lang = () => { const l = localStorage.getItem("ff-lang") || "en"; return LANGS[l] ? l : "en"; };
export const setLang = (l: string) => { localStorage.setItem("ff-lang", l); location.reload(); };

/** Load the chosen language, set <html lang dir>, and pull in its font. Call once before the first render. */
export async function initI18n() {
  const l = lang(); const html = document.documentElement;
  html.lang = l; html.dir = RTL.has(l) ? "rtl" : "ltr";
  if (l === "en") return;
  const f = FONTS[SCRIPT[l]];
  if (f) { html.style.setProperty("--script-font", `"${f[0]}"`); f[1]().catch(() => {}); }
  try { D = (await FILES[`./locales/${l}.json`]?.())?.default || {}; } catch { D = {}; }
}
/** Translate English text. "{0}", "{1}"… are replaced by the extra arguments. Missing text stays English. */
export const t = (en: string, ...args: unknown[]): string => {
  const s = (en && D[en]) || en || "";
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length ? String(args[i] ?? "") : m)) : s;
};
/** For tests: translate with an explicit dictionary. */
export const translateWith = (dict: Record<string, string>, en: string, ...args: unknown[]) => { const k = D; D = dict; try { return t(en, ...args); } finally { D = k; } };
