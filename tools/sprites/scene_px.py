"""
Burrow: the meadow behind the new tab page, hand-placed pixels.

Every piece is an ASCII block or a run list, one pixel outlines, no rasterized curves. The hills
and the hedge are column heights written as runs (7, 5, 4, 3, 2, 1, 1 into the crest), the way
the rabbit's curves step. Animation only swaps whole frames; the page moves pieces by whole
source pixels and draws everything at 3x with smoothing off.

Colors are symbols. Each time of day maps the same symbols to its own palette, so one drawing
becomes four atlases: scene_morning.png, scene_day.png, scene_evening.png, scene_night.png.
The wooden sign, the post and the clock digits do not change with the light.

Run:  python tools/sprites/scene_px.py
      python tools/sprites/scene_px.py --sheet out.png   (every piece at 4x on each sky, for a look)
Writes extension/public/scene/. PNGs whose pixels did not change are left alone.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw  # noqa: E402
from rabbit_px import PAL  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "extension", "public", "scene")
ATLAS_W = 256
TODS = ("morning", "day", "evening", "night")

# Symbols that look the same at every hour: the rabbit's outline brown, cream, his hole colors,
# and the painted wood of the signs the kid types on.
COMMON = {
    "o": PAL["o"],
    "R": PAL["R"],
    "H": PAL["H"],
    "J": PAL["L"],
    "I": PAL["o"],
    "!": (255, 110, 140),       # heart
    "$": PAL["g"],              # sparkle, door knob
    "X": PAL["c"],              # the speaker's off cross
    "_": (44, 31, 26),          # boot earth
    "=": (58, 42, 34),          # boot earth, lighter grain
    "%": (150, 110, 200),       # rainbow violet
}
WOOD_DAY = {"W": (232, 201, 150), "x": (200, 160, 110), "p": (166, 116, 70), "P": (122, 82, 50)}
# Per time of day. Keys: K1..K6 sky bands top to bottom; c C S cloud line, fill, shade; f F far hill
# line, fill; n N j near hill line, fill, light; e E d hedge line, fill, dark leaf; g G k grass, dark
# grass, grass line; b B v h bush fill, dark, line, light; r y w z flower red, gold, white, center;
# m M s mushroom cap, spot, stem; u U q sun light, mid, line; L l moon; * + star bright, dim;
# Y i firefly on, off; | rain; D t dirt, dark dirt; a A smoke; W x p P wood board, grain, post, post shade;
# O Q carrot, carrot shade; ~ ^ pond water, water light; T V flamingo, flamingo dark.
TOD_PAL = {
    "morning": {
        "~": (98, 164, 216), "^": (156, 208, 242), "T": (244, 140, 160), "V": (200, 90, 120),
        "1": (240, 150, 205), "2": (205, 105, 175),
        "O": (236, 120, 40), "Q": (196, 86, 30),
        "K1": (108, 158, 218), "K2": (136, 180, 226), "K3": (166, 200, 232), "K4": (206, 208, 214), "K5": (236, 210, 196), "K6": (252, 228, 190),
        "c": (206, 190, 204), "C": (255, 250, 246), "S": (240, 222, 224),
        "f": (112, 168, 150), "F": (150, 202, 176), "n": (78, 142, 90), "N": (110, 178, 112), "j": (132, 196, 128),
        "e": (40, 92, 50), "E": (84, 150, 80), "d": (58, 116, 60),
        "g": (128, 198, 96), "G": (104, 172, 78), "k": (62, 124, 54),
        "b": (92, 166, 86), "B": (64, 128, 64), "v": (38, 88, 44), "h": (140, 206, 116),
        "r": (232, 96, 104), "y": (242, 193, 78), "w": (255, 250, 240), "z": (242, 193, 78),
        "m": (217, 83, 79), "M": (255, 250, 240), "s": (240, 222, 190),
        "u": (255, 238, 160), "U": (252, 206, 96), "q": (236, 172, 66),
        "L": (255, 250, 220), "l": (232, 222, 184),
        "*": (255, 255, 240), "+": (210, 214, 230),
        "Y": (255, 240, 120), "i": (200, 180, 80), "|": (180, 204, 232),
        "D": (200, 152, 98), "t": (150, 108, 66), "a": (240, 236, 232), "A": (214, 208, 204),
        **WOOD_DAY,
    },
    "day": {
        "~": (94, 160, 214), "^": (150, 204, 240), "T": (244, 140, 160), "V": (200, 90, 120),
        "1": (240, 150, 205), "2": (205, 105, 175),
        "O": (236, 120, 40), "Q": (196, 86, 30),
        "K1": (72, 138, 208), "K2": (90, 156, 218), "K3": (108, 174, 228), "K4": (128, 190, 236), "K5": (150, 204, 240), "K6": (180, 222, 246),
        "c": (176, 196, 214), "C": (255, 253, 245), "S": (214, 228, 238),
        "f": (96, 160, 124), "F": (126, 192, 150), "n": (66, 132, 72), "N": (92, 168, 96), "j": (112, 186, 108),
        "e": (32, 76, 38), "E": (72, 142, 72), "d": (48, 106, 50),
        "g": (120, 190, 84), "G": (98, 166, 70), "k": (58, 120, 52),
        "b": (86, 158, 80), "B": (60, 120, 58), "v": (36, 84, 40), "h": (134, 200, 110),
        "r": (232, 96, 104), "y": (242, 193, 78), "w": (255, 250, 240), "z": (242, 193, 78),
        "m": (217, 83, 79), "M": (255, 250, 240), "s": (240, 222, 190),
        "u": (255, 240, 160), "U": (252, 208, 96), "q": (236, 170, 60),
        "L": (255, 250, 220), "l": (232, 222, 184),
        "*": (255, 255, 240), "+": (210, 214, 230),
        "Y": (255, 240, 120), "i": (200, 180, 80), "|": (170, 200, 230),
        "D": (196, 150, 96), "t": (150, 108, 66), "a": (238, 238, 240), "A": (206, 208, 214),
        **WOOD_DAY,
    },
    "evening": {
        "~": (120, 124, 176), "^": (216, 170, 160), "T": (236, 130, 150), "V": (190, 84, 112),
        "1": (232, 142, 194), "2": (196, 98, 166),
        "O": (230, 112, 40), "Q": (186, 80, 30),
        "K1": (52, 44, 104), "K2": (84, 58, 118), "K3": (130, 80, 124), "K4": (190, 104, 110), "K5": (226, 130, 92), "K6": (250, 186, 104),
        "c": (186, 112, 116), "C": (255, 214, 174), "S": (236, 160, 138),
        "f": (112, 84, 120), "F": (150, 116, 140), "n": (74, 108, 82), "N": (102, 142, 98), "j": (124, 160, 110),
        "e": (34, 72, 44), "E": (66, 124, 68), "d": (46, 94, 50),
        "g": (116, 172, 86), "G": (96, 148, 70), "k": (56, 108, 50),
        "b": (82, 146, 80), "B": (56, 108, 56), "v": (34, 76, 40), "h": (124, 182, 104),
        "r": (222, 90, 98), "y": (238, 184, 72), "w": (250, 236, 220), "z": (236, 180, 70),
        "m": (210, 80, 76), "M": (250, 238, 220), "s": (232, 210, 176),
        "u": (255, 222, 120), "U": (250, 176, 70), "q": (230, 130, 50),
        "L": (255, 244, 200), "l": (230, 214, 160),
        "*": (255, 250, 220), "+": (210, 190, 200),
        "Y": (255, 240, 120), "i": (200, 180, 80), "|": (200, 170, 170),
        "D": (190, 142, 92), "t": (140, 100, 62), "a": (236, 220, 214), "A": (206, 186, 186),
        "W": (236, 196, 140), "x": (200, 152, 100), "p": (160, 108, 64), "P": (116, 76, 46),
    },
    "night": {
        "~": (34, 52, 96), "^": (72, 94, 140), "T": (150, 90, 110), "V": (110, 60, 80),
        "1": (140, 84, 128), "2": (108, 62, 104),
        "O": (150, 84, 44), "Q": (110, 58, 30),
        "K1": (14, 18, 44), "K2": (18, 24, 54), "K3": (24, 30, 66), "K4": (32, 40, 82), "K5": (40, 50, 96), "K6": (50, 62, 110),
        "c": (46, 52, 84), "C": (84, 94, 130), "S": (64, 72, 106),
        "f": (36, 60, 84), "F": (52, 80, 104), "n": (26, 50, 60), "N": (38, 68, 80), "j": (48, 82, 92),
        "e": (16, 38, 36), "E": (32, 66, 60), "d": (24, 50, 46),
        "g": (42, 88, 68), "G": (34, 74, 58), "k": (22, 48, 38),
        "b": (38, 78, 66), "B": (28, 58, 50), "v": (18, 40, 34), "h": (52, 100, 82),
        "r": (150, 70, 82), "y": (164, 132, 66), "w": (184, 186, 176), "z": (160, 130, 70),
        "m": (140, 60, 62), "M": (184, 180, 166), "s": (166, 156, 136),
        "u": (255, 240, 160), "U": (252, 208, 96), "q": (236, 170, 60),
        "L": (255, 250, 220), "l": (226, 218, 178),
        "*": (255, 255, 240), "+": (150, 160, 200),
        "Y": (255, 240, 120), "i": (170, 150, 70), "|": (110, 130, 170),
        "D": (110, 84, 60), "t": (80, 58, 40), "a": (120, 124, 140), "A": (96, 100, 118),
        "W": (150, 130, 100), "x": (120, 102, 76), "p": (100, 76, 52), "P": (70, 52, 36),
    },
}


# ---------- drawing helpers ----------

def profile(base, steps):
    """Column heights from hand-placed runs. steps: ("flat", n), ("up", [runs]) or ("down", [runs]).
    Each up run sits one pixel higher than the last; down mirrors it, so a crest reads 7, 5, 4, 3, 2, 1, 1."""
    h, cols = base, []
    for kind, arg in steps:
        if kind == "flat":
            cols += [h] * arg
        elif kind == "up":
            for n in arg:
                h += 1
                cols += [h] * n
        else:
            for n in arg:
                cols += [h] * n
                h -= 1
    return cols


def from_heights(cols, fill, line, band=None):
    """A tile from column heights. The top pixel of each column is the outline; band colors the row under it."""
    tall = max(cols)
    rows = [["."] * len(cols) for _ in range(tall)]
    for x, h in enumerate(cols):
        for y in range(tall - h, tall):
            rows[y][x] = fill
        rows[tall - h][x] = line
        if band and h > 1:
            rows[tall - h + 1][x] = band
    return rows


def grid(w, h):
    return [["."] * w for _ in range(h)]


def stamp(g, art, x, y):
    for j, row in enumerate(art):
        for i, ch in enumerate(row):
            if ch != "." and 0 <= y + j < len(g) and 0 <= x + i < len(g[0]):
                g[y + j][x + i] = ch


def rows_of(g):
    return ["".join(r) for r in g]


def mirror(art):
    return [row[::-1] for row in art]


def rim(art):
    """One pixel cream rim around everything, like the rabbit's sticker edge."""
    h, w = len(art), len(art[0])
    g = [list(r) for r in art]
    for y in range(h):
        for x in range(w):
            if art[y][x] == ".":
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and art[yy][xx] != ".":
                        g[y][x] = "R"
                        break
    return rows_of(g)


