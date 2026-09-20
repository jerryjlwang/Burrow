# Kid UI design note

The kid UI is everything the kid sees around the rabbit: the speech bubble, the hold to talk control, and the small panel. It should look like it belongs to the rabbit, not to a chat app.

## Look

- Palette from the rabbit: cream `#fff8e7` fill, brown `#3b2a23` outline and text, teal `#2f8f83` primary, gold `#f2c14e` secondary, red `#d9534f` alerts, white `#fffdf5` for text on teal or red.
- Frames are the hand-placed 9-slice pieces in `extension/public/ui/` drawn with `border-image` at the same whole-number scale as the rabbit (3x on the page). No blur, no gradients, no glass. Shadows are a crisp offset, `box-shadow: 3px 3px 0 rgba(59, 42, 35, 0.25)`.
- Font: Pixelify Sans (`extension/public/fonts/`, OFL) loaded through `@font-face` from `chrome.runtime.getURL`. Kid text 18px, headings 20px, never below 17px. Long passages fall back to the system font.
- Everything sits at whole pixel positions. Bubble and panel edges land on the 3px grid.

## Pieces

- **Speech bubble.** Cream frame with the tail pointing at the rabbit's head. One or two short sentences. Buttons inside are the pixel buttons: teal for the main choice, gold for the other, cream for quiet actions like "Not now".
- **Hold to talk.** A big round pixel button under the rabbit with an ear on it. Hold with mouse, touch or the space bar. While held the rabbit plays listening and the button fills teal from the bottom like a rising meter tied to loudness. Release sends the turn. Kids do not need to find a microphone icon.
- **Teach card.** After the rabbit asks a question, a card in his dock shows what he thinks he heard ("So a moat is a ditch with water?") with "Yes" (teal) and "Not quite" (gold). Yes makes him celebrate and the card says "Got it. I'll remember." for two seconds. Not quite opens the panel with "Tell me again" in its status line. Enter is Yes, Escape is Not quite. This is the teaching loop made visible; `TeachCard.tsx`, driven by `burrow:teach` (see Events).
- **Memory.** When he forgets, a thought bubble with the concept dissolves in Bayer steps (a CSS mask, eight steps of 90 ms) and a small card says "I forgot about moats." with one "Remind me?" button, which opens the panel with "Remind me about moats" already typed. Escape or the corner cross puts it away. No streaks, no guilt. Driven by `burrow:forget`.
- **Panel.** Same cream frame, teal header band with the rabbit's name and a gold underline. Conversation turns are cream (rabbit) and pale teal (kid) frames. Session ends on its own: the panel shows "That's enough for today, thank you for teaching me" and the rabbit sleeps.
- **Chalkboard.** When he explains a worked example he pulls up a chalkboard beside himself: the hand-placed wooden frame in `ui/board.png` (gold lit edge, chalk tray with a stub of chalk) around a dark green slate. Chalk is VT323 through the FontFace API, cream for the steps and gold for the title, because Pixelify's digits are hard to read. He writes one line at a time with a chalk squeak (`chalk` in `sounds.ts`); the line being written is bright with a chalk underline once it lands, earlier lines dim. The board rises from the floor in pixel steps and sinks the same way (nothing moves under reduced motion). It stands on his side of the hold to talk button with its tray on his feet line, follows him, and never covers him; above his head only when neither side has room. He thinks while he writes and has his aha when the last line lands. A small × in the slate's corner or Escape dismisses it; tapping the slate finishes the writing.

## Events

Pages and the extension's own views can direct the rabbit with window events: `window.dispatchEvent(new CustomEvent(name, { detail }))`.

- `burrow:board` with `{ title?: string, lines: string[] }` opens the chalkboard and writes those lines out. A line that starts with a draw command (`line`, `arrow`, `circle`, `rect`, `dot`, `label`; see `shared/src/sketch.ts`) becomes a chalk stroke. Empty `lines` closes the board. The developer panel's "chalkboard" button does the same with a sample. Handled in `Board.tsx`.
- `burrow:play` with `{ state }`, `burrow:goto` with `{ x, y }` and `burrow:leave` with `{ url, line?, arriveLine? }` are handled in `CompanionRoot.tsx`.

## Events

Page events on `window` that drive the teaching loop. The backend dispatches them from the content script or any page script; the developer panel's "teach card" and "forget" buttons send the same events with "moats".

- `burrow:teach`, detail `{ heard: string, concept: string }`. Shows the teach card with `heard` as its line ("So a moat is a ditch with water?") and the Yes and Not quite buttons. A new event replaces the card on screen.
- `burrow:forget`, detail `{ concept: string }`. The thought bubble with the concept, the dissolve, then the "I forgot about <concept>." card with "Remind me?".
- The card answers with `burrow:taught`, detail `{ concept: string, heard: string, yes: boolean }`, on Yes and on Not quite, so the backend can record the outcome. "Remind me?" reaches the backend as the kid's own message once they send it.
- The rabbit's state is the backend's: the card only asks him to play `celebrate` on Yes (through `burrow:play`); set `confused` around a forget if he should look it.

The other page events, `burrow:play` {state}, `burrow:goto` {x, y}, `burrow:leave` {url, line?, arriveLine?} and `burrow:enter`, are in `CompanionRoot.tsx`.

## Copy

Plain, warm, short. The rabbit is a learning buddy, not a best friend. He says "I forgot" and "tell me again", never "you failed". No em dashes.

## Parent UI (later)

Calm and precise: system font, cream and brown, tables not bubbles. Cards for each capability the rabbit can be granted, what the kid taught, and where they are shaky. Lives on the extension's own page, not on the kid's web page.

## New tab page

The kid's start page is the meadow above the burrow: hand-placed pixel layers from `tools/sprites/scene_px.py`, composed at source resolution and drawn at 3x by `extension/src/newtab/scene.ts`. The light follows the time of day (morning, day, evening, night, with `?hour=N` to force it), clouds drift, grass sways, fireflies blink at night, and the mouse moves the layers in whole pixels. The clock is pixel digits from `scene/digits.png`. The search lives on a wooden sign: typing pops letters with a blip, focusing calls the rabbit over to listen, and Enter makes him dive down his hole before the page leaves, then pop out on the results page. The `fx.js` overlay adds scanlines and the dither dissolve.

## Panel, popup and onboarding

One product with the rabbit, on the same 3px grid:

- **Panel.** The teal band carries his name, a 9px status dot and one status line at 17px (gold and blinking while he listens). The header buttons are 7 x 7 pixel glyphs drawn at 3x (`GLYPHS` in `Panel.tsx`), never font symbols. An empty panel says hi and offers three starters as cream pixel chips; a tap fills the input so the kid can change the words before sending. His turns are the cream frame; the kid's turns are the same frame with a pale teal inside, a layer clipped to the frame's 3px staircase, so no new art was needed. "More" opens the long version as plain paragraphs at 17px, not a `pre`. Settings are 21px pixel checkboxes (teal with a paper dot when on) in 30px rows. Offline and voice trouble show as a gold strip with a pixel bang.
- **Popup.** The same card: cream frame, teal band with his face (`icons/icon48.png`, the 16px face at 3x), one status line, five pixel buttons in a two column grid, the same toggles (`.px-check` in `burrow.css`), the server field. 320px wide, everything 17px or larger, nothing scrolls.
- **Onboarding.** He is "he", in short sentences. The three step bars are 168px wide with 4px gaps (512px, the card's inner width). The card hangs 48px from the top, never vertically centred, so its edges stay on whole pixels. `burrow.css` line heights are whole pixels: body 24px, h1 36px, h2 27px, h3 24px.

