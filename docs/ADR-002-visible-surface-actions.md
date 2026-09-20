# ADR-002: Acting on the whole visible surface, with trusted input

Date: 2026-09-20. Status: accepted.

## Context

The agent could only do what its action list could say, and only to elements the extractor had listed. No hover, drag, right-click, double-click, key other than Enter, or click on anything without an accessible name. That rules out exactly the pages a tutor most wants to help on: graphing calculators, canvases, maps, sliders, drag-and-drop answers, hover menus.

Two limits sat underneath that one:

1. The model's view of the page was cut to 2500 characters in the extractor, with each text block cut to 400. A later server-side budget of 4200 never took effect, because the client had already truncated.
2. The one screenshot the model could request was sent at `detail: "low"`, at the capture's native device resolution, so its pixels meant nothing as coordinates.

## Decisions

### Points are a first-class target (`shared/src/actions.ts`, `shared/src/validate.ts`)

`click`, `double_click`, `right_click`, `hover` and `drag` take an `elementId` **or** a point `x,y`; `drag` takes a destination `toElementId` or `toX,toY`. `press_key` takes any key or chord (`shared/src/keys.ts` parses it, so validation and execution cannot disagree about what a chord means). `type` with no element types at the focus; `scroll` with a point wheels over that spot. Listed elements remain the preferred target: they survive layout shifts and need no picture.

One coordinate space everywhere: CSS pixels from the viewport's top-left. The element list prints each on-screen element's centre in it, and the background resamples every screenshot to exactly the viewport's CSS size, so a pixel the model sees is the point to click with no mapping layer. This was measured, not assumed: `gpt-6-astra` returned the centres of three targets on a 1440x900 screenshot with zero pixels of error at `detail` high, original and low. Screenshots now go at `detail: "high"` so small text is legible.

After any action aimed at a raw point, the loop attaches a fresh screenshot to the next step. Aiming by eye without seeing the result is guessing.

### Trusted input through `chrome.debugger` (`extension/src/background/trusted-input.ts`)

Events dispatched from a content script are untrusted. They never trigger CSS `:hover`, never start a native drag, and are ignored by any widget that checks `isTrusted`. Those are the cases this change exists for, so the new actions go to the background, which replays them through the DevTools protocol (`Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`). To the page they are the student's own hands.

Native HTML5 drag-and-drop needs one more step: a real mouse press-and-move hands the pointer to the OS drag loop and never gives it back. The background turns on `Input.setInterceptDrags`, and if the move starts a native drag it finishes the gesture with `Input.dispatchDragEvent` instead. Pointer-driven widgets never start a native drag and just receive the mouse moves.

The plain `click` on a listed element deliberately keeps its existing DOM path. It works, it is the most common action, and it needs no debugger session.

If the debugger cannot attach (a `chrome://` page, a policy block), the executor falls back to dispatched events at the exact point and says so in the action result, so the model knows the page may have ignored it.

### Policy follows the point (`extension/src/agent/loop.ts`)

A coordinate click is judged by what it lands on: the loop resolves the listed element under the point and runs the same confirmation and forbidden-action gates. Coordinates are not a way around "confirm before submitting". Typing at the focus refuses a focused password/payment/code field. Points on the rabbit's own UI and points outside the viewport are rejected.

### The page text is not budgeted

The extractor no longer cuts blocks, and its ceiling is 120,000 characters: a guard that keeps a pathological page inside the model's context window, not a budget. The server passes the text through uncut. The element list cap rose from 120 (extractor) / 90 (prompt) to 400 in both.

## Consequences

- The manifest gains the `debugger` permission. While a session is attached Chrome shows a "started debugging this browser" bar; the background detaches 25 seconds after the last input so it does not linger. Launching Chrome with `--silent-debugger-extension-api` hides it; `e2e/surface.mjs` does, and a demo launcher should too. This permission also draws Web Store review scrutiny; fine for a hackathon build, a real decision before publishing.
- Prompt size now scales with the page. On a long article every decision carries the whole text, which costs latency on the voice path. If that bites, the fix is relevance-ranked text, not a return to a blind prefix cut.
- `e2e/surface.mjs` drives `demo-pages/surface.html`, which logs `event.isTrusted`, so the suite proves input arrived as real input: CSS hover menu, native drag-and-drop, pointer slider, canvas click at an exact pixel, double/right click, key press, and screenshot sizing.