def pad(art, n=1):
    w = len(art[0])
    return ["." * (w + 2 * n)] * n + ["." * n + r + "." * n for r in art] + ["." * (w + 2 * n)] * n


# ---------- clouds ----------

CLOUD_A = [
    "........cccc........",
    "......ccCCCCcc......",
    ".....cCCCCCCCCc.....",
    "...ccCCCCCCCCCCcc...",
    "..cCCCCCCCCCCCCCCcc.",
    ".cCCCCCCCCCCCCCCCCCc",
    ".cCCCCCCCCCCCCCCCCCc",
    ".cSSSSSSSSSSSSSSSSSc",
    "..cccccccccccccccc..",
]
CLOUD_B = [
    "..........cccc..............",
    "........ccCCCCcc............",
    ".......cCCCCCCCCc....ccc....",
    "......cCCCCCCCCCCc..cCCCc...",
    "....ccCCCCCCCCCCCCccCCCCCc..",
    "...cCCCCCCCCCCCCCCCCCCCCCCc.",
    "..cCCCCCCCCCCCCCCCCCCCCCCCCc",
    ".cCCCCCCCCCCCCCCCCCCCCCCCCCc",
    ".cCCCCCCCCCCCCCCCCCCCCCCCCCc",
    ".cSSSSSSSSSSSSSSSSSSSSSSSSSc",
    "..cccccccccccccccccccccccc..",
]
CLOUD_C = [
    ".....cccc.....",
    "...ccCCCCcc...",
    "..cCCCCCCCCc..",
    ".cCCCCCCCCCCc.",
    ".cCCCCCCCCCCc.",
    ".cSSSSSSSSSSc.",
    "..cccccccccc..",
]

# ---------- hills and hedge, from run lists ----------

FAR_HILLS = profile(6, [
    ("flat", 4),
    ("up", [6, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), ("flat", 6),
    ("down", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4, 6]),
    ("flat", 10),
    ("up", [5, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]), ("flat", 4), ("down", [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 5]),
    ("flat", 8),
    ("up", [7, 4, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), ("flat", 5), ("down", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 7]),
    ("flat", 6),
])
NEAR_HILLS = profile(8, [
    ("flat", 14),
    ("up", [9, 6, 4, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]), ("flat", 10), ("down", [1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4, 6, 9]),
    ("flat", 20),
    ("up", [7, 4, 3, 2, 1, 1, 1, 1]), ("flat", 6), ("down", [1, 1, 1, 1, 2, 3, 4, 7]),
    ("flat", 22),
    ("up", [10, 6, 4, 3, 2, 1, 1, 1, 1, 1, 1]), ("flat", 12), ("down", [1, 1, 1, 1, 1, 1, 2, 3, 4, 6, 10]),
    ("flat", 10),
])
HEDGE_COLS = profile(9, [
    ("flat", 1), ("up", [2, 1, 1, 1]), ("flat", 2), ("down", [1, 1, 1, 2]), ("flat", 1),
    ("flat", 1), ("up", [2, 1, 1, 1]), ("flat", 2), ("down", [1, 1, 1, 2]), ("flat", 1),
    ("flat", 1), ("up", [2, 1, 1, 1]), ("flat", 2), ("down", [1, 1, 1, 2]), ("flat", 1),
])
# Dark leaves inside the hedge, (col, row) from the tile's top.
HEDGE_LEAVES = [(2, 7), (7, 9), (10, 5), (14, 10), (19, 8), (23, 6), (27, 9), (31, 7), (35, 10), (5, 11), (17, 11), (29, 11), (38, 5), (40, 9)]


def hedge():
    g = from_heights(HEDGE_COLS, "E", "e")
    for x, y in HEDGE_LEAVES:
        if g[y][x] == "E":
            g[y][x] = "d"
    g[-1] = ["d"] * len(HEDGE_COLS)
    return rows_of(g)


