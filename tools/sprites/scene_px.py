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
}
WOOD_DAY = {"W": (232, 201, 150), "x": (200, 160, 110), "p": (166, 116, 70), "P": (122, 82, 50)}
# Per time of day. Keys: K1..K6 sky bands top to bottom; c C S cloud line, fill, shade; f F far hill
# line, fill; n N j near hill line, fill, light; e E d hedge line, fill, dark leaf; g G k grass, dark
# grass, grass line; b B v h bush fill, dark, line, light; r y w z flower red, gold, white, center;
# m M s mushroom cap, spot, stem; u U q sun light, mid, line; L l moon; * + star bright, dim;
# Y i firefly on, off; | rain; D t dirt, dark dirt; a A smoke; W x p P wood board, grain, post, post shade.
TOD_PAL = {
    "morning": {
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
FLOWER_R = [
    "..r..",
    ".rrr.",
    "rrzrr",
    ".rrr.",
    "..k..",
    "k.k..",
    ".kk..",
    "..k..",
]
FLOWER_Y = [
    "..y..",
    ".yyy.",
    "yyoyy",
    ".yyy.",
    "..k..",
    "..k.k",
    "..kk.",
    "..k..",
]
FLOWER_W = [
    ".w.w.",
    "wwzww",
    ".wzw.",
    "wwzww",
    ".w.w.",
    "..k..",
    "..k..",
]
# A small clover of three white dots.
FLOWER_S = [
    "w.w",
    ".w.",
    ".k.",
    ".k.",
]
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
        "flower_r": [FLOWER_R],
        "flower_y": [FLOWER_Y],
        "flower_w": [FLOWER_W],
        "flower_s": [FLOWER_S],
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
