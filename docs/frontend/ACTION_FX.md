# The rabbit acts out the agent's actions

When the agent opens a tab, clicks, types, scrolls, or pauses and resumes a video, the rabbit goes to the thing and does it, with a small effect around the moment. The show lives in `extension/src/components/actfx/`; the two hooks that feed it are the only backend-lane lines involved.

## The hooks

`burrow:act` (window event, from `actions/executor.ts` at the top of `executeAction`): `{ action, elementId, rect, point, url, text, direction, hold? }`. `rect` is the target's viewport box when the action names an element, `point` when it names a spot. A listener may set `detail.hold` to a promise; the executor waits for it at most 900 ms (`ACT_HOLD_MS`) before running the action, so the rabbit's tap and the click land together. Nothing listening, nothing waits.

`burrow:video` (window event, from `page-understanding/video.ts`): `{ kind: "pause" | "play" | "seek", by: "us" | "them", rect }`. `us` is the companion (a pause to talk, a play to resume), `them` the student's own control. A companion pause also fires the DOM pause, so a `them` within 400 ms of an `us` of the same kind is the same moment and `ActionFx` drops it.

## The frame

`actfx/index.tsx` mounts one fixed, pointer-transparent layer (`.pip-actfx`) in the companion's shadow root and routes each event to a module by action. A piece gets `{ pet, layer, reduced, petRect }` (`common.ts`): the sprite player (`goTo`, `hopTo`, `moveTo`, `play(state)`, `jumpOut`, `jumpIn`, `fling`), the layer to draw into, reduced motion, and the rabbit's body box. `spawn()` adds a pixel element to the layer and removes it on a timer; `standBeside()` picks where he stands to reach a rect.

Modules and their actions:

- `tabs.ts`: `open_tab`, `switch_tab`, `navigate`, `go_back`.
- `hands.ts`: `click`, `double_click`, `right_click`, `hover`, `drag`, `press_key`, `press_enter`, `type`, `clear`, `select`, `focus`, `scroll`, `scroll_to`.
- `video.ts`: the three video kinds, ours and theirs.

Rules for a piece: show only (never touch the page, never change what an action does); whole pixels on the 3px grid and `steps()` timing; the Burrow palette (cream, brown, teal, gold, red); no em dashes in any text; reduced motion means the effect appears whole and still or is skipped; a hold of at most 900 ms, and the piece keeps going after the hold if it has more to show; a broken piece never throws past `ActionFx`. Each module's CSS is its own section at the end of `styles.css` under the `.pip-actfx` section. The Developer panel's "act: ..." and "video: ..." buttons send the same events for testing.

## video

`actfx/video.ts` acts out `burrow:video`. The layer stays pointer-transparent and the file never pauses or plays anything; the watcher and the student do that. Pixel pieces come from `tools/sprites/actfx_video_px.py` (into `extension/public/ui/actfx/`): the play triangle, the pause badge, the pocket watch as eight frames, the gold "!", and four Bayer dim tiles. `video-sound.ts` holds the cues, gated like the tunnel whoosh (sounds on, and only after a gesture); at most one cue a piece, quiet.

- pause by us: he travels (`goTo`) to the frame's bottom left corner, outside it, and taps (`idle_tap`). At the tap a big pause glyph (two cream bars, 3px outlines, 15 percent of the frame's height, 45px at least) pops in the centre in three whole steps (half, over, full, 70 ms each) and holds a beat (450 ms) while the frame dims through the four tiles (90 ms a step, three quarters of the cells at most, so the picture stays visible). He waves to the viewer. The glyph then shrinks into the top left corner in five steps (60 ms each) and the 33px badge takes over with a three-frame drop. The badge and the dim follow the page on scroll and stay until a play.
- play by us: he taps again (a trip first if he has wandered). The play triangle pulses twice where the badge was (3x, 4x, 3x, 4x, 3x at 90 ms) while the dim lifts tile by tile, six cream motes rise from the lower part of the frame in twelve whole steps and fade, and he glances at his watch (`idle_watch`) beside the frame.
- pause by them: no travel; `idle_watch`, and the badge pops into the corner in two whole scales (2x then 3x). play by them: the badge goes the same way, the dim lifts if there was one, the "!" pops over his head (2x, 4x, 3x, a beat, gone) and he settles (`settle`).
- seek by them: the watch drops into the top right corner and its hand spins three turns (eight frames a turn, 360 ms a turn, one tick a turn). Scrubbing keeps one watch going rather than stacking them.
- Reduced motion: no travel, no steps; the badge and the dim appear whole and go at once, the glyph shows whole for a beat, no motes, no spin.
- A newer pause or play piece sweeps the transient pieces of an older one and stops its steps. The centre of the frame is clear after the first beat; nothing here is bigger than the badge or the watch once that beat is over.
