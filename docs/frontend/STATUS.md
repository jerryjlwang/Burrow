# Front end status

Updated: 2026-09-19

## Done

- Oriented in the repo. Front end code lives in `extension/src/components`, `extension/src/content`, `extension/public`, `extension/manifest.json` and `extension/build.mjs`. Static files in `extension/public` are copied to the dist root by the build.
- Rabbit sprite strips and their manifest moved to `extension/public/characters/rabbit` (15 strips, 64 x 58 cells). They ship in dist as `characters/rabbit/*`.
- Sprite tools moved to `tools/sprites/rabbit_px.py`, `tools/sprites/README.md` and `tools/sprite-editor.html`. The two reference players stay in `tools/reference`.
- Generator output path fixed so `python tools/sprites/rabbit_px.py` writes into `extension/public/characters/rabbit`.
- `web_accessible_resources` added for `characters/*` so the content script can load sprites with `chrome.runtime.getURL`.
- Product renamed to Burrow in front end files: manifest, package.json, popup, onboarding, debug panel. Default character name is White Rabbit. Backend-owned files still say Pip, see `BACKEND_REQUESTS.md`.
- Task 1, thinking eyes: the glance no longer shifts the eye blocks. Both eye shapes stay in place and only the shine moves down and right (`LOOK_SHINE` in `rabbit_px.py`). Checked at 8x on light and dark with `tools/sprites/contact_sheet.py`.
- Task 2, thought bubble: the cell is now 64 x 58 for every state (the rabbit did not move; 8 transparent columns were added on each side and verified pixel for pixel). `thinking` shows a hand-placed cream bubble with a brown outline, two trailing circles and a pocket watch whose hand ticks. New state `aha` plays once when the answer is ready: unlit bulb, lit bulb, sparks, then idle frame 0. Sprite editor refreshed for the new cell with `tools/sprites/editor_data.py`. Checked at 8x, 10x and 12x on light and dark.

- Task 3, transitions: hand-placed `to_listening` (ears rise a pixel at a time, eyes widen a frame later), `from_listening` (ears dip below rest once, then settle), `to_thinking` (trail, then bubble, then watch), `to_confused` and `from_confused` (left ear folds half way through a new 45 degree ear), `to_sleepy` (sag, half fold with heavy eyes, flop) and `from_sleepy` (half up, stretch above rest, settle). The manifest carries `enter` and `exit` per state, and the generator's `verify()` checks every transition ends on the frame it hands off to. Contract in `docs/frontend/CHARACTER_MANIFEST.md`. Checked at 6x, 12x and 14x on light and dark.

- Task 4, motion: `celebrate` is now crouch, launch, peak, fall, land squash, recover, settle (8 frames, 10 fps) with the ears lagging the body and the pocket watch lagging and swinging on a re-linked chain. `wave` runs through the half-folded ear and settles on idle frame 0. The idle breath has the ears lag the head by a frame. Three idle variants, `idle_tap` (foot lifts twice), `idle_watch` (lifts the watch, glances at it, lets it drop) and `idle_flick` (left ear flicks twice), are listed in `idle.variants` with weights. The hop tops out at three pixels because the ears have only three rows of room, and the verifier now flags any frame whose rim would be clipped. Checked at 6x to 12x on light and dark.

- Task 5, audit: `tools/sprites/audit.py` checks every frame for a complete cream rim, left right symmetry outside the watch, chain and glyphs, feet ending on row 53 when grounded, hole pixels only in rows 50 to 55, two pixel thick outlines, stray pixels, and blink and mouth overlays covering the eyes and mouth on every frame that lists them. It found one real problem, the swung watch doubling the jacket outline in the celebrate recover frame, which now swings two pixels clear. Zero findings across 103 frames, plus an eyeball pass of the full cast at 4x on light and dark.

- Task 6, on-page pet: `extension/src/components/pet` holds the manifest loader, the `SpritePlayer` state machine (fps, loop, hold, reverse, enter and exit chains with a latest-wins queue, one-shots back to idle, weighted idle variants, blink timer, loudness-driven mouth, `head_dy`, drag override, manifest jump sequences) and the `SpritePet` canvas component (whole-number scale, body-box hit area, pointer-capture dragging, viewport clamping, `moveTo`, `jumpOut`, `jumpIn`). `Character.tsx` maps the store's states to manifest states. The dock, bubble and panel follow the rabbit and never overlap it. The debug panel has buttons to force every state, hop across, jump out and jump in without voice. Checked with a Playwright run of the built extension on a light and a dark page: 32 of 32 checks pass, no console warnings, screenshots viewed on both backgrounds. Nine unit tests cover the player. Onboarding now renders the rabbit at 2x.

