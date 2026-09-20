"""
Turn a hand drawing into a Burrow sprite.

    python3 tools/sprites/scan.py --in drawing.jpg --name moth

A photo of paper, or a frame off the drawing board, comes in; a pixel sprite, its manifest and an
8x preview go out under extension/public/characters/<name>/.

The split matters. A vision model is good at saying *what* a drawing is, which parts it has and what
colours it wants; it is bad at emitting a clean grid of pixels, and asking it for one gives ragged
outlines, broken symmetry and the wrong number of rows. So the model only ever returns a short piece
of JSON (subject, symmetry, palette, where the face is) and every pixel is placed by the code below:
trim, fit, area resample, quantise to that palette, clean the strays, outline, and mirror when the
model says the thing is symmetric. Without a key (or with --no-model) the palette is taken from the
drawing itself and the rest is identical, so the geometry can be worked on offline.
"""

import argparse
import base64
from collections import deque
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
OUT_ROOT = os.path.join(ROOT, "extension", "public", "characters")

# The rabbit's cell, so a scanned pet drops into the same renderer (extension/public/characters/rabbit).
CELL_W, CELL_H = 64, 58
# The drawing is fitted into this box inside the cell, leaving room for the outline and his shadow.
FIT_W, FIT_H = 44, 46
INK = (59, 42, 35, 255)
CLEAR = (0, 0, 0, 0)
MAX_COLORS = 6


# ---------- the drawing ----------

def open_any(path):
    """Open a photo, including the iPhone's HEIC, which Pillow cannot read on its own."""
    try:
        return Image.open(path)
    except Exception:  # noqa: BLE001 - any unreadable format takes the same route
        if os.path.splitext(path)[1].lower() not in (".heic", ".heif"):
            raise
        try:  # pillow-heif if it is installed, which is the portable answer
            import pillow_heif  # type: ignore

            pillow_heif.register_heif_opener()
            return Image.open(path)
        except ImportError:
            pass
        jpg = os.path.join(os.path.dirname(path) or ".", ".heic-" + os.path.basename(path) + ".jpg")
        if subprocess.run(["sips", "-s", "format", "jpeg", path, "--out", jpg], capture_output=True).returncode == 0:
            return Image.open(jpg)
        raise RuntimeError("cannot read HEIC: pip install pillow-heif, or shoot in JPEG")


def load(path):
    """Open the photo and take the paper out of it: the page becomes white, the marker keeps its colour."""
    im = open_any(path)
    im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((1600, 1600))
    # The paper colour is the bright end of the picture, not the average: sample the lightest decile.
    small = im.resize((64, 64), Image.BOX)
    lum = sorted(small.convert("L").getdata())
    paper = max(1, lum[int(len(lum) * 0.88)])
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            # Scale towards white by the paper's brightness, then push saturation back up: a phone
            # photo of paper washes colour out, and the marker is the only thing worth keeping.
            r, g, b = (min(255, int(c * 255 / paper)) for c in (r, g, b))
            m = (r + g + b) / 3
            px[x, y] = tuple(max(0, min(255, int(m + (c - m) * 1.45))) for c in (r, g, b))
    return im


def ink_mask(im, cut=0.82):
    """Which pixels are drawn on, as a bitmap: anything darker or more saturated than the paper."""
    g = im.convert("L")
    w, h = im.size
    px, gp = im.load(), g.load()
    mask = Image.new("1", (w, h), 0)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, gg, b = px[x, y]
            sat = max(r, gg, b) - min(r, gg, b)
            if gp[x, y] < 255 * cut or sat > 60:
                mp[x, y] = 1
    return mask


def despeckle(mask, radius=5):
    """
    Open the mask: dotted or squared notebook paper is what people actually draw on, and every dot
    reads as ink. Eroding then dilating drops anything thinner than the pen and leaves strokes whole.
    """
    g = mask.convert("L").point(lambda v: 255 if v else 0)
    g = g.filter(ImageFilter.MinFilter(radius)).filter(ImageFilter.MaxFilter(radius))
    return g.point(lambda v: 255 if v > 127 else 0).convert("1")


