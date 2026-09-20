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

### Page events first; real input is an opt-in escalation

*Revised the same day. The first version sent every new action through `chrome.debugger`. That was heavier than the problem: on our own test page only one of seven behaviours needed it.*

The new actions are dispatched as ordinary DOM events from the content script (`extension/src/actions/surface.ts`). That needs no debugger session and no browser warning, and it reaches almost everything: canvas clicks at an exact pixel, double and right click, pointer-driven sliders, key listeners, and HTML5 drag-and-drop (a `DragEvent` sequence sharing one `DataTransfer`, which is all a drop target reads).

Page events cannot do a short, specific list of things: CSS `:hover` (no event sets it); a key's default behaviour (Tab moving focus, arrows moving a caret, characters landing in a custom editor); calls gated on user activation (unmuted `play()`, `window.open`, fullscreen, clipboard); widgets that call `setPointerCapture`; explicit `isTrusted` checks. For those there is real input: the background replays the action through the DevTools protocol (`extension/src/background/trusted-input.ts`), indistinguishable from the student's hands. Native drags are intercepted with `Input.setInterceptDrags` and finished with `Input.dispatchDragEvent`, because a real press-and-move would hand the pointer to the OS drag loop.

Real input is gated twice:

1. **The student opts in.** `settings.trustedInput`, off by default, toggled in the toolbar popup. While off the background refuses `input` messages and no debugger session is ever opened. Attaching shows Chrome's "started debugging this browser" bar, which shifts the viewport and offers a Cancel button, so it must never appear unasked.
2. **The model opts in per action.** `trusted: true` on a decision means "repeat this as real input". When a page-event action shows no visible change, the result says how to escalate (or that real input is switched off). The model decides from the page and screenshot whether the first attempt took. The executor never retries a click, drag or key by itself: those are not idempotent, and a second click on something that did react would undo it.

The one automatic escalation is `hover`. Hovering twice is harmless, and an unanswered hover is the signature of a CSS `:hover` menu, so with real input on it gets the real mouse without being asked.

The plain `click` on a listed element keeps its original DOM path throughout.

Two bugs the debugger-first version had hidden, both fixed: an aimed click was finished with `el.click()`, which reports the click at (0,0), so a canvas saw the wrong spot; and a key the rabbit pressed for the page reached the rabbit's own Escape handlers, so pressing Escape cancelled its own loop and closed its panel (`noteOwnKey`/`isOwnKey`; `isTrusted` cannot separate the two under real input).

`point_to` and `highlight` also take `x,y`, so the rabbit can show the student a spot that has no element. With real input off, that is how it hands a gesture back: "drag this handle yourself".

### Policy follows the point (`extension/src/agent/loop.ts`)

A coordinate click is judged by what it lands on: the loop resolves the listed element under the point and runs the same confirmation and forbidden-action gates. Coordinates are not a way around "confirm before submitting". Typing at the focus refuses a focused password/payment/code field. Points on the rabbit's own UI and points outside the viewport are rejected.

### The page text is not budgeted

The extractor no longer cuts blocks, and its ceiling is 120,000 characters: a guard that keeps a pathological page inside the model's context window, not a budget. The server passes the text through uncut. The element list cap rose from 120 (extractor) / 90 (prompt) to 400 in both.

## Consequences

- The manifest keeps the `debugger` permission as a required one, but nothing attaches unless the student has switched real input on. Before publishing, move it to `optional_permissions` and request it from the popup toggle (the request needs a user gesture in an extension page, and the install-time warning is a real cost). For a demo with real input on, launch Chrome with `--silent-debugger-extension-api` to hide the bar; the background also detaches 25 seconds after the last real input.
- Prompt size now scales with the page. On a long article every decision carries the whole text, which costs latency on the voice path. If that bites, the fix is relevance-ranked text, not a return to a blind prefix cut.
- `e2e/surface.mjs` drives `demo-pages/surface.html`, which logs `event.isTrusted`, so the suite tells the two paths apart. It proves that by default everything runs on page events and the rabbit holds no debugger session (probed directly: an extension may hold one session per tab, so a second attach is refused exactly when one exists), that a CSS `:hover` menu is the known limit, and that with real input on the hover escalates by itself while clicks, drags and keys escalate only when asked.
