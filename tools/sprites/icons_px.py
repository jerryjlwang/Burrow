"""
Burrow extension icons: the White Rabbit's face, hand-placed at 16 x 16 and scaled by whole
numbers to 32, 48 and 128. Writes extension/public/icons/icon<size>.png.

Run:  python tools/sprites/icons_px.py [--preview out.png]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402
from rabbit_px import PAL  # noqa: E402
from ui_px import same_pixels  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "icons")

# 16 x 16. Ears, round head, two eyes with a shine, nose, the red bow tie. One pixel outline,
# a cream rim on the outside so it reads on light and dark toolbars.
ICON = [
    "...oo....oo.....",
    "..owpo..owpo....",
    "..owpo..owpo....",
    "..owpo..owpo....",
    ".oowwoooowwoo...",
    ".owwwwwwwwwwo...",
    "owwwwwwwwwwwwo..",
    "owweewwwweewwo..",
    "owweewwwweewwo..",
    "owwwwwwnnwwwwo..",
    "owwwwwwwwwwwwo..",
    ".owwwwwoowwwwo..",
    ".oowwwwwwwwwoo..",
    "..oocccCcccoo...",
    "....occCcco.....",
    ".....ooooo......",
]
SIZES = (16, 32, 48, 128)


def rimmed(rows):
    """Add the cream rim around the silhouette, inside the 16 x 16 cell where there is room."""
    h, w = len(rows), len(rows[0])
    g = [list(r) for r in rows]
    for r in range(h):
        for c in range(w):
            if g[r][c] != ".":
                continue
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < h and 0 <= cc < w and rows[rr][cc] != ".":
                    g[r][c] = "R"
                    break
    return ["".join(r) for r in g]


def image(rows):
    w, h = len(rows[0]), len(rows)
    im = Image.new("RGBA", (w, h))
    im.putdata([PAL[ch] for row in rows for ch in row])
    return im


def export(out=OUT):
    os.makedirs(out, exist_ok=True)
    base = image(rimmed(ICON))
    for size in SIZES:
        scale = size // 16
        im = base.resize((16 * scale, 16 * scale), Image.NEAREST)
        path = os.path.join(out, f"icon{size}.png")
        if not same_pixels(path, im):
            im.save(path)
    return base


def preview(path, base):
    sheet = Image.new("RGBA", (2 * 200, 200), (110, 110, 110, 255))
    d = ImageDraw.Draw(sheet)
    for i, bg in enumerate(((240, 240, 240, 255), (32, 33, 36, 255))):
        x0 = i * 200
        d.rectangle((x0, 0, x0 + 199, 199), fill=bg)
        sheet.alpha_composite(base.resize((128, 128), Image.NEAREST), (x0 + 12, 12))
        sheet.alpha_composite(base.resize((48, 48), Image.NEAREST), (x0 + 148, 12))
        sheet.alpha_composite(base.resize((32, 32), Image.NEAREST), (x0 + 148, 70))
        sheet.alpha_composite(base, (x0 + 148, 112))
    sheet.save(path)
    print(path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", default="")
    args = ap.parse_args()
    base = export()
    print("icons written:", ", ".join(f"icon{s}.png" for s in SIZES))
    if args.preview:
        preview(args.preview, base)