GROUND = [
    "gggggggggggggggggggggggggggggggg",
    "ggGGggggggggggggggGgggggggggggGG",
    "ggggggggggGggggggggggggggggggggg",
    "gggggggggggggggggggggggGGggggggg",
    "ggggGgggggggggggggggggggggggGggg",
    "gggggggggggggggGGggggggggggggggg",
    "gGgggggggggggggggggggggggggggggg",
    "ggggggggggGgggggggggggggggggggGg",
    "gggggggggggggggggggGGggggggggggg",
    "gggGGggggggggggggggggggggGgggggg",
    "gggggggggggggGgggggggggggggggggg",
    "ggggggggggggggggggggggggggggGGgg",
    "ggggggGgggggggggggggggGggggggggg",
    "gggggggggggggggggggggggggggggggg",
    "gGGgggggggggggGGgggggggggggggGgg",
    "gggggggggggggggggggggggggggggggg",
]
# A dirt path tile: bare earth with a grass edge and a few stones.
PATH = [
    "kkkkkkkkkkkkkkkkkkkkkkkk",
    "DDDDDDDDtDDDDDDDDDDDtDDD",
    "DDtDDDDDDDDDDDDtDDDDDDDD",
    "DDDDDDDDDDDDDDDDDDDDDDDD",
    "DDDDDtDDDDDDtDDDDDDDDDtD",
    "kkkkkkkkkkkkkkkkkkkkkkkk",
]

# ---------- bushes, tufts, flowers, mushrooms ----------

BUSH_A = [
    "......vvvv........",
    "....vvbbbbvv......",
    "...vbhhbbbbbvvv...",
    "..vbhbbbbbbbbbbv..",
    ".vbbbbbbbbbbbbbbv.",
    ".vbbbbbbbBbbbbbbv.",
    "vbbbBbbbbbbbbBbbbv",
    "vbBbbbbbBbbbbbbBbv",
    "vBBbbbBBbbbbBBbBBv",
    ".vvvvvvvvvvvvvvvv.",
]
BUSH_B = [
    "....vvvv....",
    "..vvbhhbvv..",
    ".vbbhbbbbbv.",
    ".vbbbbbbbbv.",
    "vbbbBbbbbBbv",
    "vbBbbbbBbbbv",
    "vBBbbBBbbBBv",
    ".vvvvvvvvvv.",
]
BUSH_C = [
    ".......vvvv.......vvvv....",
    ".....vvbbbbvv...vvbbbbvv..",
    "....vbhhbbbbbvvvbbhbbbbbv.",
    "...vbhbbbbbbbbbbbbbbbbbbbv",
    "..vbbbbbbbbbbbbbbbbbbbbbbv",
    ".vbbbbbbbbBbbbbbbbbbBbbbbv",
    ".vbbbBbbbbbbbbbBbbbbbbbbbv",
    "vbbbbbbbBbbbbbbbbbbbbBbbbv",
    "vbBbbbbbbbbbbBbbbbbbbbbbBv",
    "vBBbbbBBbbbbBBbbbBBbbbBBBv",
    ".vvvvvvvvvvvvvvvvvvvvvvvv.",
]
# A berry bush: bush_b with red berries.
BUSH_D = [
    "....vvvv....",
    "..vvbhhbvv..",
    ".vbbhbbrbbv.",
    ".vbrbbbbbbv.",
    "vbbbBbbbbrbv",
    "vbBbbrbBbbbv",
    "vBBbbBBbbBBv",
    ".vvvvvvvvvv.",
]
TUFT_A = [[
    "k.....k",
    ".k.k.k.",
    ".k.k.k.",
    "..kkk..",
    "...k...",
], [
    ".k....k",
    "..k.k.k",
    "..kk.k.",
    "...kk..",
    "...k...",
]]
TUFT_B = [[
    "k...k",
    ".k.k.",
    ".kkk.",
    "..k..",
], [
    ".k..k",
    "..kk.",
    "..kk.",
    "..k..",
]]
# Long grass: five blades, leaning in the second frame.
TUFT_C = [[
    "k...k...k",
    "k.k.k.k.k",
    ".k.k.k.k.",
    ".k.k.k.k.",
    "..kkkkk..",
    "....k....",
], [
    ".k...k..k",
    ".k.k..k.k",
    "..k.k.kk.",
    "..k.k.k..",
    "...kkkk..",
    "....k....",
]]
FLOWER_R = [[
    "..r..",
    ".rrr.",
    "rrzrr",
    ".rrr.",
    "..k..",
    "k.k..",
    ".kk..",
    "..k..",
], [
    ".rrr.",
    "rrrrr",
    "rrzrr",
    "rrrrr",
    ".rrr.",
    "k.k..",
    ".kk..",
    "..k..",
]]
FLOWER_Y = [[
    "..y..",
    ".yyy.",
    "yyoyy",
    ".yyy.",
    "..k..",
    "..k.k",
    "..kk.",
    "..k..",
], [
    ".yyy.",
    "yyyyy",
    "yyoyy",
    "yyyyy",
    ".yyy.",
    "..k.k",
    "..kk.",
    "..k..",
]]
FLOWER_W = [[
    ".w.w.",
    "wwzww",
    ".wzw.",
    "wwzww",
    ".w.w.",
    "..k..",
    "..k..",
], [
    "w.w.w",
    ".wzw.",
    "wzzzw",
    ".wzw.",
    "w.w.w",
    "..k..",
    "..k..",
]]
# A small clover of three white dots that opens into five.
FLOWER_S = [[
    "w.w",
    ".w.",
    ".k.",
    ".k.",
], [
    "www",
    "w.w",
    ".k.",
    ".k.",
]]
MUSH_A = [
    "..ooo..",
    ".omMmo.",
    "oMmmmMo",
    "ommMmmo",
    "ooooooo",
    "..oso..",
    "..oso..",
    "..ooo..",
]
MUSH_B = [
    ".ooo.",
    "omMmo",
    "ooooo",
    ".oso.",
    ".ooo.",
]
# Two brown toadstools side by side.
MUSH_C = [
    "..ooo...ooo..",
    ".oDtDo.oDtDo.",
    "oDDDDDoDDDDDo",
    "ooooooooooooo",
    "..oso...oso..",
    "..oso...oso..",
    "..ooo...ooo..",
]

# ---------- things the kid can pick up or make happen ----------

# A carrot in the patch: leaves and an orange shoulder showing through the soil.
CARROT_TOP = [
    "k..k..k",
    ".k.k.k.",
    "..kkk..",
    ".oOOOo.",
    "..oOo..",
    "...o...",
]
# The pulled carrot, carried under the cursor.
CARROT = [
    "k..k..k",
    ".k.k.k.",
    "..kkk..",
    "..ooo..",
    ".oOOOo.",
    ".oOOOo.",
    ".oOQOo.",
    ".oOOOo.",
    "..oOo..",
    "..oOo..",
    "..oQo..",
    "...o...",
]
SPROUT = [
    ".h.h.",
    "h.h.h",
    ".hkh.",
    "..k..",
    "..k..",
]
HEART = [[
    ".!.!.",
    "!!!!!",
    "!!!!!",
    ".!!!.",
    "..!..",
], [
    ".....",
    ".!.!.",
    ".!!!.",
    "..!..",
    ".....",
], [
    ".....",
    ".....",
    "..!..",
    ".....",
    ".....",
]]
SPARKLE = [[".$.", "$$$", ".$."], ["...", ".$.", "..."]]
PETAL_R = ["rr"]
PETAL_Y = ["yy"]
PETAL_W = ["ww"]
SMOKE_RING = [[
    ".aaa.",
    "a...a",
    "a...a",
    "a...a",
    ".aaa.",
], [
    ".....",
    ".aaa.",
    ".a.a.",
    ".aaa.",
    ".....",
], [
    ".....",
    ".....",
    "..a..",
    ".....",
    ".....",
]]
# The round wooden door that fills his arch, with a gold knob. Same outline as ARCH.
DOOR = [
    "......oooooooo......",
    "....ooWWWWWWWWoo....",
    "...oWWWWxWWWxWWWo...",
    "..oWWWWxWWWWxWWWWo..",
    ".oWWWWWxWWWWxWWWWWo.",
    ".oWWWWWxWWWWxWWWWWo.",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWW$WWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oWWWWWWxWWWWxWWWWWWo",
    "oxxxxxxxxxxxxxxxxxxo",
]
EYES = ["M...M"]
# Concept flowers: what the kid taught him, planted along the front. Tall and bright above 0.6,
# plain above 0.3, wilted below.
CONCEPT_TALL = [[
    "..rrr..",
    ".rr$rr.",
    "rr$$$rr",
    ".rr$rr.",
    "..rrr..",
    "...k...",
    "...k...",
    "..kk...",
    "k..k...",
    ".kkk...",
    "...k...",
    "...k.k.",
    "...kk..",
    "...k...",
], [
    "...rrr.",
    "..rr$rr",
    ".rr$$$r",
    "..rr$rr",
    "...rrr.",
    "...k...",
    "...k...",
    "..kk...",
    "k..k...",
    ".kkk...",
    "...k...",
    "...k.k.",
    "...kk..",
    "...k...",
]]
CONCEPT_PLAIN = [[
    "..w..",
    ".wyw.",
    "..w..",
    "..k..",
    "..k..",
    ".k.k.",
    "..k..",
    "..k..",
], [
    "...w.",
    "..wyw",
    "...w.",
    "..k..",
    "..k..",
    ".k.k.",
    "..k..",
    "..k..",
]]
CONCEPT_WILTED = [
    ".tt..",
    "tDtt.",
    ".t.t.",
    "...t.",
    "...k.",
    "..k..",
    ".kk..",
    "..k..",
    "..k..",
]

