# Burrow: the White Rabbit (v4, hand-placed pixels)

Original design from public domain book details: white fur, checked jacket, waistcoat, bow tie, pocket watch on a chain. Not the Disney rabbit.

## What "pixel perfect" means here
- No rasterized curves. Every outline run and every shade pixel is placed by hand in `rabbit_px.py`.
- One pixel outline everywhere, no doubled corners, curve steps that shorten evenly (5, 2, 1, 1 into the vertical).
- The sprite is mirrored from one half, so it is exactly symmetric. Only the watch and chain break symmetry.
- Animation moves whole pixels only: shift rows, delete one jacket row for the breath, swap a patch. Nothing is scaled or rotated, so no frame gets blurry or jagged.
- 20 colors, top-lit, one shade per material.

## The cell
- Each frame is 64 x 58. The rabbit was drawn on a 48 wide cell and sits in the middle: `OFF` (8) columns were added on each side to make room for the thought bubble. Every absolute column in `rabbit_px.py` is still written in 48 wide terms and gets `OFF` added when painted, so the old drawings did not move.
- Anchor is bottom center. Feet end at row 53. The hole lives in rows 50 to 55.
- `manifest.json` carries `cell`, `body` (the rabbit's pixel box in idle frame 0, rim included) and per state `frames`, `fps`, `loop`, `notes` and `head_dy`.

## Files
- `rabbit_<state>.png`: horizontal strips of 64 x 58 cells, transparent background, cream sticker rim included.
- `manifest.json`: frames, fps, loop, notes, the jump sequence, `body`, and `head_dy` for idle (how far to push the overlays down on each frame).
- `rabbit_overlay_mouth.png`: 0 flat, 1 open, 2 wide, 3 smile. Pick by voice loudness.
- `rabbit_overlay_blink.png`: half, closed, half.
- `rabbit_px.py`: the source of truth. Edit a run, run it, every strip regenerates. Strips whose pixels did not change are left alone so git stays quiet.
- `contact_sheet.py`: renders states at any scale on a light and a dark background. Look at the result before calling art done.
- `audit.py`: checks every frame against the pixel rules (rim, symmetry, feet row, hole rows, outline thickness, stray pixels, overlay coverage). Run it before committing art.
- `editor_data.py`: refreshes `tools/sprite-editor.html` with the current strips. Run it after `rabbit_px.py` whenever a state or the cell changes.
- `ui_px.py`: hand-placed 9-slice frames for the speech bubble and buttons in the same palette, written to `extension/public/ui/`. `--preview out.png` composes samples at 3x.
- `icons_px.py`: the extension icons, the rabbit's face hand-placed at 16 x 16 and scaled whole to 32, 48 and 128, written to `extension/public/icons/`.
- `scene_px.py`: the new tab meadow (sky, hills, hedge, grass, shrubs, flowers, the burrow mound, clouds, birds, fireflies, the pixel clock digits, the sign planks) as one atlas per time of day plus `manifest.json`, written to `extension/public/scene/`. `--sheet out.png` renders every piece at 4x.

## Commands
```
pip install pillow
python tools/sprites/rabbit_px.py
python tools/sprites/contact_sheet.py --states idle,thinking --scale 8 --out sheet.png
python tools/sprites/editor_data.py
python tools/sprites/audit.py
```

## States
- `idle`, `listening`, `thinking`, `aha`, `confused`, `celebrate`, `wave`, `sleepy`, `dragged`, `hole_only`, `hole_open`, `dive`, `hole_wait`, `overlay_blink`, `overlay_mouth`.
- `thinking` loops with a pocket watch ticking in a thought bubble. `aha` plays once when the answer is ready: the watch becomes a light bulb, sparks, and the bubble pops. Its last frame is idle frame 0.
- Other characters reuse these names. Ask before renaming any.

## Editing by hand
Open `tools/sprite-editor.html`, or any strip in Aseprite or Piskel with a 64 x 58 grid. If you change the base pose, change it in `rabbit_px.py` instead so all states pick it up. Running the generator overwrites hand edits, so port them into `rabbit_px.py` first.

## Renderer rules
- Whole-number scale only (3x in the page overlay, 6x and up for hero moments), `image-rendering: pixelated`.
- Anchor bottom center. Feet end at row 53. The hole lives in rows 50 to 55.
- Short trips are hops (`hop` with its `move` list); long trips go through the hole. Wandering is rare, see `wander_gap`.
- Jump, sending: `hole_open`, `dive`, `hole_only` reversed.
- Jump, receiving: `hole_only`, loop `hole_wait`, `dive` reversed, `hole_open` reversed, `idle`.
