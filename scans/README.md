# Drop sketch photos here

    python3 tools/sprites/scan.py --in scans/batman.jpg --name batman

Then look at `extension/public/characters/batman/batman_preview.png`: the drawing on the left, the
sprite on the right. Photos in this folder are ignored by git.

Shooting one that scans well:

- The whole drawing in frame with a little paper around it, and nothing else on the page.
- Straight on, not at an angle. Perspective is not corrected yet.
- Even light. A hard shadow across the page, or your own shadow falling on it, is the one thing that
  really hurts: the paper is flattened from its own brightness, and a shadow reads as ink.
- Colour if the demo drawing will have colour. The palette comes from the drawing.
