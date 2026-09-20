"""
Wonderland OS: the White Rabbit, hand-placed pixels (v3).

Nothing here is rasterized from curves. Every outline run, every shade pixel and
every patch is placed by hand in the specs below, the way you would in Aseprite.
Animation only ever moves whole pixels (shift rows, delete a row, swap a patch),
so nothing gets resampled and every frame stays clean.

Canvas: 48 x 58. The sprite is symmetric, so rows are written for the left half
as (from_center, to_center, color) runs, where 0 is the column touching the
center line. The right half is mirrored, then the watch and chain are added.

Run:  python3 tools/sprites/rabbit_px.py   (needs: pip install pillow)
Writes strips and manifest.json into extension/public/characters/rabbit/
"""
import json
import os
from PIL import Image

W, H = 64, 58
# The rabbit was drawn on a 48 wide cell. OFF is the columns added on the left when the cell
# was widened for the thought bubble, so every absolute column below is still in 48 wide terms.
OFF = (W - 48) // 2
CX = 23 + OFF  # the left of the two centre columns; the right one is CX + 1
PAL = {
    ".": (0, 0, 0, 0),
    "o": (59, 42, 35, 255),      # outline, dark brown
    "w": (255, 250, 240, 255),   # fur
    "s": (230, 216, 197, 255),   # fur shade
    "p": (246, 186, 186, 255),   # inner ear
    "e": (42, 31, 51, 255),      # eye
    "h": (255, 255, 255, 255),   # eye shine, teeth
    "n": (233, 138, 147, 255),   # nose
    "b": (247, 171, 163, 255),   # blush
    "m": (122, 51, 64, 255),     # mouth inside
    "M": (240, 143, 160, 255),   # tongue
    "c": (217, 83, 79, 255),     # bow tie
    "C": (170, 56, 58, 255),     # bow knot
    "j": (222, 168, 72, 255),    # jacket
    "k": (181, 127, 44, 255),    # jacket check lines
    "t": (47, 143, 131, 255),    # waistcoat
    "u": (35, 110, 101, 255),    # waistcoat edge
    "g": (242, 193, 78, 255),    # gold
    "f": (255, 253, 245, 255),   # watch face
    "H": (42, 31, 45, 255),      # hole
    "L": (91, 70, 97, 255),      # hole lip
    "R": (255, 248, 231, 255),   # sticker rim
    "y": (242, 193, 78, 255),    # glyphs
}