# The dark earth the world is dug out of during the boot.
EARTH = [
    "_=______=_______",
    "________________",
    "___=______=____=",
    "________________",
    "=_____=_______=_",
    "________________",
    "___=______=_____",
    "_________=______",
    "_=______________",
    "______=______=__",
    "________________",
    "=___=_____=_____",
    "________________",
    "___=______=___=_",
    "_______=________",
    "________________",
]

# ---------- the Wonderland crowd: pond, oak, tea party, cards, roses, hills folk ----------

def oval(half_widths, fill, line):
    """A blob from hand-placed half widths per row (left to right symmetric), outlined one pixel."""
    w = 2 * max(half_widths) + 1
    cx = max(half_widths)
    g = grid(w, len(half_widths))
    for y, hw in enumerate(half_widths):
        for x in range(cx - hw, cx + hw + 1):
            g[y][x] = fill
    for y, hw in enumerate(half_widths):
        for x in range(cx - hw, cx + hw + 1):
            edge = x == cx - hw or x == cx + hw or y == 0 or y == len(half_widths) - 1
            if not edge and y > 0 and abs(x - cx) > half_widths[y - 1]:
                edge = True
            if not edge and y < len(half_widths) - 1 and abs(x - cx) > half_widths[y + 1]:
                edge = True
            if edge:
                g[y][x] = line
    return g


POND_HW = [10, 18, 24, 28, 30, 32, 33, 34, 34, 34, 34, 34, 34, 33, 32, 30, 28, 24, 18, 10]
POND_LIGHT = [[(20, 6), (21, 6), (40, 9), (41, 9), (30, 13), (31, 13), (50, 12), (12, 11), (58, 8)],
              [(22, 7), (23, 7), (42, 10), (43, 10), (28, 12), (29, 12), (52, 13), (14, 10), (56, 9)]]
LILY = [".BB", "BBB", "BrB"]
REED = ["D", "D", "k", "k", "k", "k", "k", "k", "k"]


def pond():
    frames = []
    for lights in POND_LIGHT:
        water = oval(POND_HW, "~", "k")
        g = grid(len(water[0]), len(water) + 7)
        stamp(g, rows_of(water), 0, 7)
        for x, y in lights:
            if g[y + 7][x] == "~":
                g[y + 7][x] = "^"
        stamp(g, LILY, 44, 14)
        stamp(g, LILY, 16, 20)
        stamp(g, LILY, 54, 22)
        for x, dy in ((5, 0), (8, 2), (11, 1), (60, 1), (63, 0)):
            stamp(g, REED, x, dy)
        frames.append(rows_of(g))
    return frames


DUCK = [[
    "..oo....",
    ".oRRoOO.",
    ".oRRo...",
    "oRRRRRo.",
    "oRRRRRRo",
    ".oooooo.",
], [
    "........",
    "..oo....",
    ".oRRoOO.",
    ".oRRo...",
    "oRRRRRRo",
    ".oooooo.",
]]
DUCKLING = [[
    ".oo.",
    "oyyO",
    ".oo.",
], [
    "....",
    ".oo.",
    "oyyO",
]]
FISH = [[
    "..OO.",
    "OOOOo",
    "..OO.",
], [
    ".OO..",
    "oOOOO",
    ".OO..",
]]
SPLASH = [[
    "^...^",
    ".^.^.",
    "..^..",
], [
    "^.^.^",
    ".....",
    "^...^",
]]
FLAMINGO = [[
    "..TTT....",
    ".TTTTT...",
    ".oTTTT...",
    "..o.TT...",
    "....TT...",
    "....TT...",
    "...TTTTT.",
    "..TTTTTTT",
    "..TTTTTTT",
    "...TTTTT.",
    "....VV...",
    ".....V...",
    ".....V...",
    ".....V...",
    ".....V...",
    ".....V...",
    "....VVV..",
], [
    "..TTT....",
    ".TTTTT...",
    ".oTTTT...",
    "..o.TT...",
    "....TT...",
    "....TT...",
    "...TTTTT.",
    "..TTTTTTT",
    "..TTTTTTT",
    "...TTTTT.",
    "....VV...",
    "....V.V..",
    "....V....",
    "....V....",
    "....V....",
    "....V....",
    "...VVV...",
]]
HOOP = [
    ".ooo.",
    "o...o",
    "o...o",
    "o...o",
]
# Card soldiers: a cream card with a head and stick limbs. Frames: step, step, salute.
def card(suit):
    mark = {
        "hearts": ["RXRXR", "XXXXX", ".XXX.", "..X.."],
        "spades": ["..o..", ".ooo.", "ooooo", "..o.."],
    }[suit]
    frames = []
    for pose in ("a", "b", "salute"):
        g = grid(11, 15)
        stamp(g, ["...ooo...", "..oRRRo..", "..oRoRo..", "..oRRRo.."], 1, 0)
        stamp(g, [".ooooooo.", "oRRRRRRRo", "oRRRRRRRo", "oRRRRRRRo", "oRRRRRRRo", "oRRRRRRRo", "oRRRRRRRo", ".ooooooo."], 1, 4)
        stamp(g, mark, 4, 6)
        if pose == "salute":
            stamp(g, ["o", "o", "o"], 10, 3)
            g[5][10] = "o"
            stamp(g, ["o"], 0, 7)
        else:
            stamp(g, ["o", "o"], 0, 6)
            stamp(g, ["o", "o"], 10, 6)
        if pose == "b":
            stamp(g, ["..o...o..", ".o.....o.", "oo.....oo"], 1, 12)
        else:
            stamp(g, ["..o...o..", "..o...o..", ".oo...oo."], 1, 12)
        frames.append(rows_of(g))
    return frames


OAK_HW = [4, 8, 11, 13, 15, 17, 18, 19, 20, 21, 21, 22, 22, 23, 23, 23, 23, 23, 23, 23, 22, 22, 22, 21, 21, 21, 20, 20, 19, 18, 17, 16, 15, 13, 11, 9, 7, 5]
OAK_DARK = [(8, 12), (9, 12), (14, 20), (30, 9), (31, 9), (36, 18), (37, 18), (20, 28), (21, 28), (12, 30), (33, 27), (5, 22), (40, 24), (26, 6), (18, 34), (28, 33)]
OAK_LIGHT = [(16, 4), (17, 4), (23, 9), (10, 16), (11, 16), (34, 14), (35, 14), (25, 17), (7, 26), (38, 30), (22, 24), (30, 3)]


