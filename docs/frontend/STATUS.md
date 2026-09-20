# Front end status

Updated: 2026-09-19

## Done

- Oriented in the repo. Front end code lives in `extension/src/components`, `extension/src/content`, `extension/public`, `extension/manifest.json` and `extension/build.mjs`. Static files in `extension/public` are copied to the dist root by the build.
- Rabbit sprite strips and their manifest moved to `extension/public/characters/rabbit` (15 strips, 64 x 58 cells). They ship in dist as `characters/rabbit/*`.
- Sprite tools moved to `tools/sprites/rabbit_px.py`, `tools/sprites/README.md` and `tools/sprite-editor.html`. The two reference players stay in `tools/reference`.
- Generator output path fixed so `python tools/sprites/rabbit_px.py` writes into `extension/public/characters/rabbit`.
- `web_accessible_resources` added for `characters/*` so the content script can load sprites with `chrome.runtime.getURL`.
- Product renamed to Wonderland in front end files: manifest, package.json, popup, onboarding, debug panel. Default character name is White Rabbit. Backend-owned files still say Pip, see `BACKEND_REQUESTS.md`.
- Task 1, thinking eyes: the glance no longer shifts the eye blocks. Both eye shapes stay in place and only the shine moves down and right (`LOOK_SHINE` in `rabbit_px.py`). Checked at 8x on light and dark with `tools/sprites/contact_sheet.py`.
- Task 2, thought bubble: the cell is now 64 x 58 for every state (the rabbit did not move; 8 transparent columns were added on each side and verified pixel for pixel). `thinking` shows a hand-placed cream bubble with a brown outline, two trailing circles and a pocket watch whose hand ticks. New state `aha` plays once when the answer is ready: unlit bulb, lit bulb, sparks, then idle frame 0. Sprite editor refreshed for the new cell with `tools/sprites/editor_data.py`. Checked at 8x, 10x and 12x on light and dark.

- Task 3, transitions: hand-placed `to_listening` (ears rise a pixel at a time, eyes widen a frame later), `from_listening` (ears dip below rest once, then settle), `to_thinking` (trail, then bubble, then watch), `to_confused` and `from_confused` (left ear folds half way through a new 45 degree ear), `to_sleepy` (sag, half fold with heavy eyes, flop) and `from_sleepy` (half up, stretch above rest, settle). The manifest carries `enter` and `exit` per state, and the generator's `verify()` checks every transition ends on the frame it hands off to. Contract in `docs/frontend/CHARACTER_MANIFEST.md`. Checked at 6x, 12x and 14x on light and dark.

## In progress

- Task 4, anticipation, settle and secondary motion, plus idle variety. `celebrate` and `wave` still end off idle frame 0; the verifier warns about them and Task 4 adds their settle frames.
- Task 6, the on-page player, is being built in parallel in `extension/src/components/pet`.

## Blocked

- Nothing.

## Next three tasks

1. Task 4: anticipation, settle and secondary motion, plus random idle variety.
2. Task 5: pixel alignment audit of every frame.
3. Task 6: integrate and check the on-page player on light and dark pages.

## Notes

- `python tools/sprites/contact_sheet.py --states idle,thinking --scale 8 --out sheet.png` renders any states at any scale on light and dark. Nothing in it writes to the shipped strips.
- Typecheck, build and unit tests pass on the `frontend` branch as of this update.
- The onboarding page still renders the old CSS/SVG mascot. It switches to the rabbit once the sprite player exists.