EAR_UP = {
    3: [(5, 6, "o")],
    4: [(4, 4, "o"), (5, 6, "w"), (7, 7, "o")],
    5: [(3, 3, "o"), (4, 7, "w"), (8, 8, "o")],
    **{r: [(3, 3, "o"), (4, 4, "w"), (5, 6, "p"), (7, 7, "w"), (8, 8, "o")] for r in range(6, 15)},
    15: [(3, 3, "o"), (4, 7, "w"), (8, 8, "o")],
}
EAR_FLOP = {
    8: [(5, 13, "o")],
    9: [(4, 4, "o"), (5, 13, "w"), (14, 14, "o")],
    10: [(3, 3, "o"), (4, 7, "w"), (8, 13, "p"), (14, 14, "w"), (15, 15, "o")],
    11: [(3, 3, "o"), (4, 8, "w"), (9, 13, "p"), (14, 14, "w"), (15, 15, "o")],
    12: [(3, 3, "o"), (4, 7, "w"), (8, 14, "o")],
    13: [(3, 3, "o"), (4, 7, "w"), (8, 8, "o")],
    14: [(3, 3, "o"), (4, 7, "w"), (8, 8, "o")],
    15: [(3, 3, "o"), (4, 7, "w"), (8, 8, "o")],
}
BODY = {
    16: [(0, 3, "o"), (4, 7, "w"), (8, 8, "o")],
    17: [(0, 7, "w"), (8, 8, "o")],
    18: [(0, 8, "w"), (9, 9, "o")],
    19: [(0, 9, "w"), (10, 10, "o")],
    **{r: [(0, 10, "w"), (11, 11, "o")] for r in range(20, 30)},
    30: [(0, 7, "w"), (8, 9, "s"), (10, 10, "o")],
    31: [(0, 4, "w"), (5, 8, "s"), (9, 9, "o")],
    32: [(0, 6, "s"), (7, 8, "o")],
    33: [(0, 6, "o")],
    34: [(0, 0, "C"), (1, 3, "c"), (4, 4, "o"), (5, 7, "j"), (8, 8, "o")],
    35: [(0, 0, "C"), (1, 3, "c"), (4, 4, "o"), (5, 6, "j"), (7, 7, "k"), (8, 8, "j"), (9, 9, "o")],
    36: [(0, 3, "o"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 8, "j"), (9, 9, "o")],
    37: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 8, "j"), (9, 9, "o")],
    38: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 8, "j"), (9, 9, "o")],
    39: [(0, 3, "t"), (4, 4, "u"), (5, 8, "k"), (9, 9, "o")],
    40: [(0, 0, "g"), (1, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 9, "j"), (10, 10, "o")],
    41: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 9, "j"), (10, 10, "o")],
    42: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "k"), (8, 9, "j"), (10, 10, "o")],
    43: [(0, 3, "t"), (4, 4, "u"), (5, 9, "k"), (10, 10, "o")],
    44: [(0, 0, "g"), (1, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "o"), (8, 9, "k"), (10, 10, "o")],
    45: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "o"), (8, 9, "w"), (10, 10, "o")],
    46: [(0, 3, "t"), (4, 4, "u"), (5, 6, "j"), (7, 7, "o"), (8, 9, "w"), (10, 10, "o")],
    47: [(0, 3, "t"), (4, 4, "u"), (5, 6, "k"), (7, 10, "o")],
    48: [(0, 3, "t"), (4, 4, "u"), (5, 8, "j"), (9, 9, "o")],
    49: [(0, 8, "o")],
    50: [(2, 2, "o"), (3, 8, "w"), (9, 9, "o")],
    51: [(2, 2, "o"), (3, 9, "w"), (10, 10, "o")],
    52: [(2, 2, "o"), (3, 9, "s"), (10, 10, "o")],
    53: [(3, 9, "o")],
}
FACE = {
    22: [(5, 6, "e")],
    23: [(4, 7, "e")], 24: [(4, 7, "e")], 25: [(4, 7, "e")],
    26: [(5, 6, "e")],
    27: [(0, 0, "n"), (8, 9, "b")],
}
WATCH = ["..ooo..", ".ogggo.", "ogfofgo", "ogfoogo", "ogfffgo", ".ogggo.", "..ooo.."]  # rows 42..48, cols 34..40
CHAIN = [(41, 37), (40, 36), (39, 35), (38, 34)]

EYES = {
    "open": FACE,
    "wide": {21: [(5, 6, "e")], 22: [(4, 7, "e")], 23: [(4, 7, "e")], 24: [(4, 7, "e")], 25: [(4, 7, "e")], 26: [(5, 6, "e")]},
    "half": {23: [(4, 7, "o")], 24: [(4, 7, "e")], 25: [(4, 7, "e")], 26: [(5, 6, "e")]},
    "closed": {24: [(4, 4, "o"), (7, 7, "o")], 25: [(5, 6, "o")]},
    "happy": {23: [(5, 6, "o")], 24: [(4, 4, "o"), (7, 7, "o")]},
}
LOOK_SHINE = (2, 1)
SHINE = {"open": [(23, 17), (23, 29)], "wide": [(22, 17), (23, 17), (22, 29), (23, 29)],
         "half": [], "closed": [], "happy": []}