def oak():
    crown = oval(OAK_HW, "b", "v")
    w = len(crown[0])
    g = grid(w, 62)
    # The swing's branch, laid first so the crown covers its inner end and it comes out from under the leaves.
    stamp(g, [".ooooooooooooo.", "oPppppppppppppo", ".ooooooooooooo."], 2, 33)
    stamp(g, rows_of(crown), 0, 0)
    for x, y in OAK_DARK:
        if g[y][x] == "b":
            g[y][x] = "B"
    for x, y in OAK_LIGHT:
        if g[y][x] == "b":
            g[y][x] = "h"
    # Trunk under the crown and roots at the foot.
    cx = w // 2
    for y in range(34, 61):
        stamp(g, ["oPppppo"], cx - 3, y)
    stamp(g, ["oPPppppPPo"], cx - 5, 60)
    stamp(g, ["oPPppppPPo"], cx - 5, 61)
    return rows_of(g)


SWING = [[
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    "ooooooooooo..",
    "oWWWWWWWWWo..",
    "ooooooooooo..",
], [
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    ".x.......x...",
    "..x.......x..",
    "..x.......x..",
    "..x.......x..",
    "..x.......x..",
    "..x.......x..",
    "...x.......x.",
    "...x.......x.",
    "...x.......x.",
    "...x.......x.",
    "..ooooooooooo",
    "..oWWWWWWWWWo",
    "..ooooooooooo",
]]
CHESHIRE = [[
    # Just the smile, hanging in the leaves.
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    ".....o........o.....",
    "......o......o......",
    ".......oooooo.......",
    "....................",
    "....................",
    "....................",
    "....................",
], [
    # Eyes, nose and the smile, no cat yet.
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    "....................",
    ".....oo......oo.....",
    "....owoo....owoo....",
    "....oooo....oooo....",
    ".....oo......oo.....",
    ".........TT.........",
    ".....o........o.....",
    "......o......o......",
    ".......oooooo.......",
    "....................",
    "....................",
    "....................",
    "....................",
], [
    # The whole cat: round pink head with stripes, big shiny eyes, a wide friendly smile, blush,
    # and a small body sitting on the branch.
    ".oo..............oo.",
    ".oTo............oTo.",
    ".oTTo..........oTTo.",
    ".o111oooooooooo111o.",
    "o111112111111211111o",
    "o111122111111221111o",
    "o1111oo111111oo1111o",
    "o111owoo1111owoo111o",
    "o111oooo1111oooo111o",
    "o1111oo111111oo1111o",
    "o11T11111TT11111T11o",
    "o1111o11111111o1111o",
    "o11111o111111o11111o",
    "o111111oooooo111111o",
    ".o1111111111111111o.",
    "..oo111111111111oo..",
    "..o11211111111211o..",
    "...oooooooooooooo...",
]]
# The tea table: teapot, two cups (the third is its own piece so it can rattle), a top hat with its card.
TEA_TABLE = [
    "..........ooooo...................",
    "..........oRoRo........ooo........",
    "..........oRRRo.......oRRRo.......",
    "......o...oRRRo......oRRRRRo......",
    ".....ooo..oRRRo......oRRRRRo......",
    "....oRRRo.oRRRo..ooo.oRXXXRo......",
    "...oRRRRRoooooo..oRo.oRRRRRo......",
    "...oRRRRRoR.o....oRoooooooooo.....",
    "....oooooooo......oo..............",
    "oooooooooooooooooooooooooooooooooo",
    "oWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWo",
    "oxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxo",
    "..oPo..........................oPo",
    "..oPo..........................oPo",
    "..oPo..........................oPo",
    "..ooo..........................ooo",
]
CUP = [
    ".ooo.",
    "oRRoo",
    "oRRoo",
    ".oo..",
]
STEAM = [[
    "..a..",
    ".a...",
    "..a..",
    "...a.",
    "..a..",
    ".....",
], [
    ".....",
    "..a..",
    "...a.",
    "..a..",
    ".a...",
    "..a..",
]]
ROSE_BUSH = [
    ".....vvvv.....vvvv....",
    "...vvbbbbvv.vvbbbbvv..",
    "..vbbbbbbbbvbbbbbbbbv.",
    ".vbbbbbbbbbbbbbbbbbbbv",
    "vbbbbBbbbbbbbbbBbbbbbv",
    "vbbbbbbbbBbbbbbbbbbbbv",
    "vBbbbbbbbbbbbbBbbbbBbv",
    ".vvvvvvvvvvvvvvvvvvvv.",
    "........oPPo..........",
    "........oPPo..........",
    "........oooo..........",
]
ROSE_W = [".w.", "wow", ".w."]
ROSE_R = [".X.", "XoX", ".X."]
DRIP = ["X", "X", "."]
BUCKET = [
    "..ooo..",
    ".o...o.",
    "ooooooo",
    "oXXXXXo",
    "oPPPPPo",
    "oPPPPPo",
    ".ooooo.",
]
GIANT_HW = [3, 7, 9, 11, 12, 13, 13, 14, 14, 14, 14, 13, 13]
GIANT_SPOTS = [(6, 3), (7, 3), (6, 4), (7, 4), (20, 5), (21, 5), (20, 6), (21, 6), (13, 8), (14, 8), (4, 8), (24, 9), (10, 2), (17, 1)]


