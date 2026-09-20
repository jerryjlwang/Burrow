"""
Render rabbit states as a contact sheet on a light and a dark background.

Usage: python tools/sprites/contact_sheet.py [--states idle,thinking] [--frames 0,3] [--scale 8] [--out path.png]

Defaults to every state at 4x. Nothing here touches the shipped strips.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rabbit_px  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

LIGHT = (223, 230, 238, 255)
DARK = (24, 28, 38, 255)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", default="", help="comma separated state names, default all")
    ap.add_argument("--frames", default="", help="comma separated frame indexes to keep, default all")
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "contact_sheet.png"))
    args = ap.parse_args()

    S = rabbit_px.build()
    names = [n for n in args.states.split(",") if n] or list(S)
    keep = [int(i) for i in args.frames.split(",") if i]
    if keep:
        for n in names:
            S[n] = dict(S[n], frames=[f for i, f in enumerate(S[n]["frames"]) if i in keep])
    sc, pad, label_h = args.scale, 6, 16
    W, H = rabbit_px.W, rabbit_px.H
    cw, ch = W * sc + pad, H * sc + pad
    maxf = max(len(S[n]["frames"]) for n in names)
    sheet = Image.new("RGBA", (maxf * cw + pad, len(names) * (2 * ch + label_h + pad)), (110, 110, 110, 255))
    draw = ImageDraw.Draw(sheet)
    y = 0
    for n in names:
        st = S[n]
        draw.text((pad, y), f"{n}: {len(st['frames'])} frames, {st['fps']} fps, {'loop' if st['loop'] else 'once'}", fill=(255, 255, 255, 255))
        y += label_h
        for bg in (LIGHT, DARK):
            for i, f in enumerate(st["frames"]):
                cell = Image.new("RGBA", (W * sc, H * sc), bg)
                cell.alpha_composite(rabbit_px.image(f).resize((W * sc, H * sc), Image.NEAREST))
                sheet.paste(cell, (pad + i * cw, y))
            y += ch
        y += pad
    sheet.save(args.out)
    print(args.out, sheet.size)


if __name__ == "__main__":
    main()
