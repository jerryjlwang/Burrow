"""
Burrow: hand-placed pixel UI frames in the rabbit's palette.

Writes 9-slice frames and small pieces into extension/public/ui/. The kid and parent UI draw
them with CSS border-image at a whole-number scale, so they stay as crisp as the rabbit.

Run:  python tools/sprites/ui_px.py
      python tools/sprites/ui_px.py --preview out.png   (composes sample bubbles and buttons at 3x)
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402
from rabbit_px import PAL  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "ui")

# Colours the rabbit does not wear: the chalkboard's slate and the shadow where it sits in its frame.
EXTRA = {
    "S": (43, 74, 63, 255),      # slate, dark green
    "D": (30, 52, 44, 255),      # slate shadow under the frame's inner edge
}

# Same corner as the thought bubble: a flat run, then steps of 2, 1, 1, then the vertical edge.
# 14 x 14 with a 5 pixel slice: corners are 5 x 5, edges and the fill repeat from the middle 4 x 4.
FRAME = [
    ".....oooo.....",
    "...ooRRRRoo...",
    "..oRRRRRRRRo..",
    ".oRRRRRRRRRRo.",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    ".oRRRRRRRRRRo.",
    "..oRRRRRRRRo..",
    "...ooRRRRoo...",
    ".....oooo.....",
]
# Speech tail. Its top row sits on the bubble's bottom outline and opens into the fill.
TAIL = [
    "oRRRRRo",
    ".oRRRo.",
    "..oRo..",
    "...o...",
]
# Buttons: 10 x 10 with a 4 pixel slice. Steps of 1, 1 into the vertical edge.
BUTTON = [
    "..oooooo..",
    ".oXXXXXXo.",
    "oXXXXXXXXo",
    "oXXXXXXXXo",
    "oXXXXXXXXo",
    "oXXXXXXXXo",
    "oXXXXXXXXo",
    "oXXXXXXXXo",
    ".oXXXXXXo.",
    "..oooooo..",
]
# Chalkboard: 20 x 23 with slices of 6 on the top and sides and 9 on the bottom, where a chalk
# tray hangs under the frame. Outline, a lit gold edge on the top and left, jacket wood, a shaded
# edge on the right and bottom, an inner bevel (dark along the top and left, lit along the bottom
# and right), then a one pixel shadow before the slate. The tray is a lit top face on a wood front.
BOARD = [
    "oooooooooooooooooooo",
    "oggggggggggggggggggo",
    "ogjjjjjjjjjjjjjjjjko",
    "ogjjjjjjjjjjjjjjjjko",
    "ogjjkkkkkkkkkkkkjjko",
    "ogjjkDDDDDDDDDDgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjkDSSSSSSSSSgjjko",
    "ogjjggggggggggggjjko",
    "ogjjjjjjjjjjjjjjjjko",
    "ogjjjjjjjjjjjjjjjjko",
    "okkkkkkkkkkkkkkkkkko",
    "oggggggggggggggggggo",
    "ogjjjjjjjjjjjjjjjjko",
    "ogjjjjjjjjjjjjjjjjko",
    "okkkkkkkkkkkkkkkkkko",
    "oooooooooooooooooooo",
]
# A stub of chalk lying on the tray: cream with a shaded underside and a worn end.
CHALK = [
    ".ooooooo.",
    "ohRRRRRso",
    "oRRRRRsso",
    ".ooooooo.",
]
# The notes he carries, unrolled: parchment between two rolled rods. Rows 0 to 4 and 9 to 13 are the
# rods (their caps poke one pixel past the paper), so a 5 pixel slice keeps them on the edges.
SCROLL = [
    ".oooooooooooo.",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "osssssssssssso",
    ".oooooooooooo.",
    ".oRRRRRRRRRRo.",
    ".oRRRRRRRRRRo.",
    ".oRRRRRRRRRRo.",
    ".oRRRRRRRRRRo.",
    ".oooooooooooo.",
    "oRRRRRRRRRRRRo",
    "oRRRRRRRRRRRRo",
    "osssssssssssso",
    ".oooooooooooo.",
]
# Where a button's bottom edge shows its shadow line (one pixel darker), so it reads as raised.
PIECES = {
    "bubble": (FRAME, {}, 5),
    "bubble_teal": (FRAME, {"R": "t"}, 5),
    "button": (BUTTON, {"X": "g"}, 4),
    "button_primary": (BUTTON, {"X": "t"}, 4),
    "button_quiet": (BUTTON, {"X": "R"}, 4),
    "button_alert": (BUTTON, {"X": "c"}, 4),
    "board": (BOARD, {}, (6, 6, 9, 6)),
    "scroll": (SCROLL, {}, 5),
}

# Earth for the jump between laptops. Dark packed dirt with a few paler grains and two pebbles, on a
# 12 x 12 tile that repeats without a seam. The page darkens to this from the edges when he dives.
DIRT = [
    "DDDDEDDDDDDD",
    "DFDDDDDDPpDD",
    "DDDDDDDDDDDD",
    "DDDDDDEDDDFD",
    "DDDEDDDDDDDD",
    "DDDDFDDDDDDE",
    "DDDDDDDDDDDD",
    "DPpDDDDDDDDD",
    "DDDDDDDDEDDD",
    "DDDDDDDDDDDD",
    "DDFDDDEDDDDD",
    "DDDDDDDDDFDD",
]
DIRT_PAL = {
    "D": (46, 32, 27, 255),      # packed earth
    "E": (66, 47, 38, 255),      # paler grain
    "F": (31, 22, 19, 255),      # dark pocket
    "P": (104, 82, 64, 255),     # pebble, lit side
    "p": (78, 60, 46, 255),      # pebble, shaded side
}
# Ordered dither, 4 x 4 Bayer. The tunnel closes in through tiles that keep only the cells under a
# threshold, so its edge is a dither fringe instead of a soft gradient.
BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]
DIRT_LEVELS = {"dirt": 16, "dirt_75": 12, "dirt_50": 8, "dirt_25": 4}

# The same notes rolled up, tied with a gold ribbon, as they drop into the hole after him. Two
# frames side by side: lying flat, then on end, so it tumbles as it falls.
SCROLL_ROLLED = [
    "...........",
    "...........",
    ".ooooooooo.",
    "oRRRRgRRRRo",
    "oRRRRgRRRRo",
    "ossssgsssso",
    ".ooooooooo.",
    "...........",
    "...........",
    "...........",
    "...........",
]


# The rabbit's left ear on its own, for the hold to talk button. Rows and runs come from rabbit_px.
def ear_rows():
    from rabbit_px import EAR_UP
    rows = []
    for r in range(3, 16):
        line = ["."] * 8
        for a, b, ch in EAR_UP[r]:
            for d in range(a, b + 1):
                line[1 + 8 - d] = ch
        rows.append("".join(line))
    return [".." * 4] + rows + [".." * 4]


def image(rows, sub=None, extra=None):
    w, h = len(rows[0]), len(rows)
    im = Image.new("RGBA", (w, h))
    pal = {**PAL, **EXTRA, **(extra or {})}
    px = []
    for row in rows:
        for ch in row:
            ch = (sub or {}).get(ch, ch)
            px.append(pal[ch])
    im.putdata(px)
    return im


def dirt_tile(level):
    """The dirt tile with only the Bayer cells under `level` (of 16) kept; the rest is clear."""
    im = image(DIRT, extra=DIRT_PAL)
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            if BAYER[y % 4][x % 4] >= level:
                px[x, y] = (0, 0, 0, 0)
    return im


def scroll_rolled_strip():
    """Two 11 x 11 frames: the rolled notes lying flat, then standing on end (the same picture turned)."""
    flat = image(SCROLL_ROLLED)
    strip = Image.new("RGBA", (22, 11))
    strip.paste(flat, (0, 0))
    strip.paste(flat.transpose(Image.Transpose.TRANSPOSE), (11, 0))
    return strip


def same_pixels(path, im):
    if not os.path.exists(path):
        return False
    old = Image.open(path).convert("RGBA")
    return old.size == im.size and old.tobytes() == im.tobytes()


def export(out=OUT):
    os.makedirs(out, exist_ok=True)
    man = {"scale_note": "Draw with border-image at a whole-number scale. slice is in source pixels.", "pieces": {}}
    for name, (rows, sub, slice_px) in PIECES.items():
        im = image(rows, sub)
        path = os.path.join(out, f"{name}.png")
        if not same_pixels(path, im):
            im.save(path)
        entry = {"file": f"{name}.png", "size": list(im.size), "slice": list(slice_px) if isinstance(slice_px, tuple) else slice_px}
        if isinstance(slice_px, tuple):
            entry["note"] = "slice is top, right, bottom, left. The bottom slice holds the chalk tray."
        man["pieces"][name] = entry
    chalk = image(CHALK)
    path = os.path.join(out, "chalk.png")
    if not same_pixels(path, chalk):
        chalk.save(path)
    man["pieces"]["chalk"] = {"file": "chalk.png", "size": list(chalk.size), "slice": 0, "note": "A stub of chalk for the board's tray."}
    man["pieces"]["scroll"]["note"] = "The notes he carries. Rods top and bottom; grow the height to unroll it."
    for name, level in DIRT_LEVELS.items():
        im = dirt_tile(level)
        path = os.path.join(out, f"{name}.png")
        if not same_pixels(path, im):
            im.save(path)
        man["pieces"][name] = {"file": f"{name}.png", "size": list(im.size), "slice": 0,
                               "note": f"Repeating earth for the tunnel, {level * 100 // 16}% of the cells kept (4 x 4 Bayer)."}
    rolled = scroll_rolled_strip()
    path = os.path.join(out, "scroll_rolled.png")
    if not same_pixels(path, rolled):
        rolled.save(path)
    man["pieces"]["scroll_rolled"] = {"file": "scroll_rolled.png", "size": list(rolled.size), "slice": 0,
                                      "note": "Two 11 x 11 frames of the rolled notes: flat, then on end."}
    ear = image(ear_rows())
    path = os.path.join(out, "ear.png")
    if not same_pixels(path, ear):
        ear.save(path)
    man["pieces"]["ear"] = {"file": "ear.png", "size": list(ear.size), "slice": 0, "note": "Icon for the hold to talk button."}
    tail = image(TAIL)
    path = os.path.join(out, "bubble_tail.png")
    if not same_pixels(path, tail):
        tail.save(path)
    man["pieces"]["bubble_tail"] = {"file": "bubble_tail.png", "size": list(tail.size), "slice": 0,
                                    "note": "Overlap the bubble's bottom edge by one source pixel."}
    with open(os.path.join(out, "manifest.json"), "w", newline="\n") as fh:
        json.dump(man, fh, indent=2)
        fh.write("\n")
    return man


def nine_slice(im, slice_px, w, h, scale):
    """Compose a w x h (source pixels) box from a 9-slice frame, then scale it up whole."""
    sw, sh = im.size
    out = Image.new("RGBA", (w, h))
    t, r, b, l = slice_px if isinstance(slice_px, tuple) else (slice_px,) * 4
    def blit(src_box, dst_x, dst_y, dst_w, dst_h):
        tile = im.crop(src_box)
        for y in range(dst_y, dst_y + dst_h, tile.height):
            for x in range(dst_x, dst_x + dst_w, tile.width):
                part = tile.crop((0, 0, min(tile.width, dst_x + dst_w - x), min(tile.height, dst_y + dst_h - y)))
                out.paste(part, (x, y))
    blit((0, 0, l, t), 0, 0, l, t)
    blit((sw - r, 0, sw, t), w - r, 0, r, t)
    blit((0, sh - b, l, sh), 0, h - b, l, b)
    blit((sw - r, sh - b, sw, sh), w - r, h - b, r, b)
    blit((l, 0, sw - r, t), l, 0, w - l - r, t)
    blit((l, sh - b, sw - r, sh), l, h - b, w - l - r, b)
    blit((0, t, l, sh - b), 0, t, l, h - t - b)
    blit((sw - r, t, sw, sh - b), w - r, t, r, h - t - b)
    blit((l, t, sw - r, sh - b), l, t, w - l - r, h - t - b)
    return out.resize((w * scale, h * scale), Image.NEAREST)


def preview(path, scale=3):
    bubble = nine_slice(image(FRAME), 5, 96, 30, scale)
    tail = image(TAIL).resize((7 * scale, 4 * scale), Image.NEAREST)
    sheet = Image.new("RGBA", (2 * (96 * scale + 40), 2 * (60 * scale)), (110, 110, 110, 255))
    draw = ImageDraw.Draw(sheet)
    for i, bg in enumerate(((223, 230, 238, 255), (24, 28, 38, 255))):
        x0 = i * (96 * scale + 40) + 20
        draw.rectangle((x0 - 20, 0, x0 + 96 * scale + 20, sheet.height), fill=bg)
        sheet.alpha_composite(bubble, (x0, 12))
        sheet.alpha_composite(tail, (x0 + 70 * scale, 12 + 29 * scale))
        draw.text((x0 + 8 * scale, 12 + 6 * scale), "Oh my ears and whiskers,", fill=(59, 42, 35, 255))
        draw.text((x0 + 8 * scale, 12 + 14 * scale), "what is a moat?", fill=(59, 42, 35, 255))
        y = 12 + 40 * scale
        for j, (name, ink) in enumerate((("button_primary", "h"), ("button", "o"), ("button_quiet", "o"), ("button_alert", "h"))):
            rows, sub, s = PIECES[name]
            b = nine_slice(image(rows, sub), s, 40, 12, scale)
            bx = x0 + j * 44 * scale
            if bx + 40 * scale > x0 + 96 * scale:
                break
            sheet.alpha_composite(b, (bx, y))
            draw.text((bx + 6 * scale, y + 3 * scale), ["Yes please", "Not now", "More", "Stop"][j], fill=PAL[ink])
    sheet.save(path)
    print(path, sheet.size)


def preview_jump(path, scale=3):
    """The tunnel dirt at its four densities over a page, the unrolled notes, and the rolled notes at 6x."""
    page = (245, 247, 251, 255)
    sheet = Image.new("RGBA", (4 * 36 * scale * 2 + 60, 2 * 36 * scale + 60 + 60 * scale), page)
    draw = ImageDraw.Draw(sheet)
    for i, name in enumerate(("dirt_25", "dirt_50", "dirt_75", "dirt")):
        tile = dirt_tile(DIRT_LEVELS[name]).resize((12 * scale, 12 * scale), Image.NEAREST)
        x0 = 12 + i * 36 * scale * 2
        for ty in range(6):
            for tx in range(6):
                sheet.alpha_composite(tile, (x0 + tx * 12 * scale, 12 + ty * 12 * scale))
    y = 12 + 6 * 12 * scale + 24
    notes = nine_slice(image(SCROLL), 5, 110, 40, scale)
    sheet.alpha_composite(notes, (12, y))
    draw.text((12 + 7 * scale, y + 8 * scale), "Today I learned about", fill=(59, 42, 35, 255))
    draw.text((12 + 7 * scale, y + 16 * scale), "moats and castle walls.", fill=(59, 42, 35, 255))
    rolled = scroll_rolled_strip().resize((22 * 6, 11 * 6), Image.NEAREST)
    sheet.alpha_composite(rolled, (12 + 120 * scale, y))
    sheet.save(path)
    print(path, sheet.size)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", default="")
    args = ap.parse_args()
    m = export()
    print("pieces:", ", ".join(m["pieces"]))
    if args.preview:
        preview(args.preview)
        preview_jump(args.preview.replace(".png", "_jump.png"))
