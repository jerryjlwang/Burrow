"""
Guest sprites: a character drawn by hand, in code, the way every other piece in this product is.

    python3 tools/sprites/guest_px.py --who caped --out extension/public/characters/guest

The image models refuse anyone a judge would actually name (see docs/frontend/SCANNER.md), so the
sprite is placed pixel by pixel here instead. Each entry is a small builder: flat shapes on a 32 by
40 grid, no anti aliasing, then the product's one pixel outline and the rabbit's cell around it.
"""

import argparse
import json
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
W, H = 32, 40
CELL_W, CELL_H = 64, 58
INK = (26, 26, 34, 255)
CLEAR = (0, 0, 0, 0)


def grid():
    im = Image.new("RGBA", (W, H), CLEAR)
    return im, ImageDraw.Draw(im)


def caped():
    """A small caped figure: pointed cowl ears, a grey suit, a gold belt and a dark cape."""
    im, d = grid()
    CAPE = (46, 48, 74, 255)
    CAPE_D = (32, 34, 54, 255)
    COWL = (54, 56, 84, 255)
    SUIT = (112, 116, 134, 255)
    SUIT_D = (84, 88, 106, 255)
    GOLD = (242, 193, 78, 255)
    SKIN = (238, 200, 170, 255)
    WHITE = (255, 250, 240, 255)
    # cape behind everything, a wide sweep from the shoulders down
    d.polygon([(6, 16), (25, 16), (29, 37), (2, 37)], fill=CAPE)
    d.polygon([(6, 16), (10, 16), (7, 37), (2, 37)], fill=CAPE_D)
    d.polygon([(21, 16), (25, 16), (29, 37), (24, 37)], fill=CAPE_D)
    # legs and boots, under the body
    d.rectangle([11, 31, 14, 37], fill=SUIT_D)
    d.rectangle([17, 31, 20, 37], fill=SUIT_D)
    d.rectangle([10, 36, 15, 38], fill=CAPE_D)
    d.rectangle([16, 36, 21, 38], fill=CAPE_D)
    # body
    d.rectangle([10, 17, 21, 32], fill=SUIT)
    d.rectangle([10, 17, 12, 32], fill=SUIT_D)
    # arms
    d.rectangle([7, 18, 9, 27], fill=SUIT_D)
    d.rectangle([22, 18, 24, 27], fill=SUIT_D)
    # belt
    d.rectangle([10, 27, 21, 29], fill=GOLD)
    d.rectangle([14, 27, 17, 29], fill=(198, 150, 50, 255))
    # chest mark
    d.rectangle([13, 20, 18, 21], fill=CAPE_D)
    d.rectangle([14, 22, 17, 22], fill=CAPE_D)
    # head: cowl with two pointed ears, and a face opening
    d.polygon([(8, 9), (9, 2), (12, 9)], fill=COWL)
    d.polygon([(19, 9), (22, 2), (23, 9)], fill=COWL)
    d.rectangle([7, 6, 24, 16], fill=COWL)
    d.rectangle([7, 6, 9, 16], fill=CAPE_D)
    d.rectangle([9, 11, 22, 16], fill=SKIN)
    d.rectangle([9, 15, 22, 16], fill=SKIN)
    # the cowl comes down over the brow and between the eyes
    d.rectangle([9, 11, 22, 11], fill=COWL)
    d.rectangle([15, 11, 16, 13], fill=COWL)
    # eyes
    d.rectangle([11, 12, 13, 13], fill=WHITE)
    d.rectangle([18, 12, 20, 13], fill=WHITE)
    # mouth
    d.rectangle([14, 15, 17, 15], fill=(150, 90, 90, 255))
    return im


BUILDERS = {"caped": caped}


def outline(im):
    w, h = im.size
    src = im.copy()
    out = Image.new("RGBA", (w + 2, h + 2), CLEAR)
    out.paste(src, (1, 1))
    op, sp = out.load(), src.load()
    solid = lambda x, y: 0 <= x < w and 0 <= y < h and sp[x, y][3] > 0
    for y in range(h + 2):
        for x in range(w + 2):
            if op[x, y][3]:
                continue
            sx, sy = x - 1, y - 1
            if any(solid(sx + dx, sy + dy) for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1))):
                op[x, y] = INK
    return out


def cell_of(art):
    cell = Image.new("RGBA", (CELL_W, CELL_H), CLEAR)
    box = art.getbbox() or (0, 0, art.width, art.height)
    a = art.crop(box)
    x = (CELL_W - a.width) // 2
    y = max(0, 54 - a.height)
    cell.paste(a, (x, y))
    return cell, (x, y, a.width, a.height)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--who", default="caped", choices=sorted(BUILDERS))
    ap.add_argument("--name", default="")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    name = args.name or args.who
    cell, body = cell_of(outline(BUILDERS[args.who]()))
    out_dir = args.out or os.path.join(ROOT, "extension", "public", "characters", name)
    os.makedirs(out_dir, exist_ok=True)
    cell.save(os.path.join(out_dir, f"{name}_idle.png"))
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({
            "character": name, "cell": [CELL_W, CELL_H], "anchor": "feet", "display": {"scale": 3},
            "body": [body[0], body[1], body[0] + body[2] - 1, body[1] + body[3] - 1],
            "states": {"idle": {"file": f"{name}_idle.png", "frames": 1, "fps": 1, "loop": True}},
        }, f, indent=2)
        f.write("\n")
    big = cell.resize((CELL_W * 8, CELL_H * 8), Image.NEAREST)
    bg = Image.new("RGB", big.size, (120, 170, 220))
    bg.paste(big, (0, 0), big)
    bg.save(os.path.join(out_dir, f"{name}_preview.png"))
    print(f"[guest] {name} -> {out_dir}  body {body}")


if __name__ == "__main__":
    main()