MOUTHS = {
    "smile": {28: [(0, 0, "o"), (3, 3, "o")], 29: [(0, 0, "h"), (1, 2, "o")], 30: [(0, 0, "h"), (1, 1, "o")], 31: [(0, 0, "o")]},
    "flat": {29: [(0, 2, "o")]},
    "open": {28: [(0, 1, "o")], 29: [(0, 1, "m"), (2, 2, "o")], 30: [(0, 1, "o")]},
    "wide": {28: [(0, 2, "o")], 29: [(0, 2, "m"), (3, 3, "o")], 30: [(0, 0, "M"), (1, 2, "m"), (3, 3, "o")], 31: [(0, 2, "o")]},
}
HOLES = {
    1: {52: [(0, 2, "L")], 53: [(0, 2, "L")]},
    2: {51: [(0, 5, "L")], 52: [(0, 5, "H"), (6, 8, "L")], 53: [(0, 5, "H"), (6, 8, "L")], 54: [(0, 5, "L")]},
    3: {50: [(0, 8, "L")], 51: [(0, 8, "H"), (9, 12, "L")], 52: [(0, 12, "H"), (13, 14, "L")],
        53: [(0, 12, "H"), (13, 14, "L")], 54: [(0, 8, "H"), (9, 12, "L")], 55: [(0, 8, "L")]},
}
GLYPHS = {
    "?": [".yy.", "y..y", "...y", "..y.", "..y.", "....", "..y."],
    "z": ["yyyy", "..y.", ".y..", "yyyy"],
    "dot": ["yy", "yy"],
    "spark": [".y.", "yyy", ".y."],
}

# Thought bubble, hand-placed. Absolute columns are in the widened cell (OFF already applied
# by BUBBLE_AT). Cream fill (R) inside a one pixel brown outline, two trailing circles down
# toward the top right of the head, and a 9 x 9 pocket watch face or a light bulb inside.
BUBBLE = [
    "......oooooooo......",
    "....ooRRRRRRRRoo....",
    "...oRRRRRRRRRRRRo...",
    "..oRRRRRRRRRRRRRRo..",
    ".oRRRRRRRRRRRRRRRRo.",
    ".oRRRRRRRRRRRRRRRRo.",
    ".oRRRRRRRRRRRRRRRRo.",
    ".oRRRRRRRRRRRRRRRRo.",
    ".oRRRRRRRRRRRRRRRRo.",
    "..oRRRRRRRRRRRRRRo..",
    "...oRRRRRRRRRRRRo...",
    "....ooRRRRRRRRoo....",
    "......oooooooo......",
]
BUBBLE_AT = (43, 0)  # (col, row) of the top left of BUBBLE
TRAIL = [([".oo.", "oRRo", "oRRo", ".oo."], (47, 16)), ([".o.", "oRo", ".o."], (45, 22))]
CLOCK = [
    "...ooo...",
    ".oogggoo.",
    ".ogfffgo.",
    "ogfffffgo",
    "ogfffffgo",
    "ogfffffgo",
    ".ogfffgo.",
    ".oogggoo.",
    "...ooo...",
]
CLOCK_AT = (48, 2)
# One hand, two pixels long, ticking round: up, right, down, left. (row, col) inside CLOCK.
CLOCK_HANDS = [[(3, 4), (2, 4)], [(4, 5), (4, 6)], [(5, 4), (6, 4)], [(4, 3), (4, 2)]]
BULB = [
    "..ooo..",
    ".oyyyo.",
    "oyyyyyo",
    "oyhyyyo",
    "oyyyyyo",
    ".oyyyo.",
    "..ooo..",
    "..ogo..",
    "..ooo..",
]
BULB_AT = (49, 2)
BULB_SPARKS = [(46, 3), (57, 3)]


def stamp(g, art, x, y, sub=None):
    """Write an ASCII block onto the grid. No automatic outline; the block carries its own."""
    for j, row in enumerate(art):
        for i, ch in enumerate(row):
            if ch != "." and 0 <= y + j < H and 0 <= x + i < W:
                g[y + j][x + i] = sub.get(ch, ch) if sub else ch


def thought(g, inside=None):
    """Thought bubble with its trail. inside draws the contents after the bubble."""
    stamp(g, BUBBLE, *BUBBLE_AT)
    for art, (x, y) in TRAIL:
        stamp(g, art, x, y)
    if inside:
        inside(g)
    return g


def clock(tick):
    def draw(g):
        stamp(g, CLOCK, *CLOCK_AT)
        cx, cy = CLOCK_AT
        g[cy + 4][cx + 4] = "o"
        for r, c in CLOCK_HANDS[tick % 4]:
            g[cy + r][cx + c] = "o"
    return draw


