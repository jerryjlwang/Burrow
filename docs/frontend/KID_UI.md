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
- **Teach card.** After the rabbit asks a question, the bubble shows what he thinks he heard ("So a moat is a ditch with water?") with "Yes" and "Not quite" buttons. This is the teaching loop made visible.
- **Memory.** When he forgets, the thought bubble shows the pixel dissolve and a small "Remind me?" button appears. No streaks, no guilt.
- **Panel.** Same cream frame, teal header band with the rabbit's name and a gold underline. Conversation turns are cream (rabbit) and pale teal (kid) frames. Session ends on its own: the panel shows "That's enough for today, thank you for teaching me" and the rabbit sleeps.

## Copy

Plain, warm, short. The rabbit is a learning buddy, not a best friend. He says "I forgot" and "tell me again", never "you failed". No em dashes.

## Parent UI (later)

Calm and precise: system font, cream and brown, tables not bubbles. Cards for each capability the rabbit can be granted, what the kid taught, and where they are shaky. Lives on the extension's own page, not on the kid's web page.
