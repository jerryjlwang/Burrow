"""Test inputs for tools/pet/become/check.mjs: a cartoon character on a beige wall as a photo
(robot-cat.png), the same picture as a fake camera feed for Chromium (robot-cat.y4m, not committed,
55 MB), and the rabbit blown up on a cream wall (rabbit-photo.png). Run: python tools/pet/become/make-inputs.py"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

here = Path(__file__).parent
root = here.parent.parent.parent
np.random.seed(3)
W, H = 1280, 960
im = Image.new("RGB", (W, H), (214, 198, 172))
# A wall with a soft gradient and a little noise, like a real wall in lamplight.
arr = np.array(im).astype(np.int16)
gx = np.linspace(-12, 12, W)[None, :, None]
gy = np.linspace(-8, 8, H)[:, None, None]
arr = arr + gx + gy + np.random.randint(-4, 5, (H, W, 1))
im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
d = ImageDraw.Draw(im)
cx, cy = W // 2, H // 2
# A round orange robot cat: body, head, ears, eyes, a green scarf, boots.
d.ellipse((cx - 150, cy - 40, cx + 150, cy + 260), fill=(235, 140, 60), outline=(80, 40, 20), width=6)
d.ellipse((cx - 170, cy - 260, cx + 170, cy + 40), fill=(240, 160, 80), outline=(80, 40, 20), width=6)
d.polygon([(cx - 150, cy - 200), (cx - 120, cy - 330), (cx - 60, cy - 230)], fill=(240, 160, 80), outline=(80, 40, 20))
d.polygon([(cx + 150, cy - 200), (cx + 120, cy - 330), (cx + 60, cy - 230)], fill=(240, 160, 80), outline=(80, 40, 20))
d.ellipse((cx - 90, cy - 150, cx - 30, cy - 90), fill=(255, 255, 255), outline=(40, 30, 30), width=4)
d.ellipse((cx + 30, cy - 150, cx + 90, cy - 90), fill=(255, 255, 255), outline=(40, 30, 30), width=4)
d.ellipse((cx - 70, cy - 130, cx - 45, cy - 105), fill=(30, 30, 40))
d.ellipse((cx + 45, cy - 130, cx + 70, cy - 105), fill=(30, 30, 40))
d.ellipse((cx - 20, cy - 70, cx + 20, cy - 45), fill=(220, 80, 110))
d.rectangle((cx - 140, cy + 10, cx + 140, cy + 60), fill=(60, 160, 110), outline=(30, 80, 60), width=5)
d.rectangle((cx - 110, cy + 230, cx - 40, cy + 300), fill=(70, 60, 120), outline=(30, 30, 60), width=5)
d.rectangle((cx + 40, cy + 230, cx + 110, cy + 300), fill=(70, 60, 120), outline=(30, 30, 60), width=5)
im = im.filter(ImageFilter.GaussianBlur(0.8))
im.save(here / "robot-cat.png")


def i420(img):
    y = np.array(img.convert("YCbCr"))
    return y[:, :, 0].tobytes() + y[::2, ::2, 1].tobytes() + y[::2, ::2, 2].tobytes()


with open(here / "robot-cat.y4m", "wb") as f:
    f.write(f"YUV4MPEG2 W{W} H{H} F30:1 Ip A1:1 C420jpeg\n".encode())
    fr = i420(im)
    for _ in range(30):
        f.write(b"FRAME\n" + fr)

r = Image.open(root / "extension/public/characters/rabbit/rabbit_idle.png").convert("RGBA").crop((0, 0, 64, 58))
big = Image.new("RGB", (800, 800), (250, 244, 230))
scaled = r.resize((640, 580), Image.NEAREST)
big.paste(scaled, (80, 60), scaled)
big.save(here / "rabbit-photo.png")
print("wrote robot-cat.png, robot-cat.y4m, rabbit-photo.png")

# A black and white drawing on paper: a round cat with closed outlines, for the colour-by-numbers check.
paper = Image.new("RGB", (900, 900), (246, 243, 236))
d = ImageDraw.Draw(paper)
cx, cy = 450, 470
d.ellipse((cx - 200, cy - 60, cx + 200, cy + 320), outline=(30, 30, 30), width=9)
d.ellipse((cx - 180, cy - 320, cx + 180, cy + 10), fill=(246, 243, 236), outline=(30, 30, 30), width=9)
d.polygon([(cx - 165, cy - 250), (cx - 130, cy - 400), (cx - 50, cy - 290)], fill=(246, 243, 236), outline=(30, 30, 30), width=9)
d.polygon([(cx + 165, cy - 250), (cx + 130, cy - 400), (cx + 50, cy - 290)], fill=(246, 243, 236), outline=(30, 30, 30), width=9)
d.ellipse((cx - 110, cy - 200, cx - 30, cy - 120), outline=(30, 30, 30), width=8)
d.ellipse((cx + 30, cy - 200, cx + 110, cy - 120), outline=(30, 30, 30), width=8)
d.ellipse((cx - 85, cy - 175, cx - 55, cy - 145), fill=(30, 30, 30))
d.ellipse((cx + 55, cy - 175, cx + 85, cy - 145), fill=(30, 30, 30))
d.ellipse((cx - 25, cy - 110, cx + 25, cy - 75), outline=(30, 30, 30), width=7)
d.ellipse((cx - 110, cy + 20, cx + 110, cy + 250), outline=(30, 30, 30), width=8)
paper = paper.filter(ImageFilter.GaussianBlur(0.6))
paper.save(here / "cat-drawing.png")
print("wrote cat-drawing.png")
