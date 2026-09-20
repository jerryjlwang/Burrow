# Wonderland OS: the White Rabbit (v3, hand-placed pixels)

Original design from public domain book details: white fur, checked jacket, waistcoat, bow tie, pocket watch on a chain. Not the Disney rabbit.

## What "pixel perfect" means here
- No rasterized curves. Every outline run and every shade pixel is placed by hand in `rabbit_px.py`.
- One pixel outline everywhere, no doubled corners, curve steps that shorten evenly (5, 2, 1, 1 into the vertical).
- The sprite is mirrored from one half, so it is exactly symmetric. Only the watch and chain break symmetry.
- Animation moves whole pixels only: shift rows, delete one jacket row for the breath, swap a patch. Nothing is scaled or rotated, so no frame gets blurry or jagged.
- 20 colors, top-lit, one shade per material.

## Files
- `rabbit_<state>.png`: horizontal strips of 48x58 cells, transparent background, cream sticker rim included.
- `manifest.json`: frames, fps, loop, notes, the jump sequence, and `head_dy` for idle (how far to push the overlays down on each frame).
- `rabbit_overlay_mouth.png`: 0 flat, 1 open, 2 wide, 3 smile. Pick by voice loudness.
- `rabbit_overlay_blink.png`: half, closed, half.
- `contact_sheet.png`: every frame on light and dark rows.
- `rabbit_px.py`: the source of truth. Edit a run, run `python3 rabbit_px.py`, every strip regenerates.

## Editing by hand
Open any strip in Aseprite or Piskel with a 48x58 grid. The art is clean enough to edit directly. If you change the base pose, change it in `rabbit_px.py` instead so all states pick it up.

## Renderer rules
- Whole-number scale only (3x in the page overlay, 6x and up for hero moments), `image-rendering: pixelated`.
- Anchor bottom center. Feet end at row 53. The hole lives in rows 50 to 55.
- He never walks. Move him with the hole.
- Jump, sending: `hole_open`, `dive`, `hole_only` reversed.
- Jump, receiving: `hole_only`, loop `hole_wait`, `dive` reversed, `hole_open` reversed, `idle`.
