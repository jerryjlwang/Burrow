# The scanner: a hand drawing becomes a pet

The closing beat of the pitch: a judge names the character they loved growing up, someone sketches it
through the demo, and at the end the sketch is scanned and their character appears in the extension.

`python3 tools/sprites/scan.py --in photo.jpg --name hero` turns a photo of the sketch into
`extension/public/characters/<name>/`: a sprite in the rabbit's own 64 by 58 cell, a manifest the
renderer already understands, and an 8x preview with the drawing beside it.

## What was tried, and what the model will not do

A generated sprite of the named character would look best, and the image model does make genuinely
good pixel art: "a friendly knight in blue armour with a red plume" came back as a clean sprite in
about 25 seconds. But every route to a character a judge would actually name is refused:

- the name in the prompt ("Batman"): blocked at output moderation.
- a neutral description of the same character, no name: blocked.
- the sketch itself through `/v1/images/edits`, prompt naming nothing: blocked.

Childhood heroes are almost all somebody's property, so generation cannot be the reveal. It stays in
the file as an option for original characters, off the demo path.

## The way that actually works: the sprite is drawn here, in code

`tools/sprites/guest_px.py` places the pixels by hand, exactly as `rabbit_px.py` and `scene_px.py`
do. Nothing generative is involved, so nothing can refuse it, and the result is in the product's
style by construction rather than by prompt. A caped hero took one pass.

This also fixes the timing. The judge is asked at the *start* of the pitch, so there are five or six
minutes to draw their character while the demo runs, and the scan at the end is the reveal rather
than the computation. A photo of the sketch is only ever looked at, never processed, so it can be
pasted into the chat instead of being moved onto the machine as a file.

## The other way: the sprite is the drawing

Nothing generative, nothing that can be refused, and it runs in well under a second. The story is
also better: it is the drawing they watched being made.

1. **Take the paper out.** The page is scaled to white from its own bright decile rather than an
   average, then saturation is pushed back up, because a phone photo of paper washes marker out.
2. **Find the ink.** Anything darker or more saturated than the paper, then trimmed to that box.
3. **Separate strokes from fills.** A pen stroke is a pixel *darker than its own surroundings*, not a
   pixel under some threshold: a flat cut that keeps thin face lines also swallows a black cowl.
4. **Shrink the two differently.** Fills are area resampled and quantised to a palette taken from the
   drawing; strokes are max pooled, so a one pixel line still lands as a pixel instead of averaging
   away. This is the step that keeps eyes and a mouth at sprite size.
5. **Clean, outline, centre.** Strays go, one pixel holes close, a one pixel ink outline goes round
   the silhouette as every other piece in this product has, and the art sits with its feet on the
   cell's ground row.

`--no-model` skips the vision call entirely and takes the palette from the drawing, which is how the
geometry was tuned. With a key, the model is asked only for JSON: what the subject is, whether it is
symmetric, which colours, and the one feature that must survive. It never returns pixels.

## Known, and next

- The vision call should name the character so the rabbit can *say* it. Words are not moderated the
  way pictures are, and hearing "is that Batman?" is what sells the recognition; the sprite sells
  that it is theirs.
- Walk in and wave: one idle frame is generated today. A bob and a slide read well from a single
  frame; a per limb wave needs rigging the scanner cannot infer.
- Thin legs and fingers still drop out. The fix is to dilate strokes before pooling, not to lower the
  bar, which floods the silhouette.

## What a real sketch taught us

A pen drawing of Pikachu on dotted notebook paper, shot on a phone, broke four things that the
synthetic test never would have:

- **HEIC.** Pillow cannot read the iPhone's default format at all. `open_any` now tries pillow-heif,
  then falls back to `sips` on macOS. On Windows, `pip install pillow-heif` is the answer.
- **Dotted paper.** Every printed dot read as ink. An opening (erode then dilate) drops anything
  thinner than the pen and leaves the strokes whole.
- **A speck at the edge of the photo.** One mark outside the drawing stretched the bounding box, and
  the sprite shrank to a blob in the corner of the cell. Only blobs that are large, or that sit
  inside the drawing's own box, are kept: that keeps eyes and a mouth, which are small and separate.
- **Line art is mostly paper.** A pen drawing has no fills, so it shrank to a hollow outline. The
  body is now flood filled from the middle outwards, not from a corner: a hand drawn outline always
  has a break, and a corner flood pours through it and fills nothing. A leak outward is visible
  (the fill reaches the edge of the picture), so the strokes are sealed harder and it tries again,
  and if nothing holds the body is left unfilled rather than flooding the page.

One more thing a flat threshold got wrong: the stroke detector finds *edges*, which is right for a
thin face line drawn over a large dark fill, and wrong for pen on paper, where it hollows a thick
line into two thin ones that fall apart when shrunk. Line art uses the ink mask itself.

With the model in the loop the whole run is about 13 seconds, nearly all of it the one vision call,
and it names the character itself ("Pikachu face") and gives the colours. Without it, `--line-art
--body "#f7d02c"` does the same in under a second, which is the safer thing to have bound to a key
on the day.

## The face comes from the model, not from the pixels

Hunting for eyes in the shrunk sprite was the wrong tool. A drawn eye is a few dark cells after the
shrink, and the same rules that find it also find a nostril, an ear tip or a fold, so the face came
out crooked or in the wrong place, and a first attempt at stamping a friendly face landed it above
the drawn one and gave the sprite two.

The vision model has already read the drawing, so it is asked where the face is: `eyes`, `mouth` and
`cheeks` as fractions of the picture, plus an `eye_size`. The eyes are then placed on those numbers,
levelled with each other and, on a body that was mirrored, centred on it. Order matters: the body is
made symmetric *before* the face goes on, because mirroring afterwards copies one eye over the other.

Both of those are off by default now, and so is mirroring. The drawing is the point: it is the thing
the judge watched being made, and a tidier face placed from coordinates, or a half copied over the
other half, is a different drawing rather than the same one improved. Mirroring was the worse of the
two, because it took the nose and the mouth with it and left a blank face. `--face` and `--mirror`
turn them back on for a rushed sketch that lost its eyes, or a shape that really is symmetric.

The cheeks were solved by dropping the whole idea of placing them. They are already closed shapes on
the page, so they are the same problem the body was: `colour_holes` finds every region the pen closed
inside the silhouette and fills it, and the model's coordinates only say which is a cheek, which is an
eye and which is the mouth. Cheeks take the accent colour, eyes and a mouth are left as drawn because
the pen already made them dark, and any other hole takes the body colour so nothing stays see through.
Nothing is moved or redrawn.
