import { chromium } from "playwright-core";
import fs from "fs";
const P = "/workspace/fieldforce-oss/web/public/", O = "/workspace/ownfield-brand/";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const pg = await b.newPage();
async function r(svgFile, out, w, h, bg, pad = 0) {
  const s = fs.readFileSync(P + svgFile, "utf8");
  await pg.setViewportSize({ width: w, height: h });
  await pg.setContent(`<html><body style="margin:0;background:${bg};display:flex;align-items:center;justify-content:center;width:${w}px;height:${h}px">
  <img src="data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}" style="width:${w - 2 * pad}px;height:${h - 2 * pad}px;object-fit:contain"></body></html>`);
  await pg.screenshot({ path: out, omitBackground: bg === "transparent" });
}
const lw = (f) => { const m = fs.readFileSync(P + f, "utf8").match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/); return [+m[1], +m[2]]; };
// app icons
for (const n of [192, 512]) { await r("icons/icon.svg", P + `icons/icon-${n}.png`, n, n, "transparent"); await r("icons/icon-maskable.svg", P + `icons/icon-maskable-${n}.png`, n, n, "transparent"); }
await r("icons/icon.svg", P + "icons/apple-touch-icon.png", 180, 180, "transparent");
await r("icons/icon.svg", P + "icons/favicon-32.png", 32, 32, "transparent");
await r("icons/icon.svg", P + "icons/favicon-16.png", 16, 16, "transparent");
// brand exports
await r("logo-mark.svg", O + "ownfield-mark-1024-white.png", 1024, 1024, "#fff", 100);
await r("logo-mark.svg", O + "ownfield-mark-1024-transparent.png", 1024, 1024, "transparent", 100);
await r("logo-mark-white.svg", O + "ownfield-mark-white-1024-transparent.png", 1024, 1024, "transparent", 100);
const [w, h] = lw("logo-wordmark.svg"); const H = Math.round(2000 * h / w);
await r("logo-wordmark.svg", O + "ownfield-lockup-2000-white.png", 2000, H, "#fff");
await r("logo-wordmark.svg", O + "ownfield-lockup-2000-transparent.png", 2000, H, "transparent");
await r("logo-wordmark-white.svg", O + "ownfield-lockup-white-2000-transparent.png", 2000, H, "transparent");
// brand sheet
const u = (f) => "data:image/svg+xml;base64," + Buffer.from(fs.readFileSync(P + f)).toString("base64");
await pg.setViewportSize({ width: 1600, height: 1000 });
await pg.setContent(`<html><body style="margin:0;font-family:Poppins;background:#f4f6f7;padding:48px;box-sizing:border-box;width:1600px">
<h1 style="margin:0 0 4px;color:#0e6170">OwnField — brand sheet</h1><p style="margin:0 0 28px;color:#555">Own your sales.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
<div style="background:#fff;border-radius:16px;height:260px;display:flex;align-items:center;justify-content:center"><img src="${u("logo-wordmark.svg")}" style="height:150px"></div>
<div style="background:#0e6170;border-radius:16px;height:260px;display:flex;align-items:center;justify-content:center"><img src="${u("logo-wordmark-white.svg")}" style="height:150px"></div>
<div style="background:#fff;border-radius:16px;height:300px;display:flex;align-items:center;justify-content:space-evenly">
<img src="${u("logo-mark.svg")}" style="height:200px"><img src="${u("logo-mark.svg")}" style="height:96px"><img src="${u("logo-mark.svg")}" style="height:40px"><img src="${u("logo-mark.svg")}" style="height:20px"></div>
<div style="background:#1b1f24;border-radius:16px;height:300px;display:flex;align-items:center;justify-content:space-evenly">
<img src="${u("icons/icon.svg")}" style="height:160px;border-radius:36px"><img src="${u("icons/icon-maskable.svg")}" style="height:160px;border-radius:50%"><img src="${u("logo-mark-white.svg")}" style="height:120px"></div></div>
<div style="display:flex;gap:16px;margin-top:28px;font-size:18px">${[["#0e6170","Teal #0E6170"],["#8cc63f","Lime #8CC63F"],["#ffffff","White #FFFFFF"]].map(([c,n])=>`<div style="display:flex;align-items:center;gap:10px"><span style="width:44px;height:44px;border-radius:10px;background:${c};border:1px solid #ccc"></span>${n}</div>`).join("")}<span style="margin-left:auto;color:#666">Type: Poppins Medium / Regular (outlined)</span></div></body></html>`);
await pg.screenshot({ path: O + "ownfield-brand-sheet.png", fullPage: true });
await b.close();