def giant_mushroom():
    cap = oval(GIANT_HW, "m", "o")
    w = len(cap[0])
    g = grid(w, 30)
    stamp(g, rows_of(cap), 0, 0)
    for x, y in GIANT_SPOTS:
        if g[y][x] == "m":
            g[y][x] = "M"
    for y in range(13, 29):
        stamp(g, ["osssssssto"], w // 2 - 5, y)
    stamp(g, ["oooooooooo"], w // 2 - 5, 29)
    return rows_of(g)


CATERPILLAR = [[
    "..........oo",
    "...hh.hh.hoo",
    ".hhBhhBhhBho",
    "hhhhhhhhhhh.",
    ".o.o.o.o.o..",
], [
    ".........ooo",
    "...hh.hh.hoo",
    ".hhBhhBhhBh.",
    "hhhhhhhhhh..",
    ".o.o.o.o.o..",
]]
SHEEP = [[
    ".RRRRR..",
    "RRRRRRRo",
    "RRRRRRoo",
    ".RRRRRoo",
    ".o.o.o..",
], [
    ".RRRRRoo",
    "RRRRRRoo",
    "RRRRRRR.",
    ".RRRRR..",
    ".o.o.o..",
]]
WINDMILL = [
    ".....oooo.....",
    "....oWWWWo....",
    "....oWWWWo....",
    "...oWWWWWWo...",
    "...oWWWWWWo...",
    "...oWWWWWWo...",
    "..oWWWWWWWWo..",
    "..oWWWWWWWWo..",
    "..oWWWWWWWWo..",
    ".oWWWWWWWWWWo.",
    ".oWWWWWWWWWWo.",
    ".oWWWWooWWWWo.",
    ".oWWWWoPoWWWo.",
    "oWWWWWoPoWWWWo",
    "oxxxxxoooxxxxo",
]
BLADES = [[
    "......o......",
    "......o......",
    ".....oWo.....",
    ".....oWo.....",
    ".....oWo.....",
    "......o......",
    "oooooo$oooooo",
    "......o......",
    ".....oWo.....",
    ".....oWo.....",
    ".....oWo.....",
    "......o......",
    "......o......",
], [
    "o...........o",
    ".o.........o.",
    "..oW.....Wo..",
    "...oW...Wo...",
    "....oW.Wo....",
    ".....ooo.....",
    "......$......",
    ".....ooo.....",
    "....oW.Wo....",
    "...oW...Wo...",
    "..oW.....Wo..",
    ".o.........o.",
    "o...........o",
]]
VILLAGE = [[
    "..a.................a.......",
    "...oo......a........oo......",
    "...oo...P..oo.......oo......",
    ".ooPPo.PPP.PPo....ooPPoo....",
    "oPPPPPoPPPPPPPPo.oPPPPPPo...",
    "oWWWWWoWWWWWWWWooWWWWWWWWo..",
    "oW$WWWoWW$WW$WWoWWW$WWWW$Wo.",
    "oWWoWWoWWWWWWWWoWWWWoWWWWWo.",
    "oooooooooooooooooooooooooooo",
], [
    "...a.................a......",
    "..a.oo......a.......oo......",
    "...oo...P..oo.......oo......",
    ".ooPPo.PPP.PPo....ooPPoo....",
    "oPPPPPoPPPPPPPPo.oPPPPPPo...",
    "oWWWWWoWWWWWWWWooWWWWWWWWo..",
    "oW$WWWoWW$WW$WWoWWW$WWWW$Wo.",
    "oWWoWWoWWWWWWWWoWWWWoWWWWWo.",
    "oooooooooooooooooooooooooooo",
]]
BALLOON_HW = [2, 4, 5, 6, 6, 6, 6, 6, 5, 4, 3, 2, 1]


def balloon():
    env = oval(BALLOON_HW, "X", "o")
    w = len(env[0])
    g = grid(w, 23)
    stamp(g, rows_of(env), 0, 0)
    for y in range(13):
        for x in range(w):
            if g[y][x] == "X" and (x // 2) % 2 == 1:
                g[y][x] = "y"
    stamp(g, ["x...x", "x...x", ".x.x."], w // 2 - 2, 13)
    stamp(g, [".ooo.", "opppo", "opppo", ".ooo."], w // 2 - 2, 16)
    return rows_of(g)


BEE = [["w.w", "yoy"], [".w.", "yoy"]]
SEED = [".w.", "www", ".k."]
LEAF = ["BB.", ".BB"]
SHADOW_HW = [8, 14, 17, 19, 20, 20, 20, 20, 19, 17, 14, 8]


def cloud_shadow():
    blob = oval(SHADOW_HW, "G", "G")
    g = [row[:] for row in blob]
    for y in range(len(g)):
        for x in range(len(g[0])):
            if g[y][x] == "G" and (x + y) % 2:
                g[y][x] = "."
    return rows_of(g)


RAINBOW_HW = [6, 11, 14, 17, 19, 21, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 35, 36, 37, 37, 38, 38, 39, 39, 40, 40, 41, 41, 41, 42, 42, 42, 43, 43, 43, 43, 44, 44, 44, 44, 44, 44]
RAINBOW_COLORS = "rOyh~%"


def rainbow(height=34):
    w = 2 * 44 + 1
    cx = 44
    g = grid(w, height)
    def inside(k, x, y):
        yy = y - k
        return 0 <= yy < len(RAINBOW_HW) and abs(x - cx) <= RAINBOW_HW[yy] - k
    for y in range(height):
        for x in range(w):
            for k, ch in enumerate(RAINBOW_COLORS):
                if inside(k, x, y) and not inside(k + 1, x, y):
                    g[y][x] = ch
                    break
    return rows_of(g)


ARROW_SIGN = [
    "oooooooooooo....",
    "oWWWWWWWWWWWo...",
    "oWWRWRWWoWWWWo..",
    "oWWRWRWWoooWWWo.",
    "oWWRRRWWooooWWWo",
    "oWWRRRWWoooWWWo.",
    "oWWWWWWWoWWWWo..",
    "oWWWWWWWWWWWo...",
    "oooooooooooo....",
    ".....oPPo.......",
    ".....oPPo.......",
    ".....oPPo.......",
    ".....oPPo.......",
    ".....oPPo.......",
    ".....oooo.......",
]
DIRT_PATCH_HW = [4, 7, 8, 9, 9, 8, 7, 4]


def dirt_patch():
    g = oval(DIRT_PATCH_HW, "D", "t")
    for x, y in ((6, 3), (11, 4), (9, 6)):
        if g[y][x] == "D":
            g[y][x] = "t"
    return rows_of(g)


PATH_V = [
    "kDDDDk",
    "kDtDDk",
    "kDDDDk",
    "kDDDtk",
    "kDDDDk",
    "kDDDDk",
]


def pocket_watch():
    """The rabbit's own watch face, hung by a chain from a fence post. Four frames, one hand tick each."""
    from rabbit_px import CLOCK, CLOCK_HANDS
    frames = []
    for tick in range(4):
        g = grid(9, 12)
        stamp(g, ["....$....", "....$....", "....$...."], 0, 0)
        face = [r.replace("g", "$").replace("f", "R") for r in CLOCK]
        stamp(g, face, 0, 3)
        g[3 + 4][4] = "o"
        for r, c in CLOCK_HANDS[tick]:
            g[3 + r][c] = "o"
        frames.append(rows_of(g))
    return frames


# ---------- cursors and small icons, exported at 3x ----------

CURSOR_ARROW = [
    "o.......",
    "oo......",
    "oRo.....",
    "oRRo....",
    "oRRRo...",
    "oRRRRo..",
    "oRRRRRo.",
    "oRRRoooo",
    "oRoRRo..",
    "ooooRRo.",
    "....oRRo",
    ".....oo.",
]
CURSOR_HAND = [
    "...oo.....",
    "..oRRo....",
    "..oRRo....",
    "..oRRooo..",
    "..oRRoRRoo",
    "ooRRRRRRRo",
    "oRoRRRRRRo",
    "oRRRRRRRRo",
    ".oRRRRRRRo",
    ".oRRRRRRo.",
    "..oRRRRRo.",
    "..ooooooo.",
]
CURSOR_GRAB = [
    "..oo.oo...",
    ".oRRoRRoo.",
    ".oRRRRRRRo",
    "ooRRRRRRRo",
    "oRoRRRRRRo",
    "oRRRRRRRRo",
    ".oRRRRRRRo",
    ".oRRRRRRo.",
    "..oRRRRRo.",
    "..ooooooo.",
]
SPEAKER_ON = [
    "....oo.....",
    "...oRRo.o..",
    "ooooRRo..o.",
    "oRRRRRo.o.o",
    "oRRRRRo.o.o",
    "oRRRRRo.o.o",
    "ooooRRo..o.",
    "...oRRo.o..",
    "....oo.....",
]
SPEAKER_OFF = [
    "....oo.....",
    "...oRRo....",
    "ooooRRo.X.X",
    "oRRRRRo..X.",
    "oRRRRRo.X.X",
    "oRRRRRo....",
    "ooooRRo....",
    "...oRRo....",
    "....oo.....",
]
ICONS = {
    "cursor_arrow": (CURSOR_ARROW, (0, 0)),
    "cursor_hand": (CURSOR_HAND, (3, 0)),
    "cursor_grab": (CURSOR_GRAB, (5, 5)),
    "speaker_on": (SPEAKER_ON, (0, 0)),
    "speaker_off": (SPEAKER_OFF, (0, 0)),
}

# ---------- wood: fence, signpost, the signs the kid uses ----------

FENCE = [
    "..oo..........................oo..",
    ".opPo........................opPo.",
    ".opPo........................opPo.",
    ".opPoooooooooooooooooooooooooopPo.",
    ".opPoWWWWWWWWWWWWWWWWWWWWWWWWopPo.",
    ".opPoxxxxxxxxxxxxxxxxxxxxxxxxopPo.",
    ".opPoooooooooooooooooooooooooopPo.",
    ".opPo........................opPo.",
    ".opPoooooooooooooooooooooooooopPo.",
    ".opPoWWWWWWWWWWWWWWWWWWWWWWWWopPo.",
    ".opPoxxxxxxxxxxxxxxxxxxxxxxxxopPo.",
    ".opPoooooooooooooooooooooooooopPo.",
    ".opPo........................opPo.",
    ".opPo........................opPo.",
    ".oooo........................oooo.",
]
ARROW_RIGHT = [
    "oooooooooooooo.",
    "oWWWWWWWWWWWWo.",
    "oWxxxxxxxxxWWWo",
    "oWWWWWWWWWWWWo.",
    "oooooooooooooo.",
]
POST_ART = ["opPo"]


def signpost():
    """A post with two arrow boards, one each way. 21 x 27."""
    g = grid(21, 27)
    for y in range(0, 27):
        stamp(g, POST_ART, 8, y)
    g[0][8:12] = list("oooo")
    g[26][8:12] = list("oooo")
    stamp(g, ARROW_RIGHT, 6, 3)
    stamp(g, mirror(ARROW_RIGHT), 0, 11)
    return rows_of(g)


SIGN = [
    ".oooooooooooo.",
    "oWWWWWWWWWWWWo",
    "oWoWWWWWWWWoWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWWWWWWWWWWWWo",
    "oWoWWWWWWWWoWo",
    "oxxxxxxxxxxxxo",
    ".oooooooooooo.",
]
POST_TILE = [
    "oppPPo",
    "oppPPo",
    "oppPPo",
    "oppPPo",
    "oppPPo",
    "oppPPo",
]

# ---------- the rabbit's home ----------

ARCH = [
    "......JJJJJJJJ......",
    "....JJHHHHHHHHJJ....",
    "...JHHHHHHHHHHHHJ...",
    "..JHHHHHHHHHHHHHHJ..",
    ".JHHHHHHHHHHHHHHHHJ.",
    ".JHHHHHHHHHHHHHHHHJ.",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
    "JHHHHHHHHHHHHHHHHHHJ",
]
CHIMNEY = [
    ".ooooo.",
    "oDtDtDo",
    "otDtDto",
    ".oDtDo.",
    ".otDto.",
    ".oDtDo.",
    ".otDto.",
    ".oDtDo.",
    ".otDto.",
    ".oDtDo.",
]
WINDOW = [
    ".ooooo.",
    "oRRoRRo",
    "oRRoRRo",
    "ooooooo",
    "oRRoRRo",
    "oRRoRRo",
    ".ooooo.",
]
SMOKE = [[
    ".........",
    ".........",
    ".........",
    "....aa...",
    "...aAAa..",
    "....aa...",
    ".........",
    "..aa.....",
    ".aAAa....",
    "..aa.....",
], [
    "....aa...",
    "...aAAa..",
    "....aa...",
    ".........",
    "..aa.....",
    ".aAAa....",
    "..aa.....",
    ".........",
    "...aa....",
    "....a....",
]]
MOUND_COLS = profile(3, [
    ("up", [9, 6, 5, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    ("flat", 12),
    ("down", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 5, 6, 9]),
])
MOUND_STONES = [(6, 28), (14, 26), (22, 27), (33, 24), (46, 27), (72, 26), (78, 24), (90, 27), (100, 25), (108, 27), (114, 28), (36, 20)]


def mound():
    """A grassy hump over dirt, his arched doorway under the crest, a brick chimney on the left slope."""
    tall = max(MOUND_COLS)
    g = grid(len(MOUND_COLS), tall)
    for x, h in enumerate(MOUND_COLS):
        top = tall - h
        for y in range(top, tall):
            depth = y - top
            g[y][x] = "k" if depth == 0 else "g" if depth <= 3 else "G" if depth == 4 else "D"
    for x, y in MOUND_STONES:
        if 0 <= y < tall and g[y][x] == "D":
            g[y][x] = "t"
    stamp(g, ARCH, 50, tall - len(ARCH))
    stamp(g, WINDOW, 24, tall - 7)
    stamp(g, CHIMNEY, 40, tall - 24)
    return rows_of(g)


# ---------- sky ----------

SUN = [
    "......u......",
    "..u...u...u..",
    "...u.qqq.u...",
    "....qUUUq....",
    "...qUuuuUq...",
    "..qUuuuuuUq..",
    "uuqUuuuuuUquu",
    "..qUuuuuuUq..",
    "...qUuuuUq...",
    "....qUUUq....",
    "...u.qqq.u...",
    "..u...u...u..",
    "......u......",
]
MOON = [
    "....LLLL...",
    "..LLLLLLl..",
    ".LLLLLl....",
    ".LLLLl.....",
    "LLLLl......",
    "LLLLl......",
    "LLLLl......",
    ".LLLLl.....",
    ".LLLLLl....",
    "..LLLLLLl..",
    "....LLLL...",
]
BIRD = [[
    "o.....o",
    ".oo.oo.",
    "...o...",
], [
    ".......",
    "...o...",
    ".oo.oo.",
]]
BUTTERFLY_Y = [[
    "yy.yy",
    "yyoyy",
    "y...y",
], [
    "..o..",
    ".yoy.",
    ".....",
]]
BUTTERFLY_W = [[
    "ww.ww",
    "wwoww",
    "w...w",
], [
    "..o..",
    ".wow.",
    ".....",
]]
STAR_A = [[".*.", "***", ".*."], ["...", ".+.", "..."]]
STAR_B = [["*"], ["+"]]
FIREFLY = [["YY", "YY"], ["i.", ".."]]
RAIN = ["|", "|", "|"]

# ---------- the clock's digits, 5 x 7 ----------

DIGITS = {
    "0": [" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "],
    "1": ["  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
    "2": [" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"],
    "3": ["#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "],
    "4": ["   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "],
    "5": ["#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "],
    "6": ["  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "],
    "7": ["#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "],
    "8": [" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "],
    "9": [" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "],
    ":": ["  ", "##", "##", "  ", "##", "##", "  "],
    "A": [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
    "M": ["#   #", "## ##", "# # #", "# # #", "#   #", "#   #", "#   #"],
    "P": ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
}
DIGIT_ORDER = "0123456789:AMP"


# ---------- pieces ----------

def pieces():
    """name -> list of frames (each a list of equal-length strings)."""
    P = {
        "cloud_a": [CLOUD_A],
        "cloud_b": [CLOUD_B],
        "cloud_c": [CLOUD_C],
        "hills_far": [rows_of(from_heights(FAR_HILLS, "F", "f"))],
        "hills_near": [rows_of(from_heights(NEAR_HILLS, "N", "n", "j"))],
        "hedge": [hedge()],
        "ground": [GROUND],
        "path": [PATH],
        "bush_a": [BUSH_A],
        "bush_b": [BUSH_B],
        "bush_c": [BUSH_C],
        "bush_d": [BUSH_D],
        "tuft_a": TUFT_A,
        "tuft_b": TUFT_B,
        "tuft_c": TUFT_C,
        "flower_r": FLOWER_R,
        "flower_y": FLOWER_Y,
        "flower_w": FLOWER_W,
        "flower_s": FLOWER_S,
        "mush_a": [MUSH_A],
        "mush_b": [MUSH_B],
        "mush_c": [MUSH_C],
        "fence": [FENCE],
        "signpost": [signpost()],
        "mound": [mound()],
        "smoke": SMOKE,
        "sun": [SUN],
        "moon": [MOON],
        "star_a": STAR_A,
        "star_b": STAR_B,
        "firefly": FIREFLY,
        "bird": BIRD,
        "butterfly_y": BUTTERFLY_Y,
        "butterfly_w": BUTTERFLY_W,
        "rain": [RAIN],
        "carrot_top": [CARROT_TOP],
        "carrot": [CARROT],
        "sprout": [SPROUT],
        "heart": HEART,
        "sparkle": SPARKLE,
        "petal_r": [PETAL_R],
        "petal_y": [PETAL_Y],
        "petal_w": [PETAL_W],
        "smoke_ring": SMOKE_RING,
        "door": [DOOR],
        "eyes": [EYES],
        "concept_tall": CONCEPT_TALL,
        "concept_plain": CONCEPT_PLAIN,
        "concept_wilted": [CONCEPT_WILTED],
        "earth": [EARTH],
        "pond": pond(),
        "duck": DUCK,
        "duckling": DUCKLING,
        "fish": FISH,
        "splash": SPLASH,
        "flamingo": FLAMINGO,
        "hoop": [HOOP],
        "card_hearts": card("hearts"),
        "card_spades": card("spades"),
        "oak": [oak()],
        "swing": SWING,
        "cheshire": CHESHIRE,
        "tea_table": [TEA_TABLE],
        "cup": [CUP],
        "steam": STEAM,
        "rose_bush": [ROSE_BUSH],
        "rose_w": [ROSE_W],
        "rose_r": [ROSE_R],
        "drip": [DRIP],
        "bucket": [BUCKET],
        "giant_mushroom": [giant_mushroom()],
        "caterpillar": CATERPILLAR,
        "sheep": SHEEP,
        "windmill": [WINDMILL],
        "blades": BLADES,
        "village": VILLAGE,
        "balloon": [balloon()],
        "bee": BEE,
        "seed": [SEED],
        "leaf": [LEAF],
        "cloud_shadow": [cloud_shadow()],
        "rainbow": [rainbow()],
        "arrow_sign": [ARROW_SIGN],
        "dirt_patch": [dirt_patch()],
        "path_v": [PATH_V],
        "pocket_watch": pocket_watch(),
    }
    for name, frames in P.items():
        w, h = len(frames[0][0]), len(frames[0])
        for f in frames:
            assert len(f) == h and all(len(r) == w for r in f), f"{name}: ragged frame"
            for r in f:
                for ch in r:
                    assert ch == "." or ch in COMMON or ch in TOD_PAL["day"], f"{name}: unknown symbol {ch!r}"
    return P


def atlas_width(P):
    return max(ATLAS_W, max(len(f[0][0]) * len(f) for f in P.values()))


def pack(P):
    """Shelf packing, tallest pieces first. Returns (rects, width, height); frames sit side by side."""
    width = atlas_width(P)
    order = sorted(P, key=lambda n: -len(P[n][0]))
    rects, x, y, shelf = {}, 0, 0, 0
    for name in order:
        frames = P[name]
        w, h = len(frames[0][0]) * len(frames), len(frames[0])
        if x + w > width:
            x, y, shelf = 0, y + shelf + 1, 0
        rects[name] = {"x": x, "y": y, "w": len(frames[0][0]), "h": h, "frames": len(frames)}
        x += w + 1
        shelf = max(shelf, h)
    return rects, width, y + shelf


def color(ch, tod):
    if ch == ".":
        return (0, 0, 0, 0)
    rgb = COMMON.get(ch) or TOD_PAL[tod][ch]
    return (rgb[0], rgb[1], rgb[2], 255)


def atlas(P, rects, width, height, tod):
    im = Image.new("RGBA", (width, height))
    px = im.load()
    for name, frames in P.items():
        r = rects[name]
        for i, f in enumerate(frames):
            for j, row in enumerate(f):
                for k, ch in enumerate(row):
                    if ch != ".":
                        px[r["x"] + i * r["w"] + k, r["y"] + j] = color(ch, tod)
    return im


def image(rows, tod="day"):
    im = Image.new("RGBA", (len(rows[0]), len(rows)))
    im.putdata([color(ch, tod) for row in rows for ch in row])
    return im


def digits_image():
    """Every glyph with its cream rim, packed side by side. Returns (image, {glyph: {x, w}}, height)."""
    cells, x = {}, 0
    ims = []
    for ch in DIGIT_ORDER:
        art = rim(pad([r.replace("#", "I").replace(" ", ".") for r in DIGITS[ch]]))
        im = image(art)
        cells[ch] = {"x": x, "w": im.width}
        ims.append((x, im))
        x += im.width
    sheet = Image.new("RGBA", (x, ims[0][1].height))
    for ox, im in ims:
        sheet.paste(im, (ox, 0))
    return sheet, cells, sheet.height


def same_pixels(path, im):
    if not os.path.exists(path):
        return False
    old = Image.open(path).convert("RGBA")
    return old.size == im.size and old.tobytes() == im.tobytes()


def save(path, im):
    if not same_pixels(path, im):
        im.save(path)


def export(out=OUT):
    os.makedirs(out, exist_ok=True)
    P = pieces()
    rects, width, height = pack(P)
    man = {
        "scale_note": "Compose at source size, then draw at a whole-number scale with smoothing off. Frames sit side by side inside a piece's rect.",
        "atlas": {"width": width, "height": height, "files": {tod: f"scene_{tod}.png" for tod in TODS}},
        "pieces": rects,
        "palettes": {tod: {k: list(v) for k, v in {**COMMON, **TOD_PAL[tod]}.items()} for tod in TODS},
        "sky_bands": ["K1", "K2", "K3", "K4", "K5", "K6"],
    }
    for tod in TODS:
        save(os.path.join(out, f"scene_{tod}.png"), atlas(P, rects, width, height, tod))
    sheet, cells, h = digits_image()
    save(os.path.join(out, "digits.png"), sheet)
    man["digits"] = {"file": "digits.png", "height": h, "glyphs": cells, "note": "5 x 7 ink with a one pixel cream rim. Draw at a whole-number scale."}
    save(os.path.join(out, "sign.png"), image(SIGN))
    man["sign"] = {"file": "sign.png", "size": [len(SIGN[0]), len(SIGN)], "slice": 5, "note": "Painted plank, 9-slice for border-image."}
    save(os.path.join(out, "post.png"), image(POST_TILE))
    man["post"] = {"file": "post.png", "size": [len(POST_TILE[0]), len(POST_TILE)], "note": "Repeats vertically under a sign."}
    save(os.path.join(out, "carrot.png"), image(CARROT))
    man["carrot"] = {"file": "carrot.png", "size": [len(CARROT[0]), len(CARROT)], "note": "The enter key on the search plank. Draw at a whole-number scale."}
    man["icons"] = {}
    for name, (art, hot) in ICONS.items():
        im = image(art)
        big = im.resize((im.width * 3, im.height * 3), Image.NEAREST)
        save(os.path.join(out, name + ".png"), big)
        man["icons"][name] = {"file": name + ".png", "size": [big.width, big.height], "hotspot": [hot[0] * 3 + 1, hot[1] * 3 + 1]}
    # Where each palette sits on the clock; the page blends the sky between neighbours.
    man["palette_hours"] = {"night": 23, "morning": 7.5, "day": 13.5, "evening": 19}
    man["profiles"] = {"hills_far": FAR_HILLS, "hills_near": NEAR_HILLS}
    with open(os.path.join(out, "manifest.json"), "w", newline="\n") as fh:
        json.dump(man, fh, indent=2)
        fh.write("\n")
    return man


def sheet_preview(path, scale=4):
    P = pieces()
    rects, width, height = pack(P)
    cols = len(TODS)
    sheet = Image.new("RGBA", (cols * (width * scale + 20), height * scale + 60), (60, 60, 60, 255))
    draw = ImageDraw.Draw(sheet)
    for i, tod in enumerate(TODS):
        x0 = i * (width * scale + 20) + 10
        pal = TOD_PAL[tod]
        draw.rectangle((x0, 30, x0 + width * scale, 30 + height * scale), fill=pal["K3"] + (255,))
        big = atlas(P, rects, width, height, tod).resize((width * scale, height * scale), Image.NEAREST)
        sheet.alpha_composite(big, (x0, 30))
        draw.text((x0, 10), tod, fill=(255, 255, 255, 255))
    d, _, _ = digits_image()
    dd = d.resize((d.width * scale, d.height * scale), Image.NEAREST)
    sheet.alpha_composite(dd, (10, 30 + height * scale + 10))
    sheet.save(path)
    print(path, sheet.size)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", default="")
    args = ap.parse_args()
    m = export()
    print("pieces:", ", ".join(m["pieces"]))
    print("atlas:", m["atlas"]["width"], "x", m["atlas"]["height"])
    if args.sheet:
        sheet_preview(args.sheet)
