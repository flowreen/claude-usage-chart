"""Draws extension/icons/icon{16,32,48,128}.png and store/icon128.png in the chart page's look: a dark card with a rim, the
dashed ideal diagonal, a blue usage line ending on a gold "in the zone" dot. No diagonal at 16 px.

python dev/make_icons.py   (from the project root)
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BG = (38, 38, 42, 255)        # --btn
RIM = (96, 96, 104, 255)      # --btn-border, keeps the card visible on a dark toolbar
DASH = (154, 154, 154, 200)   # --ideal
LINE = (125, 152, 255, 255)   # --dot
GOLD = (255, 197, 61, 255)    # --gold
GLOW = (255, 197, 61, 90)     # --gold-glow
SS = 8                        # supersample factor


def draw(size: int) -> Image.Image:
    # Store guidance: 128 px icon = 96 px artwork + 16 px transparent padding.
    pad = 16 * size // 128 if size >= 48 else 0
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    p = pad * SS
    art = S - 2 * p
    rim = max(SS, int(art * 0.03))
    d.rounded_rectangle([p, p, S - p - 1, S - p - 1], radius=art * 0.22, fill=BG, outline=RIM, width=rim)

    def pt(fx, fy):
        return (p + art * (0.18 + 0.62 * fx), p + art * (0.82 - 0.62 * fy))

    # dashed ideal diagonal
    if size >= 32:
        n = 5
        for i in range(n):
            a, b = i / n, (i + 0.5) / n
            d.line([pt(a, a), pt(b, b)], fill=DASH, width=max(SS, int(art * 0.04)))

    # usage curve: under the pace line, one dip, then back up to the line = in the zone
    curve = [(0.0, 0.0), (0.3, 0.1), (0.55, 0.32), (0.7, 0.6), (0.78, 0.48), (1.0, 0.96)]
    w = max(SS * 2, int(art * (0.075 if size >= 32 else 0.11)))
    d.line([pt(*c) for c in curve], fill=LINE, width=w, joint='curve')
    x, y = pt(*curve[-1])
    r = art * (0.1 if size >= 32 else 0.14)
    if size >= 32:
        g = r * 1.7
        d.ellipse([x - g, y - g, x + g, y + g], fill=GLOW)
    d.ellipse([x - r, y - r, x + r, y + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = ROOT / 'extension' / 'icons'
    out.mkdir(exist_ok=True)
    for s in (16, 32, 48, 128):
        draw(s).save(out / f'icon{s}.png')
    draw(128).save(ROOT / 'store' / 'icon128.png')
    print('wrote', ', '.join(f'icon{s}.png' for s in (16, 32, 48, 128)), 'and store/icon128.png')


if __name__ == '__main__':
    main()
