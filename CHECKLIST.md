# Manual test checklist

Run through this before a demo. Server: `npm run dev:server` (or `DEMO_MODE=1 npm run dev:server` for fully deterministic replies). Extension: `npm run build`, load `extension/dist` unpacked, reload after rebuilds.

## Install & basics
- [ ] `npm install` → `npm run build` → load unpacked → onboarding tab opens automatically.
- [ ] Onboarding: "Enable microphone" prompts Chrome once; "Got it" finishes; "Open demo pages" works.
- [ ] Visit any normal site (news, docs, Wikipedia): Bunny appears bottom-right, does not cover content, page still scrolls/clicks normally.
- [ ] Dark-mode site: panel and bubble remain readable.
- [ ] Site with a body transform / weird CSS (e.g. a page using `transform` on `<body>`): Bunny stays fixed bottom-right.
- [ ] Popup: shows server connected + voice status; toggles persist.
- [ ] Protected page (`chrome://extensions`): popup explains Bunny can't run there; no errors.

## Panel & text mode
- [ ] Click character → panel opens; Esc closes; "–" minimizes to an edge tab; tab restores.
- [ ] Type "what's on this page" → short spoken summary + "More" detail in the panel.
- [ ] Type "where is the sign in button" on the demo dashboard → ring + beam on the Sign in control, character looks toward it.
- [ ] Type "click it" → navigates to Sign in page; panel stays open; conversation preserved; Bunny says "It's open."
- [ ] "take me to the quiz" on the dashboard → scrolls down, highlights and clicks "Take the quiz".
- [ ] "type 5 into your answer" on the practice page → value set, page reacts.
- [ ] "type my password" / password field → Bunny refuses and points, never types.
- [ ] "scroll down", "go back" work.

## Voice (needs DEEPGRAM_API_KEY)
- [ ] Mic button → green live dot on the character, "Listening…" status.
- [ ] Speak "where is the sign in button" → interim transcript shows while speaking, final transcript becomes a user message.
- [ ] Reply is spoken in flux-rufus-en; character animates while speaking; ring reacts to your voice while listening.
- [ ] Talk over Bunny mid-sentence → audio stops immediately, your words are processed.
- [ ] Say "stop" while it talks → audio stops, "Okay." shown, nothing else happens.
- [ ] Mute button ends voice mode; green dot disappears.
- [ ] Kill the server while listening → "Voice is having trouble connecting" notice; text chat still works.
- [ ] Mic permission denied → friendly bubble with "Open setup".

## Proactive (demo practice page)
- [ ] Enter a wrong answer once → Bunny glances toward the answer box (no bubble).
- [ ] Wrong answer twice → bubble "…Want a hint?" (spoken if voice mode is on). Nothing before ~45s cooldown repeats.
- [ ] Click "Yes, please" (or say "yeah") → hint mentions doing the same thing to both sides, points at the answer box; does NOT reveal x = 5.
- [ ] Ask "hint" again → hint escalates (subtract 5 → 3x = 15 → divide).
- [ ] Enter 5 → "Correct!" → Bunny celebrates ("Nice—you got it.").
- [ ] "I'm good" to an offer → no more offers for ~3 minutes.
- [ ] Quiz page: click the disabled-looking Continue 3× → bubble points at the options: "That one unlocks once you answer…".
- [ ] Grades page (403) → "Looks like a dead end. Want me to take you back?"
- [ ] Turn off "Notice when I'm stuck" in settings → no offers.

## Safety
- [ ] "click submit quiz" → confirmation bubble; "No" leaves the quiz unsubmitted; "Go ahead" submits.
- [ ] "submit assignment" on the assignment page → asks first.
- [ ] Sign-in page password never appears in the developer panel's element list (marked [sensitive], no value).

## Resilience
- [ ] Server down: Bunny still points/clicks/hints using the offline brain; panel shows the offline notice.
- [ ] LLM key missing: server logs `agent provider: mock`; everything still works.
- [ ] Reload the extension while a page is open → Bunny re-injects into open tabs (or page reload restores it).
- [ ] Developer panel (settings → Developer panel) shows page elements, signals, last decision/result, provider latency.

## Tablet watcher (needs GEMINI_API_KEY in .env; a second touch display is optional)
- [ ] On any page press Alt+Shift+D (or popup, "Watch the tablet") → the rabbit says "To your drawing board!" and dives; excalidraw.com opens fullscreen on the touch display (beside you on one screen) and he pops out of a hole in its corner; he is gone from the laptop page. Popup shows "Watching the tablet".
- [ ] Open the show-your-work page on the laptop, write `3x + 5 = 20` then `3x = 25` on the board → he says "Hold on." (or "Wait, wait.") the moment the slip is spotted, hops (a hole for a long trip) to stand beside that line, a teal ring is drawn around the `25` like a quick pen loop, and then he speaks a question that names the step, never `15` or `x = 5`, with Yes and No under the bubble.
- [ ] Ask him "circle the 15 on my second line" or "point out where I went wrong" → he says "Right here" and rings that part of the handwriting; nothing else on the page is touched.
- [ ] Once the mic has been allowed once, every time he finishes saying something the mic comes on by itself (green dot) so you can just answer; you never need the button again. Mute stops it until he speaks next.
- [ ] Sit and think after a nudge → the ring stays, he stays put and says nothing more for ordinary checks; only a long pause brings a further hint. Answer him by talking or writing: no Yes or No buttons under a nudge or a note. Finish correctly → one "Nice, that's it.", not one per check.
- [ ] Leave the pen still for about 20 s → he goes to the empty part of the board, his chalkboard rises beside him with a similar example in other numbers (or a question or a small diagram), and he says one line.
- [ ] Rewrite the same wrong line, still wrong, and wait → the next nudge names the exact part to look at; the one after gives a tiny example with different numbers. A new mistake starts again at a question.
- [ ] Say or click "Yes, please" → the conversation knows the lines he read; he speaks only (one question or one small observation a turn) and never gives the corrected line or the answer, even when asked straight out.
- [ ] Fix the line → the ring fades. Finish with `x = 5` → the rabbit celebrates once and the note board goes.
- [ ] Draw something unrelated → no nudge (verdict "unclear" in the popup). Slow, messy or unfinished work → no nudge. His own bubble, hop and board do not trigger checks (popup check count stays put while he moves).
- [ ] Developer panel on any page: "ink: slip", "ink: slip, rung 2", "ink: stall note", "ink: solved" rehearse the beats without a tablet (on the board page he moves and draws; elsewhere only the words). `node e2e/tablet.mjs` with the server running walks the whole beat against the live judge.
- [ ] Press Alt+Shift+D again → the board comes forward and the context follows the tab you pressed it on. "Stop watching" in the popup stops and he dives back to the laptop page; closing the board window also stops and he pops back out on the laptop.
- [ ] Server without a Gemini key → the mock cycles fine, slip, solved so the beat still rehearses.