def bulb(lit, sparks=False):
    def draw(g):
        stamp(g, BULB, *BULB_AT, sub=None if lit else {"y": "f", "h": "f"})
        if sparks:
            for x, y in BULB_SPARKS:
                stamp(g, GLYPHS["spark"], x, y)
    return draw


def blank():
    return [["."] * W for _ in range(H)]


def paint(g, spec, side="both", dy=0):
    for r, runs in spec.items():
        for a, b, ch in runs:
            for d in range(a, b + 1):
                if side in ("both", "left"):
                    g[r + dy][CX - d] = ch
                if side in ("both", "right"):
                    g[r + dy][CX + 1 + d] = ch


def clear_region(g, rows, a, b, ch="w"):
    for r in rows:
        for d in range(a, b + 1):
            g[r][CX - d] = ch
            g[r][CX + 1 + d] = ch


def rabbit(ear_l="up", ear_r="up", eyes="open", mouth="smile", look=False, perk=False, twitch=False):
    g = blank()
    for side, kind in (("left", ear_l), ("right", ear_r)):
        if kind == "up" and perk:
            paint(g, EAR_UP, side, dy=-2)
            paint(g, {14: EAR_UP[14], 15: EAR_UP[14]}, side)
            paint(g, {15: EAR_UP[15]}, side)
        elif kind == "up":
            paint(g, EAR_UP, side)
        else:
            paint(g, EAR_FLOP, side)
    if twitch:
        for r in range(3, 8):
            row = g[r][:]
            for c in range(CX + 1, W - 1):
                g[r][c + 1] = row[c]
            g[r][CX + 1] = "."
    paint(g, BODY)
    paint(g, {27: FACE[27]})
    paint(g, {k: v for k, v in EYES[eyes].items() if k != 27})
    for r, c in SHINE[eyes]:
        g[r][c + OFF] = "h"
    if look:
        # Glance down toward the watch. Both eye shapes stay where they are so the
        # face keeps its symmetry; only the shine moves, by LOOK_SHINE (rows, cols).
        for r, c in SHINE[eyes]:
            g[r][c + OFF] = "e"
        for r, c in SHINE[eyes]:
            g[r + LOOK_SHINE[0]][c + OFF + LOOK_SHINE[1]] = "h"
    clear_region(g, range(28, 31), 0, 3)
    g[31][CX] = g[31][CX + 1] = "w"
    paint(g, MOUTHS[mouth])
    for i, row in enumerate(WATCH):
        for j, ch in enumerate(row):
            if ch != ".":
                g[42 + i][34 + OFF + j] = ch
    for r, c in CHAIN:
        g[r][c + OFF] = "g"
    return g


def bob(g):
    out = [row[:] for row in g]
    for r in range(41, 0, -1):
        out[r] = g[r - 1][:]
    out[0] = ["."] * W
    return out


def moved(g, dx, dy):
    out = blank()
    for r in range(H):
        for c in range(W):
            if g[r][c] != "." and 0 <= r + dy < H and 0 <= c + dx < W:
                out[r + dy][c + dx] = g[r][c]
    return out


def over(base, top):
    out = [row[:] for row in base]
    for r in range(H):
        for c in range(W):
            if top[r][c] != ".":
                out[r][c] = top[r][c]
    return out


def glyph(g, name, x, y):
    for j, row in enumerate(GLYPHS[name]):
        for i, ch in enumerate(row):
            if ch != "." and 0 <= y + j < H and 0 <= x + i < W:
                g[y + j][x + i] = ch
    for j, row in enumerate(GLYPHS[name]):
        for i, ch in enumerate(row):
            if ch == ".":
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + j + dy, x + i + dx
                if 0 <= yy < H and 0 <= xx < W and g[yy][xx] == ".":
                    g[yy][xx] = "o"
    return g


def hole(size):
    g = blank()
    if size:
        paint(g, HOLES[size])
    return g


