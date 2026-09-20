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
import io
import json
import os
import re
import sys
import urllib.request

from PIL import Image, ImageFilter, ImageOps

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

def load(path):
    """Open the photo and take the paper out of it: the page becomes white, the marker keeps its colour."""
    im = Image.open(path)
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
 "keep":"<one short sentence: the one feature that must survive shrinking, for example the long ears or the round belly>"}

Give between two and five palette entries, ordered by how much of the drawing they cover, taking the colours from the drawing itself. If the drawing is only pencil or pen on paper, choose colours that suit the subject instead. No em dashes."""


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


def rasterise(im, mask, pal):
    """Fit the drawing into the cell: flat colour from coverage, then the pen lines laid back on top."""
    w, h = im.size
    k = min(FIT_W / w, FIT_H / h)
    tw, th = max(1, round(w * k)), max(1, round(h * k))
    small = im.convert("RGB").resize((tw, th), Image.BOX)
    cover = mask.convert("L").resize((tw, th), Image.BOX)
    lines = pool_max(ink_lines(im, mask), tw, th)
    out = Image.new("RGBA", (tw, th), CLEAR)
    op, sp, cp, lp = out.load(), small.load(), cover.load(), lines.load()
    for y in range(th):
        for x in range(tw):
            if lp[x, y]:
                op[x, y] = INK
            elif cp[x, y] >= 110:
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
    args = ap.parse_args()

    im = load(args.src)
    mask = ink_mask(im)
    im, mask = trim(im, mask)
    if not mask.getbbox():
        print("nothing drawn in that image", file=sys.stderr)
        return 1

    facts, why = (None, "skipped") if args.no_model else describe(im)
    if facts is None:
        print(f"[scan] no model ({why}); taking the palette from the drawing")
        facts = {"subject": "drawing", "name": args.name or "scan", "symmetric": True, "palette": palette_from(im, mask), "keep": ""}
    name = re.sub(r"[^a-z]", "", (args.name or facts.get("name") or "scan").lower()) or "scan"
    pal = [hexrgb(p["hex"]) for p in facts.get("palette", [])][:MAX_COLORS] or [(120, 120, 120)]

    art = rasterise(im, mask, pal)
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
