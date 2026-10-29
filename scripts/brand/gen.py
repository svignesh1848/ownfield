"""Builds the OwnField logo SVGs (pin mark + wordmark lockup) as pure vector paths.
Text is converted to outlines from Poppins (SIL OFL) so no font is needed at render time."""
import math, os
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
TEAL, LIME, WHITE = "#0e6170", "#8cc63f", "#ffffff"
FD = "/usr/share/fonts/truetype/sand-box/google/Poppins/"
OUT = os.path.join(os.path.dirname(__file__), "../../web/public")

def text_path(font, s, x, y, size, tracking=0):
    f = TTFont(FD + font); gs = f.getGlyphSet(); cmap = f.getBestCmap(); upm = f["head"].unitsPerEm
    sc = size / upm; pen = SVGPathPen(gs); cx = 0
    for ch in s:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (sc, 0, 0, -sc, x + cx, y)))
        cx += gs[g].width * sc + tracking
    return pen.getCommands(), cx

def pin(cx, cy, r, tip):
    d = tip - cy; a = math.asin(r / d); px = r * math.cos(a); py = cy + r * math.sin(a)
    return (f"M{cx:.2f} {tip:.2f}L{cx-px:.2f} {py:.2f}A{r} {r} 0 1 1 {cx+px:.2f} {py:.2f}Z")

def mark(fg=TEAL, hole=WHITE, arrow=LIME, tx=0, ty=0, s=1.0):
    # pin in a 100x128 box; white disc; lime arrow pointing up-right
    g = f'<g transform="translate({tx} {ty}) scale({s})">'
    g += f'<path d="{pin(50,47,45,124)}" fill="{fg}"/>'
    g += f'<circle cx="50" cy="47" r="27" fill="{hole}"/>'
    g += (f'<path d="M36.5 60.5L56 41" stroke="{arrow}" stroke-width="7.5" stroke-linecap="round" fill="none"/>'
          f'<path d="M45.5 34.5L64.5 32.5L62.5 51.5Z" fill="{arrow}" stroke="{arrow}" stroke-width="3" stroke-linejoin="round"/>')
    return g + '</g>'

def svg(w, h, body, label="OwnField"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{label}">{body}</svg>\n'

def lockup(fg, hole, arrow, dot):
    word, ww = text_path("Poppins-Medium.ttf", "OwnField", 112, 66, 60, -0.5)
    tag, tw = text_path("Poppins-Regular.ttf", "Own your sales", 115, 106, 25, 0.3)
    dotx = 115 + tw + 2
    body = mark(fg, hole, arrow, 0, 2, 0.9)
    body += f'<path d="{word}" fill="{fg}"/><path d="{tag}" fill="{fg}"/>'
    body += f'<rect x="{dotx:.1f}" y="100" width="6" height="6" rx="1.2" fill="{dot}"/>'
    W = math.ceil(max(112 + ww, dotx + 6) + 4)
    return svg(W, 118, body, "OwnField — Own your sales.")

w = lambda n, s: open(os.path.join(OUT, n), "w").write(s)
w("logo-mark.svg", svg(100, 128, mark()))
w("logo-mark-white.svg", svg(100, 128, mark(WHITE, TEAL, LIME)))
w("logo-wordmark.svg", lockup(TEAL, WHITE, LIME, LIME))
w("logo-wordmark-white.svg", lockup(WHITE, TEAL, LIME, LIME))
# app icons: teal tile with white pin (standard), and maskable with mark inside the 80% safe zone
def icon(pad):
    s = (512 * (1 - 2 * pad)) / 128; tx = (512 - 100 * s) / 2; ty = (512 - 128 * s) / 2
    return svg(512, 512, f'<rect width="512" height="512" rx="{0 if pad>0.2 else 112}" fill="{TEAL}"/>' + mark(WHITE, TEAL, LIME, round(tx,2), round(ty,2), round(s,4)))
w("icons/icon.svg", icon(0.14))
w("icons/icon-maskable.svg", icon(0.25))