def in_hole(g, depth):
    sunk = moved(g, 0, depth)
    for r in range(53, H):
        sunk[r] = ["."] * W
    out = over(hole(3), sunk)
    front = hole(3)
    for r in range(0, 53):
        front[r] = ["."] * W
    return over(out, front)


def rim(g):
    out = [row[:] for row in g]
    for r in range(H):
        for c in range(W):
            if g[r][c] == ".":
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    yy, xx = r + dy, c + dx
                    if 0 <= yy < H and 0 <= xx < W and g[yy][xx] != ".":
                        out[r][c] = "R"
                        break
    return out


def image(g):
    im = Image.new("RGBA", (W, H))
    im.putdata([PAL[ch] for row in g for ch in row])
    return im


def patch(rows, a, b, draw):
    base = rabbit()
    g = blank()
    for r in rows:
        for d in range(a, b + 1):
            for c in (CX - d, CX + 1 + d):
                if base[r][c] != ".":
                    g[r][c] = "w" if base[r][c] in "ehonm" else base[r][c]
    top = blank()
    draw(top)
    return over(g, top)


def build():
    S = {}
    a, b = rabbit(), rabbit(twitch=True)
    S["idle"] = dict(frames=[a, b, bob(a), bob(a)], fps=3, loop=True, head_dy=[0, 0, 1, 1])
    S["listening"] = dict(frames=[a, rabbit(perk=True, eyes="wide"), rabbit(perk=True, eyes="wide")], fps=8, loop=False,
                          head_dy=[0, 0, 0])
    S["thinking"] = dict(frames=[thought(rabbit(look=True, mouth="flat"), clock(i)) for i in range(4)], fps=3, loop=True)
    S["aha"] = dict(frames=[thought(rabbit(look=True, mouth="flat"), bulb(False)),
                            thought(rabbit(mouth="flat"), bulb(True)),
                            thought(rabbit(eyes="wide", mouth="open"), bulb(True, sparks=True)),
                            rabbit()], fps=6, loop=False)
    cf = []
    for i in range(4):
        g = rabbit(ear_l="flop", mouth="flat", eyes="wide" if i % 2 else "open")
        glyph(g, "?", 40 + OFF, 8 + (0, -1, 0, 1)[i])
        cf.append(g)
    S["confused"] = dict(frames=cf, fps=4, loop=True)
    ce = []
    for i, dy in enumerate((0, -2, -3, -2, 0, 0)):
        g = rabbit(eyes="happy", mouth="open")
        g = bob(g) if i == 5 else moved(g, 0, dy)
        for k, (sx, sy) in enumerate(((2, 24), (43, 20), (3, 40), (44, 36))):
            if (i + k) % 3 == 0:
                glyph(g, "spark", sx + OFF, sy)
        ce.append(g)
    S["celebrate"] = dict(frames=ce, fps=9, loop=False)
    S["wave"] = dict(frames=[rabbit(eyes="happy", mouth="open", ear_l=e) for e in ("up", "flop", "up", "flop")],
                     fps=5, loop=False)
    sl = []
    for i in range(4):
        g = rabbit(ear_l="flop", ear_r="flop", eyes="closed", mouth="flat")
        if i in (1, 2):
            g = bob(g)
        for k, (zx, zy) in enumerate(((38, 14), (41, 8), (44, 2))):
            if k < (1, 2, 3, 3)[i]:
                glyph(g, "z", zx + OFF, zy)
        sl.append(g)
    S["sleepy"] = dict(frames=sl, fps=2, loop=True)
    S["dragged"] = dict(frames=[moved(rabbit(eyes="wide", mouth="wide"), dx, -2) for dx in (-1, 1)], fps=4, loop=True)

    S["hole_only"] = dict(frames=[hole(1), hole(2), hole(3)], fps=10, loop=False)
    S["hole_open"] = dict(frames=[over(hole(n), a) for n in (1, 2, 3)], fps=10, loop=False)
    fall = rabbit(eyes="wide", mouth="open")
    S["dive"] = dict(frames=[in_hole(fall, d) for d in (0, 5, 12, 21, 32, 44, 58)], fps=12, loop=False)
    S["hole_wait"] = dict(frames=[in_hole(rabbit(perk=True, twitch=t), 37) for t in (False, True, False, False)],
                          fps=4, loop=True)

    S["overlay_blink"] = dict(frames=[patch(range(21, 27), 4, 7, lambda g, k=k: paint(g, EYES[k]))
                                      for k in ("half", "closed", "half")], fps=12, loop=False)
    S["overlay_mouth"] = dict(frames=[patch(range(28, 32), 0, 3, lambda g, k=k: paint(g, MOUTHS[k]))
                                      for k in ("flat", "open", "wide", "smile")], fps=0, loop=False)
    for st in S.values():
        raw = st["frames"]
        st["frames"] = [f if st is S["overlay_blink"] or st is S["overlay_mouth"] else rim(f) for f in raw]
    return S


