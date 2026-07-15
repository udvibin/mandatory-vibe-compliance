# Regenerates the PWA icons in site/ from the favicon.svg vinyl geometry.
# Run: ./venv/Scripts/python.exe dev/make_icons.py   (only needs Pillow)
#
# icon-192 / icon-512 (purpose "any"): full-bleed vinyl, transparent bg.
# icon-maskable-512: vinyl at 85% on the site's #0a161d square — Android's
# mask safe zone is the centre-80% circle, so full-bleed would crop the grooves.
import os
from PIL import Image, ImageDraw

BG = (10, 22, 29, 255)          # --bg-0
DISC = (14, 32, 41, 255)        # #0e2029
RING = (157, 180, 189)          # #9db4bd
STOPS = [(0.0, (228, 89, 59)), (0.55, (239, 141, 156)), (1.0, (124, 196, 220))]

def label_gradient(d):
    im = Image.new('RGB', (256, 256))
    px = im.load()
    for y in range(256):
        for x in range(256):
            t = (x + y) / 510
            for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
                if t <= t1:
                    f = (t - t0) / (t1 - t0)
                    px[x, y] = tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
                    break
    return im.resize((d, d), Image.BILINEAR)

def vinyl(size, frac, bg):
    SS = 4
    W = size * SS
    u = (W * frac) / 62            # favicon.svg disc: r=31 in a 64 box
    cx = W / 2
    img = Image.new('RGBA', (W, W), bg if bg else (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    c = lambda r: (cx - r * u, cx - r * u, cx + r * u, cx + r * u)
    dr.ellipse(c(31), fill=DISC)
    rings = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rings)
    for r, a in ((26, .22), (21, .16), (16, .12)):
        rd.ellipse(c(r), outline=RING + (round(a * 255),), width=round(1.6 * u))
    img = Image.alpha_composite(img, rings)
    d = round(2 * 11.5 * u)
    grad = label_gradient(d)
    mask = Image.new('L', (d, d), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, d - 1, d - 1), fill=255)
    img.paste(grad, (round(cx - d / 2), round(cx - d / 2)), mask)
    ImageDraw.Draw(img).ellipse(c(2.8), fill=BG)
    return img.resize((size, size), Image.LANCZOS)

OUT = os.path.join(os.path.dirname(__file__), '..', 'site')
vinyl(192, 1.0, None).save(os.path.join(OUT, 'icon-192.png'))
vinyl(512, 1.0, None).save(os.path.join(OUT, 'icon-512.png'))
vinyl(512, 0.85, BG).save(os.path.join(OUT, 'icon-maskable-512.png'))

# sanity: corners transparent on any-icons, navy on maskable, label warm/opaque
a = Image.open(os.path.join(OUT, 'icon-512.png')).convert('RGBA')
m = Image.open(os.path.join(OUT, 'icon-maskable-512.png')).convert('RGBA')
assert a.getpixel((2, 2))[3] == 0, 'any icon corner should be transparent'
assert m.getpixel((2, 2))[:3] == BG[:3], 'maskable corner should be bg navy'
r, g, b, al = a.getpixel((200, 200))
assert al == 255 and r > 150, f'label should be warm/opaque, got {(r, g, b, al)}'
print('OK', a.size, m.size)
