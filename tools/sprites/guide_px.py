"""The guide's pixel pieces: a rabbit's pawprint, the four lock-on corners (cream and gold), and the
dither tile the spotlight dims the page with. Hand-placed at 1x; the CSS draws them at 3x.
Writes extension/public/ui/guide/. PNGs whose pixels did not change are left alone."""
import os
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "ui", "guide")
INK = (59, 42, 35, 255)
CREAM = (255, 248, 231, 255)
GOLD = (242, 193, 78, 255)
CLEAR = (0, 0, 0, 0)

PAW = [
    "oooo.oooo",
    "occo.occo",
    "occo.occo",
    "oooo.oooo",
    ".ooooooo.",
    ".occccco.",
    ".occccco.",
    ".ooooooo.",
]
CORNER = [
    "ooooooo",
    "occccco",
    "occccco",
    "occoooo",
    "occo...",
    "occo...",
    "oooo...",
]
# 4 x 4 Bayer thresholds; the dim keeps the four darkest cells (25 percent) as soft ink over a flat tint.
BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]


def image(rows, fill):
    w, h = len(rows[0]), len(rows)
    im = Image.new("RGBA", (w, h), CLEAR)
    px = im.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            px[x, y] = INK if ch == "o" else fill if ch == "c" else CLEAR
    return im


def write(name, im):
    path = os.path.join(OUT, name)
    if os.path.exists(path) and Image.open(path).convert("RGBA").tobytes() == im.tobytes():
        return
    im.save(path)
    print("wrote", path)


def main():
    os.makedirs(OUT, exist_ok=True)
    write("paw.png", image(PAW, CREAM))
    for fill, tag in ((CREAM, ""), (GOLD, "_gold")):
        tl = image(CORNER, fill)
        write(f"corner_tl{tag}.png", tl)
        write(f"corner_tr{tag}.png", tl.transpose(Image.FLIP_LEFT_RIGHT))
        write(f"corner_bl{tag}.png", tl.transpose(Image.FLIP_TOP_BOTTOM))
        write(f"corner_br{tag}.png", tl.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_TOP_BOTTOM))
    dim = Image.new("RGBA", (4, 4), CLEAR)
    px = dim.load()
    for y in range(4):
        for x in range(4):
            if BAYER[y][x] < 4:
                px[x, y] = (59, 42, 35, 96)
    write("dim.png", dim)


if __name__ == "__main__":
    main()