NOTES = {
    "idle": "Ear twitch, then a one pixel breath. head_dy tells the renderer how far to push overlays down per frame.",
    "listening": "Ears stretch up, eyes widen. Hold the last frame while the kid talks.",
    "thinking": "He glances at his watch while a pocket watch ticks in a thought bubble. Loop while the model works.",
    "aha": "The watch turns into a light bulb and the bubble pops. Play once when the answer is ready, then idle.",
    "confused": "One ear flops over and a question mark bobs.",
    "celebrate": "A hop with happy eyes and sparkles, landing with a squash. Play once.",
    "wave": "He waves with his ear. Use for greetings.",
    "sleepy": "Both ears flopped, eyes shut, z's rising. Bedtime and session limits.",
    "dragged": "Startled and swinging while the kid drags him.",
    "hole_only": "An empty rabbit hole opening. Reverse it to close.",
    "hole_open": "The hole opens under his feet. Reverse it to close once he has popped out.",
    "dive": "He drops into the hole. Reverse it to pop out on the other screen.",
    "hole_wait": "Ears poking out of the hole. Loop while the handoff completes.",
    "overlay_blink": "Eye patch: half, closed, half. Draw over idle, offset by head_dy.",
    "overlay_mouth": "Mouth patch: 0 flat, 1 open, 2 wide, 3 smile. Pick by voice loudness. Offset by head_dy.",
}


OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "characters", "rabbit")


def export(S, out=OUT):
    os.makedirs(out, exist_ok=True)
    man = {"character": "rabbit", "cell": [W, H], "anchor": "bottom center, feet end at row 53",
           "display": "whole-number scale only, image-rendering: pixelated",
           "jump_sequence": {"sending": ["hole_open", "dive", "hole_only reversed"],
                             "receiving": ["hole_only", "hole_wait (loop)", "dive reversed", "hole_open reversed", "idle"]},
           "body": list(image(S["idle"]["frames"][0]).getbbox()),
           "body_note": "left, top, right, bottom of the rabbit in idle frame 0, rim included, right and bottom exclusive",
           "states": {}}
    for name, st in S.items():
        strip = Image.new("RGBA", (W * len(st["frames"]), H))
        for i, f in enumerate(st["frames"]):
            strip.paste(image(f), (i * W, 0))
        path = os.path.join(out, f"rabbit_{name}.png")
        if not same_pixels(path, strip):
            strip.save(path)
        entry = {"file": f"rabbit_{name}.png", "frames": len(st["frames"]), "fps": st["fps"], "loop": st["loop"],
                 "notes": NOTES[name]}
        if "head_dy" in st:
            entry["head_dy"] = st["head_dy"]
        man["states"][name] = entry
    with open(os.path.join(out, "manifest.json"), "w", newline="\n") as fh:
        json.dump(man, fh, indent=2)
        fh.write("\n")
    return man


def same_pixels(path, im):
    """True when the PNG at path already holds exactly these pixels, so git does not see a re-encoded file."""
    if not os.path.exists(path):
        return False
    old = Image.open(path).convert("RGBA")
    return old.size == im.size and old.tobytes() == im.tobytes()


if __name__ == "__main__":
    S = build()
    m = export(S)
    print("frames:", sum(v["frames"] for v in m["states"].values()))
    print("\n".join("".join(r) for r in rabbit()))
