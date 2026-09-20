"""
Burrow: pixel pieces for the rabbit's "watching along" set pieces (extension/src/components/actfx/video.ts).

Writes into extension/public/ui/actfx/:
  video_play.png    a play triangle, cream with a brown outline and a shaded lower edge (11 x 11)
  video_badge.png   the small pause badge that stays in the frame's corner while paused (11 x 11)
  video_watch.png   his pocket watch, eight frames side by side with the hand at eight angles (8 x 13 x 14)
  video_bang.png    a gold "!" for over his head (5 x 13)
  video_dim_1..4    4 x 4 Bayer tiles of the ink, sparse to dense, that dim the frame in steps

Everything is drawn at 1x and scaled by a whole number in CSS (3x on the page), so it stays as crisp
as the rabbit. Run:  python tools/sprites/actfx_video_px.py
                     python tools/sprites/actfx_video_px.py --preview out.png   (a contact sheet at 3x)
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "ui", "actfx")

# The kid UI palette (styles.css) plus the rabbit's watch face and a cream shade for bevels.
PAL = {
    ".": (0, 0, 0, 0),
    "o": (59, 42, 35, 255),      # ink, the outline
    "c": (255, 248, 231, 255),   # cream
    "s": (230, 216, 197, 255),   # cream shade, the bevel
    "g": (242, 193, 78, 255),    # gold
    "G": (181, 127, 44, 255),    # gold deep
    "f": (255, 253, 245, 255),   # watch face
}
# Ink at this alpha for the dim tiles: even under the densest tile the picture stays well over half visible.
DIM_INK = (59, 42, 35, 150)
# Ordered dither, 4 x 4 Bayer, the same matrix as the tunnel's dirt (ui_px.py).
BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]
# Cells kept (of 16) at each dim step: about a fifth, two fifths, a bit over half, three quarters.
DIM_LEVELS = [3, 6, 9, 12]

# A cream plaque with rounded corners and two ink bars, a shade line along the inside of the bottom.
BADGE = [
    ".ooooooooo.",
    "occccccccco",
    "occccccccco",
    "occoocoocco",
    "occoocoocco",
    "occoocoocco",
    "occoocoocco",
    "occoocoocco",
    "occccccccco",
    "ossssssssso",
    ".ooooooooo.",
]
BANG = [
    ".ooo.",
    "oGggo",
    "oGggo",
    "oGggo",
    "oGggo",
    "oGggo",
    ".ogo.",
    ".ooo.",
    ".....",
    ".ooo.",
    "ogggo",
    "oGggo",
    ".ooo.",
]

PLAY_W = 11
PLAY_H = 11
WATCH_W = 13
WATCH_H = 14
# The watch body is a circle of this radius around PIVOT; rows 0 to 2 above it are the crown.
WATCH_R = 5.5
PIVOT = (6, 8)
# The cells the hand covers at each of eight angles, clockwise from twelve.
HANDS = [
    [(6, 7), (6, 6), (6, 5)],
    [(7, 7), (8, 6)],
    [(7, 8), (8, 8), (9, 8)],
    [(7, 9), (8, 10)],
    [(6, 9), (6, 10), (6, 11)],
    [(5, 9), (4, 10)],
    [(5, 8), (4, 8), (3, 8)],
    [(5, 7), (4, 6)],
]


def image(rows):
    w = len(rows[0])
    for r in rows:
        assert len(r) == w, f"row width {len(r)} != {w}: {r}"
    im = Image.new("RGBA", (w, len(rows)))
    px = im.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            px[x, y] = PAL[ch]
    return im


def outlined(w, h, inside, fill="c", shade=None):
    """A filled shape with a one pixel ink outline where the fill meets empty space or the edge.

    `inside(x, y)` says which cells are the shape. Cells of the fill whose lower or right neighbour is
    outline get `shade`, so the shape reads as lit from the top left like the rest of the kid UI.
    """
    grid = [["." for _ in range(w)] for _ in range(h)]

    def filled(x, y):
        return 0 <= x < w and 0 <= y < h and inside(x, y)

    for y in range(h):
        for x in range(w):
            if not inside(x, y):
                continue
            edge = not all(filled(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            grid[y][x] = "o" if edge else fill
    if shade:
        for y in range(h):
            for x in range(w):
                if grid[y][x] == fill and (grid[y + 1][x] == "o" if y + 1 < h else False):
                    grid[y][x] = shade
    return ["".join(r) for r in grid]


def play_rows():
    # A triangle with its tip on the right; the outline steps two cells per row like the bubble's corner.
    return outlined(PLAY_W, PLAY_H, lambda x, y: x <= PLAY_W - 1 - 2 * abs(y - (PLAY_H - 1) // 2), shade="s")


def watch_rows():
    cx, cy = PIVOT
    body = outlined(WATCH_W, WATCH_H, lambda x, y: y >= 3 and (x - cx) ** 2 + (y - cy) ** 2 <= WATCH_R ** 2, fill="f")
    rows = [list(r) for r in body]
    # A gold rim just inside the outline.
    for y in range(WATCH_H):
        for x in range(WATCH_W):
            if rows[y][x] == "f" and any(0 <= x + dx < WATCH_W and 0 <= y + dy < WATCH_H and rows[y + dy][x + dx] == "o" for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                rows[y][x] = "g"
    # The crown: three gold cells wide, outlined, standing on the body's top.
    for x in range(cx - 1, cx + 2):
        rows[0][x] = "o"
        rows[1][x] = "g"
        rows[2][x] = "g"
    for y in (1, 2):
        rows[y][cx - 2] = "o"
        rows[y][cx + 2] = "o"
    return ["".join(r) for r in rows]


def watch_strip():
    base = watch_rows()
    strip = Image.new("RGBA", (WATCH_W * len(HANDS), WATCH_H))
    for i, hand in enumerate(HANDS):
        frame = image(base)
        px = frame.load()
        for x, y in hand:
            px[x, y] = PAL["o"]
        px[PIVOT] = PAL["o"]
        strip.paste(frame, (i * WATCH_W, 0))
    return strip


def dim_tile(level):
    im = Image.new("RGBA", (4, 4))
    px = im.load()
    for y in range(4):
        for x in range(4):
            px[x, y] = DIM_INK if BAYER[y][x] < level else (0, 0, 0, 0)
    return im


def pieces():
    out = {
        "video_play": image(play_rows()),
        "video_badge": image(BADGE),
        "video_bang": image(BANG),
        "video_watch": watch_strip(),
    }
    for i, level in enumerate(DIM_LEVELS, start=1):
        out[f"video_dim_{i}"] = dim_tile(level)
    return out


def write(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for name, im in pieces().items():
        path = os.path.join(out_dir, f"{name}.png")
        im.save(path)
        print(f"wrote {path} ({im.width} x {im.height})")


def preview(path, scale=3):
    """The pieces at page scale on a mid grey; each dim tile is repeated over a cream square."""
    cells = []
    for name, im in pieces().items():
        if name.startswith("video_dim"):
            cell = Image.new("RGBA", (48, 48), PAL["c"])
            for y in range(0, 48, 4):
                for x in range(0, 48, 4):
                    cell.alpha_composite(im, (x, y))
            cells.append(cell)
        else:
            cells.append(im)
    pad = 12
    w = sum(c.width * scale for c in cells) + pad * (len(cells) + 1)
    h = max(c.height * scale for c in cells) + 2 * pad
    sheet = Image.new("RGBA", (w, h), (120, 120, 120, 255))
    x = pad
    for cell in cells:
        big = cell.resize((cell.width * scale, cell.height * scale), Image.NEAREST)
        sheet.alpha_composite(big, (x, pad))
        x += big.width + pad
    sheet.save(path)
    print(f"wrote {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--preview", default=None)
    args = ap.parse_args()
    if args.preview:
        preview(args.preview)
    else:
        write(os.path.abspath(args.out))