def largest_blob(mask, keep=0.12):
    """
    Keep the drawing and drop everything else. A photo of a page has marks that are not the drawing:
    a shadow at an edge, a crease, the corner of another sheet. Any of them stretches the bounding
    box and the drawing shrinks to nothing inside the cell, which is the loudest failure there is.
    Components smaller than a fraction of the biggest one go.
    """
    w, h = mask.size
    mp = mask.load()
    seen = bytearray(w * h)
    blobs = []
    for sy in range(h):
        for sx in range(w):
            if not mp[sx, sy] or seen[sy * w + sx]:
                continue
            q = deque([(sx, sy)])
            seen[sy * w + sx] = 1
            cells = []
            while q:
                x, y = q.popleft()
                cells.append((x, y))
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h and mp[nx, ny] and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            blobs.append(cells)
    if not blobs:
        return mask
    main = max(blobs, key=len)
    xs = [x for x, _ in main]
    ys = [y for _, y in main]
    pad = max(4, (max(xs) - min(xs)) // 20)
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad
    out = Image.new("1", (w, h), 0)
    op = out.load()
    for b in blobs:
        # The outline is the big one. Eyes, a nose and a mouth are their own small blobs and must
        # survive, so a blob is kept when it sits inside the outline's box, wherever its size.
        cx = sum(x for x, _ in b) / len(b)
        cy = sum(y for _, y in b) / len(b)
        if len(b) >= len(main) * keep or (x0 <= cx <= x1 and y0 <= cy <= y1):
            for x, y in b:
                op[x, y] = 1
    return out


def fill_from_middle(lines, close):
    """One attempt at filling the body, with the strokes fattened by `close` to seal their breaks."""
    w, h = lines.size
    closed = lines.convert("L").point(lambda v: 255 if v else 0).filter(ImageFilter.MaxFilter(close))
    cp = closed.load()
    seeds = [(w // 2, h // 2), (w // 2, int(h * 0.62)), (int(w * 0.42), h // 2), (int(w * 0.58), h // 2)]
    seed = next((s for s in seeds if cp[s[0], s[1]] == 0), None)
    if seed is None:
        return None
    ImageDraw.floodfill(closed, seed, 200, thresh=10)
    filled = closed.point(lambda v: 255 if v == 200 else 0).filter(ImageFilter.MaxFilter(close))
    fp = filled.load()
    # A fill that reaches the edge of the picture escaped through a break in the outline.
    edge = any(fp[x, 0] or fp[x, h - 1] for x in range(0, w, 3)) or any(fp[0, y] or fp[w - 1, y] for y in range(0, h, 3))
    got = sum(1 for y in range(0, h, 2) for x in range(0, w, 2) if fp[x, y]) * 4
    return None if edge or got > w * h * 0.92 else filled


def interior(lines):
    """
    What the pen encloses, filled from the middle outwards.

    Flooding from a corner is the textbook way and it is the wrong one here: a hand drawn outline
    always has a break somewhere, and one break lets the outside pour in, after which the body is
    never filled. Filling from the middle turns a break into a leak outward instead, which can be
    seen (the fill reaches the edge of the picture) and answered by sealing harder and trying again.
    If no amount of sealing holds, the body is left unfilled rather than flooding the whole page.
    """
    w, h = lines.size
    for close in (13, 21, 31, 45, 61, 81):
        got = fill_from_middle(lines, close)
        if got is None:
            continue
        out = Image.new("1", (w, h), 0)
        op, fp = out.load(), got.load()
        for y in range(h):
            for x in range(w):
                if fp[x, y]:
                    op[x, y] = 1
        return out
    return Image.new("1", (w, h), 0)


def trim(im, mask, pad=2):
    box = mask.getbbox()
    if not box:
        return im, mask
    x0, y0, x1, y1 = box
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(im.width, x1 + pad), min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1)), mask.crop((x0, y0, x1, y1))


# ---------- what it is ----------

def read_env(name):
    try:
        with open(os.path.join(ROOT, ".env"), "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return os.environ.get(name, "")


ASK = """You are looking at a hand drawing that is about to become a small pixel-art sprite, 44 by 46 pixels, in the style of a friendly storybook game.

Do NOT draw anything or return any grid of pixels. Return only this JSON:
{"subject":"<two or three words for what it is>",
 "name":"<one lowercase word, a to z only, to file it under>",
 "symmetric":<true if the thing is left-right symmetric seen from the front, else false>,
 "facing":"front|left|right",
 "palette":[{"role":"<body|shade|detail|eye|accent>","hex":"#rrggbb"}],
 "line_art":<true if the drawing is pen or pencil outlines with nothing coloured in>,
 "keep":"<one short sentence: the one feature that must survive shrinking, for example the long ears or the round belly>"}

Give between two and five palette entries, ordered by how much of the drawing they cover, taking the colours from the drawing itself. If the drawing is only pencil or pen on paper, give the colours the subject is actually known to have, brightest first, because the sprite is coloured from this and not from the page. No em dashes."""


def describe(im):
    key = read_env("LLM_API_KEY")
    if not key:
        return None, "no LLM_API_KEY"
    model = read_env("LLM_MODEL") or "gpt-6-astra"
    buf = io.BytesIO()
    small = im.copy()
    small.thumbnail((768, 768))
    small.convert("RGB").save(buf, format="JPEG", quality=88)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": ASK}, {"type": "image_url", "image_url": {"url": url, "detail": "high"}}]}],
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            out = json.loads(r.read().decode())
        text = out["choices"][0]["message"]["content"]
        return json.loads(re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)), None
    except Exception as e:  # noqa: BLE001 - any failure falls back to the drawing's own colours
        return None, str(e)


def palette_from(im, mask, n=MAX_COLORS - 1):
    """The drawing's own colours, for when there is no model: quantise what was actually inked."""
    inked = Image.new("RGB", im.size, (255, 255, 255))
    inked.paste(im.convert("RGB"), mask=mask)
    q = inked.convert("P", palette=Image.ADAPTIVE, colors=n + 2).convert("RGB")
    counts = {}
    mp = mask.load()
    qp = q.load()
    for y in range(q.height):
        for x in range(q.width):
            if mp[x, y] and sum(qp[x, y]) > 150:  # the pen is handled as lines, not as a fill
                counts[qp[x, y]] = counts.get(qp[x, y], 0) + 1
    ordered = [c for c, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:n]
    return [{"role": "body" if i == 0 else "detail", "hex": "#%02x%02x%02x" % c} for i, c in enumerate(ordered)]


# ---------- the pixels ----------

def hexrgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def nearest(c, pal):
    r, g, b = c
    return min(pal, key=lambda p: (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2)


def ink_lines(im, mask, drop=26):
    """
    The pen strokes only. A flat threshold cannot do this: the face is thin dark lines on light skin,
    while a cowl or a cape is a large dark fill, and any cut that keeps the first swallows the second.
    So a stroke is a pixel darker than its own surroundings, which is what a pen is and a fill is not.
    """
    g = im.convert("L")
    local = g.filter(ImageFilter.GaussianBlur(radius=max(2, min(g.size) // 90)))
    w, h = g.size
    out = Image.new("1", (w, h), 0)
    op, gp, lp, mp = out.load(), g.load(), local.load(), mask.load()
    for y in range(h):
        for x in range(w):
            if mp[x, y] and gp[x, y] < lp[x, y] - drop:
                op[x, y] = 1
    return out


def pool_max(mask, tw, th):
    """Shrink a bitmap keeping any set pixel in each cell, so a one pixel line does not average away."""
    w, h = mask.size
    mp = mask.load()
    out = Image.new("1", (tw, th), 0)
    op = out.load()
    for ty in range(th):
        y0, y1 = int(ty * h / th), max(int(ty * h / th) + 1, int((ty + 1) * h / th))
        for tx in range(tw):
            x0, x1 = int(tx * w / tw), max(int(tx * w / tw) + 1, int((tx + 1) * w / tw))
            hit = 0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    if mp[x, y]:
                        hit += 1
            # A cell counts as a line when a sixth of it is inked: enough to keep a thin
            # stroke through the shrink, not so little that paper grain reads as a line.
            if hit * 6 >= (y1 - y0) * (x1 - x0):
                op[tx, ty] = 1
    return out


def rasterise(im, mask, pal, line_art=False):
    """
    Fit the drawing into the cell. Flat colour comes from coverage, the pen lines are laid back on
    top, and for line art the enclosed body is filled with the first palette colour, because a pen
    drawing is mostly paper and would otherwise shrink to an empty outline.
    """
    w, h = im.size
    k = min(FIT_W / w, FIT_H / h)
    tw, th = max(1, round(w * k)), max(1, round(h * k))
    small = im.convert("RGB").resize((tw, th), Image.BOX)
    cover = mask.convert("L").resize((tw, th), Image.BOX)
    # For pen on paper the ink mask *is* the strokes. The local contrast detector below finds edges,
    # which is right for separating a thin face line from a large dark fill in a coloured drawing,
    # and wrong here: it would hollow out a thick pen line into two thin edges that fall apart.
    strokes = mask if line_art else ink_lines(im, mask)
    lines = pool_max(strokes, tw, th)
    inside = pool_max(interior(strokes), tw, th) if line_art else None
    body = pal[0] + (255,)
    out = Image.new("RGBA", (tw, th), CLEAR)
    op, sp, cp, lp = out.load(), small.load(), cover.load(), lines.load()
    ip = inside.load() if inside else None
    for y in range(th):
        for x in range(tw):
            if lp[x, y]:
                op[x, y] = INK
            elif ip and ip[x, y]:
                op[x, y] = body
            elif not line_art and cp[x, y] >= 110:
                op[x, y] = nearest(sp[x, y], pal) + (255,)
    return out


def neighbours4(x, y):
    return ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))


def clean(im, drop_strays=True):  # noqa: D401
    """Strays go, one pixel holes close. Pixel art wants a solid shape, not photo noise."""
    w, h = im.size
    px = im.load()
    solid = lambda x, y: 0 <= x < w and 0 <= y < h and px[x, y][3] > 0
    if drop_strays:
        for y in range(h):
            for x in range(w):
                if px[x, y][3] and sum(1 for nx, ny in neighbours4(x, y) if solid(nx, ny)) == 0:
                    px[x, y] = CLEAR
    for y in range(h):
        for x in range(w):
            if not px[x, y][3] and sum(1 for nx, ny in neighbours4(x, y) if solid(nx, ny)) >= 3:
                fill = next((px[nx, ny] for nx, ny in neighbours4(x, y) if solid(nx, ny)), None)
                if fill:
                    px[x, y] = fill
    return im


def outline(im):
    """One pixel of ink around the silhouette, the rule every other piece in this product follows."""
    w, h = im.size
    src = im.copy()
    out = Image.new("RGBA", (w + 2, h + 2), CLEAR)
    out.paste(src, (1, 1))
    op = out.load()
    sp = src.load()
    solid = lambda x, y: 0 <= x < w and 0 <= y < h and sp[x, y][3] > 0
    for y in range(h + 2):
        for x in range(w + 2):
            if op[x, y][3]:
                continue
            sx, sy = x - 1, y - 1
            if any(solid(sx + dx, sy + dy) for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1))):
                op[x, y] = INK
    return out


def mirror(im):
    """Snap to left-right symmetry: the half with more ink is copied across the middle."""
    w, h = im.size
    half = w // 2
    px = im.load()
    left = sum(1 for y in range(h) for x in range(half) if px[x, y][3])
    right = sum(1 for y in range(h) for x in range(w - half, w) if px[x, y][3])
    keep = im.crop((0, 0, half, h)) if left >= right else im.crop((w - half, 0, w, h)).transpose(Image.FLIP_LEFT_RIGHT)
    out = Image.new("RGBA", (w, h), CLEAR)
    out.paste(keep, (0, 0))
    out.paste(keep.transpose(Image.FLIP_LEFT_RIGHT), (w - half, 0))
    if w % 2:  # the middle column is the edge of the kept half, repeated
        col = keep.crop((half - 1, 0, half, h))
        out.paste(col, (half, 0))
    return out


def centre(im):
    """Drop the sprite into the rabbit's cell, feet on the same row his stand on."""
    cell = Image.new("RGBA", (CELL_W, CELL_H), CLEAR)
    box = im.getbbox() or (0, 0, im.width, im.height)
    art = im.crop(box)
    x = (CELL_W - art.width) // 2
    y = 54 - art.height  # row 53 is the ground in this cell
    cell.paste(art, (x, max(0, y)))
    return cell, (x, max(0, y), art.width, art.height)


# ---------- output ----------

def preview(src, cell, path, scale=8):
    left = src.copy()
    left.thumbnail((cell.width * scale, cell.height * scale))
    sheet = Image.new("RGB", (left.width + cell.width * scale + 24, max(left.height, cell.height * scale)), (60, 60, 60))
    sheet.paste(left.convert("RGB"), (0, 0))
    big = cell.resize((cell.width * scale, cell.height * scale), Image.NEAREST)
    bg = Image.new("RGB", big.size, (120, 170, 220))
    bg.paste(big, (0, 0), big)
    sheet.paste(bg, (left.width + 24, 0))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--name", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--no-model", action="store_true")
    ap.add_argument("--no-mirror", action="store_true")
    ap.add_argument("--line-art", action="store_true", help="pen only: fill what the strokes enclose")
    ap.add_argument("--body", default="", help="hex for the filled body when the drawing has no colour")
    args = ap.parse_args()

    im = load(args.src)
    mask = largest_blob(despeckle(ink_mask(im)))
    im, mask = trim(im, mask)
    if not mask.getbbox():
        print("nothing drawn in that image", file=sys.stderr)
        return 1

    facts, why = (None, "skipped") if args.no_model else describe(im)
    if facts is None:
        print(f"[scan] no model ({why}); taking the palette from the drawing")
        facts = {"subject": "drawing", "name": args.name or "scan", "symmetric": False, "palette": palette_from(im, mask), "keep": ""}
    name = re.sub(r"[^a-z]", "", (args.name or facts.get("name") or "scan").lower()) or "scan"
    if args.body:
        facts["palette"] = [{"role": "body", "hex": args.body}] + [q for q in facts.get("palette", []) if q.get("hex") != args.body]
    pal = [hexrgb(p["hex"]) for p in facts.get("palette", [])][:MAX_COLORS] or [(120, 120, 120)]
    # Line art: the drawing is pen on paper with nothing coloured in, so the body has to be filled
    # with a colour that comes from knowing the character rather than from the page.
    art_is_lines = bool(facts.get("line_art")) or args.line_art
    art = rasterise(im, mask, pal, line_art=art_is_lines)
    art = clean(art)
    if facts.get("symmetric") and not args.no_mirror:
        art = mirror(art)
    art = outline(art)
    cell, body = centre(art)

    out_dir = args.out or os.path.join(OUT_ROOT, name)
    os.makedirs(out_dir, exist_ok=True)
    cell.save(os.path.join(out_dir, f"{name}_idle.png"))
    manifest = {
        "character": name,
        "subject": facts.get("subject", ""),
        "cell": [CELL_W, CELL_H],
        "anchor": "feet",
        "display": {"scale": 3},
        "body": [body[0], body[1], body[0] + body[2] - 1, body[1] + body[3] - 1],
        "scanned_from": os.path.basename(args.src),
        "states": {"idle": {"file": f"{name}_idle.png", "frames": 1, "fps": 1, "loop": True}},
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    preview(im, cell, os.path.join(out_dir, f"{name}_preview.png"))
    print(f"[scan] {facts.get('subject', '?')} -> {out_dir}/{name}_idle.png  body {body}  palette {len(pal)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
