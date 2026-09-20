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