- Movement round, art: `hop` travel cycle with per frame `move` values and `land` for thrown landings; `wander_gap` and `wander_hops` in the manifest. `tools/pet/check.mjs` runs the on-page checks and saves screenshots to `tools/pet/shots`.
- Pixel UI assets: `tools/sprites/ui_px.py` writes hand-placed 9-slice frames (bubble, tail, four button styles) to `extension/public/ui/`. Pixelify Sans (OFL) is in `extension/public/fonts/`. Design note in `docs/frontend/KID_UI.md`.

- Movement round, player: `extension/src/components/pet/travel.ts` holds the pure movement rules (hop or hole choice, hop planning, wander gate with a hard minimum gap, where to stand beside a pointed element, throw physics, release velocity). The player accumulates `move` per frame; `SpritePet` applies it in whole multiples of the scale, flies thrown drags with gravity and one bounce, wanders only while quiet and never more than once per `wander_gap[0]` seconds, resizes 2x to 6x through the hole with the feet fixed, and hop trips end with the calm `settle` state while throws end with `land`. `CompanionRoot` sends him beside a newly pointed element when the panel is closed. Debug buttons: hop left and right, throw, go to headline, wander now, grow 4x, shrink 2x, normal 3x. `panic` art exists for the "I'm late" vignette but is not wired yet. Checked with `tools/pet/check.mjs`: 52 of 52 on light and dark, screenshots viewed. 107 unit tests pass.

- Kid UI restyle: the bubble, panel, messages, input, buttons, badges and the minimized tab now use the hand-placed 9-slice frames at 15px (5 source pixels at 3x) with `border-image` and `repeat`, the Burrow palette (cream, brown, teal, gold, red) and Pixelify Sans loaded through the FontFace API (page CSP cannot block it, and `@font-face` does not work inside a shadow root). The bubble has a pixel tail that flips when the bubble hangs below the pet. A hold to talk button with the rabbit's ear sits at his feet: tap turns voice on, tap again turns it off, a hold listens until release plus a short grace. Product renamed to Burrow in front end files. Checked with `tools/pet/check.mjs`: 56 of 56 on light and dark, bubble and panel screenshots viewed.

- Handoff, front end side: `extension/src/components/handoff.ts` follows `docs/frontend/HANDOFF.md`. A newly granted skill makes the rabbit celebrate and say what he can do now. A jump request makes the visible tab he is leaving say goodbye, dive, and write the `gone` record with a summary and the graph he carries; the page he is going to opens a hole, waits for `gone` (12 s at most), pops him out, writes `arrived`, and shows the summary. The "I'm late" vignette runs after a long quiet spell: watch check, panic, then a hole trip to a new spot. Debug buttons: grant voice, revoke voice, call to parent, send to kid. The parent view itself is being built in `extension/src/parent`.

## In progress

- Parent view page (`extension/src/parent`), built by a subagent against `HANDOFF.md` and `KID_UI.md`.

## Blocked

- Nothing. Micah approved the movement overhaul and the UI restyle on 2026-09-19 and dropped the "never walks" rule; movement must stay occasional.

## Next three tasks

1. Decide the direction for the extension's own pages (new tab, onboarding, parent view), see the proposal to Micah.
2. Wire the "I'm late" vignette (panic, then a hole trip) as a rare idle event, and peeking from the edge.
3. Parent UI, then wire `jumpOut` and `jumpIn` to the real handoff.

## Notes

- `python tools/sprites/contact_sheet.py --states idle,thinking --frames 0,2 --scale 8 --out sheet.png` renders any states at any scale on light and dark. `python tools/sprites/audit.py` runs the pixel rules. Neither writes to the shipped strips.
- Typecheck, build and unit tests pass on the `frontend` branch as of this update.
- The debug panel (settings, Developer panel) is the quickest way to see every state on a real page.
- Known simplification: `thinking.exit` is `aha` on every exit, so a barge-in during thinking shows the bulb for two thirds of a second before listening.
