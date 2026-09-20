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

## So the sprite is the drawing

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
