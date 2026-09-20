"""
Refresh tools/sprite-editor.html so it edits the current strips.

Usage: python tools/sprites/editor_data.py

Rewrites the embedded DATA line, the cell constants, the preview size and the size hint in the
editor from the generator's output. Run it after rabbit_px.py whenever the cell or a state changes.
"""
import base64
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rabbit_px  # noqa: E402
from PIL import Image  # noqa: E402

EDITOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sprite-editor.html")
KEY = "wonderland-rabbit-v4-edits"

# How each frame was built from the base drawing, so a stroke on one frame lands in the right
# place on the others. n: unchanged. b: the one pixel breath (rows 1 to 41 shift down one).
# m: a whole pixel move by dx, dy; clip hides rows from 53 down, which the hole covers.
N, B = {"t": "n"}, {"t": "b"}


def mv(dx, dy, clip=False):
    return {"t": "m", "dx": dx, "dy": dy, "clip": clip}


MAPS = {
    "idle": [N, N, B, B],
    "to_listening": [N] * 3,
    "listening": [N],
    "from_listening": [N] * 4,
    "to_thinking": [N] * 4,
    "thinking": [N] * 4,
    "to_confused": [N] * 2,
    "from_confused": [N] * 2,
    "to_sleepy": [N] * 3,
    "from_sleepy": [N] * 3,
    "aha": [N] * 4,
    "confused": [N] * 4,
    "celebrate": [B, mv(0, -2), mv(0, -3), mv(0, -3), mv(0, -1), B, B, N],
    "wave": [N] * 8,
    "hop": [B, mv(0, -2), mv(0, -3), mv(0, -1), B],
    "land": [B, B, N],
    "settle": [B, N],
    "panic": [N] * 3,
    "idle_tap": [N] * 8,
    "idle_watch": [N] * 7,
    "idle_flick": [N] * 4,
    "sleepy": [N, B, B, N],
    "dragged": [mv(-1, -2), mv(1, -2)],
    "hole_only": [N] * 3,
    "hole_open": [N] * 3,
    "dive": [mv(0, d, True) for d in (0, 5, 12, 21, 32, 44, 58)],
    "hole_wait": [mv(0, 37, True)] * 4,
    "overlay_blink": [N] * 3,
    "overlay_mouth": [N] * 4,
}
PALETTE_NAMES = {
    "o": "Outline", "w": "Fur", "s": "Fur shade", "p": "Inner ear", "e": "Eye", "h": "Shine", "n": "Nose",
    "b": "Blush", "m": "Mouth", "M": "Tongue", "c": "Bow tie", "C": "Bow knot", "j": "Jacket", "k": "Jacket check",
    "t": "Waistcoat", "u": "Waistcoat edge", "g": "Gold", "f": "Watch face", "H": "Hole", "L": "Hole lip",
    "R": "Sticker rim", "y": "Glyphs",
}


def main():
    S = rabbit_px.build()
    W, H = rabbit_px.W, rabbit_px.H
    man = rabbit_px.export(S)
    states = {}
    for name, st in S.items():
        strip = Image.new("RGBA", (W * len(st["frames"]), H))
        for i, f in enumerate(st["frames"]):
            strip.paste(rabbit_px.image(f), (i * W, 0))
        buf = io.BytesIO()
        strip.save(buf, format="PNG")
        maps = MAPS.get(name) or [N] * len(st["frames"])
        assert len(maps) == len(st["frames"]), f"{name}: {len(maps)} maps for {len(st['frames'])} frames"
        states[name] = {"src": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii"),
                        "frames": len(st["frames"]), "fps": st["fps"], "loop": st["loop"],
                        "file": f"rabbit_{name}.png", "maps": maps}
    palette, seen = [], set()
    for ch, rgba in rabbit_px.PAL.items():
        if ch == "." or rgba[3] == 0:
            continue
        hx = "#%02x%02x%02x" % rgba[:3]
        if hx in seen:
            continue
        seen.add(hx)
        palette.append([PALETTE_NAMES.get(ch, ch), hx])
    data = {"states": states, "palette": palette, "manifest": man}

    html = open(EDITOR, encoding="utf-8").read()
    eol = "\r\n" if "\r\n" in html else "\n"
    lines = html.split(eol)
    hits = {"const": 0, "data": 0, "hint": 0, "preview": 0}
    for i, line in enumerate(lines):
        if re.match(r'^const W=\d+,H=\d+,KEY="[^"]*";$', line):
            lines[i] = f'const W={W},H={H},KEY="{KEY}";'
            hits["const"] += 1
        elif line.startswith("const DATA="):
            lines[i] = "const DATA=" + json.dumps(data, separators=(",", ":")) + ";"
            hits["data"] += 1
        else:
            new = re.sub(r"\b\d+ by 58 frames", f"{W} by {H} frames", line)
            if new != line:
                hits["hint"] += 1
            new2 = re.sub(r"\b(144|192),174\b", f"{W * 3},{H * 3}", new)
            new2 = re.sub(r'width="(144|192)" height="174"', f'width="{W * 3}" height="{H * 3}"', new2)
            if new2 != new:
                hits["preview"] += 1
            lines[i] = new2
    assert hits["const"] == 1 and hits["data"] == 1, hits
    open(EDITOR, "w", encoding="utf-8", newline="").write(eol.join(lines))
    print("editor refreshed:", hits, "| cell", W, "x", H, "| states", len(states))


if __name__ == "__main__":
    main()
