# ADR-003: Watching a video along with the student

Date: 2026-09-20. Status: accepted.

## Context

Asked for help with a video, the rabbit said it was "analyzing the frame" and then made forced commentary. Proactive help on video did not exist. The causes were structural:

1. The agent had no sense of video. `VIDEO` is skipped by the page extractor, and there was no playback state or transcript anywhere. Its only route to the content was `observe: screenshot`: a spoken filler line, a model round trip, and one low-quality viewport JPEG of a moving picture. The decision schema then demanded an action, so the model commented on whatever it could see.
2. Every struggle signal came from clicks, quiz UI or typing, so a student watching a video always scored zero.
3. Every proactive model call ended in a bubble or speech. Thinking and speaking were the same act.

## Decisions

### Thinking and speaking are separate (`shared/src/video.ts`)

A watcher pass ends in a private `WatchNote` (`gist`, `concepts`, `assumes`, `raise | null`), never in an utterance. `decideSurface` alone decides whether a note reaches the student, and how loudly: `silent`, `cue` (a glance), `bubble`, `speak`, `interrupt`. `raise: null` and `silent` are the expected outcomes.

The gate's rule: the model's opinion alone never earns an interruption. It needs corroboration from what the student did (the same span gone back over twice or more) or, more weakly, from what the learner graph knows (a gap). Unobserved notes are held for the next pause. Nothing is spoken over a playing video.

The one exception is `kind: "crucial"` at salience 0.85 or above: with the student's standing permission the rabbit pauses the video itself and says the idea. This is rationed (`interruptsPerVideo`, `interruptGapMs`) and honours cooldowns. The student pressing play is treated as an answer.

### The video is read once, up front (`server/src/api/video.ts`)

With a full transcript available there is no reason to think while the student waits. `POST /api/video/analyze` fetches the transcript, runs one silent model pass per ~10 minutes of speech, and caches the result per video. By the time playback reaches a crucial beat, the note for it already exists, which is what makes pausing right after it possible. Replays and the learner graph are then purely local lookups.

Without a model the notes are heuristic (`heuristicNotes`): fixed spans, and a crucial raise only where the speaker flags the idea themselves ("remember this"). That keeps demo mode and the e2e deterministic.

### Transcripts come from a third-party service, never from YouTube

Probed on 2026-09-20: YouTube's `timedtext` URLs return an empty 200 and `youtubei/v1/get_transcript` returns 400 `FAILED_PRECONDITION`, from a logged-in Chrome and from Playwright's Chromium (where even YouTube's own transcript panel and player captions come back empty). Both are attestation-gated, so nothing built on them can be relied on or exercised by our e2e.

Sources, in order: captions the page itself carries (`<track>` via `textTracks`, free, any site), then Supadata (`SUPADATA_API_KEY`) for YouTube. With neither, the agent still gets the frame and says honestly that it cannot hear the video.

### The frame is read off the element (`extension/src/page-understanding/video.ts`)

`drawImage(video)` to a canvas gives the exact frame (768px wide, ~23 KB): no page chrome, no rabbit in shot, no round trip to the background. YouTube's MSE `blob:` source is same-origin, so the canvas is not tainted; DRM or cross-origin media yield `null`. On a video page the frame rides along with the first step of a learning or chat request, so there is no "let me look" step, and an `observe` step can no longer speak.

### What the agent is told (`VideoContext`)

Position, paused or playing, how they are watching (replays, slow-downs), the transcript of the last 75 seconds, and the whole video: its full timestamped transcript and all of the rabbit's notes.

Revised 2026-09-20. The first version stopped at the current time ("the agent must not know, or spoil, what the student has not heard yet"). That made the agent unable to do what a student most wants from a lesson video: find where something is explained, jump there, answer about any part. Not spoiling is a rule about what the rabbit says, not about what it knows, so it moved into the prompt: answer about any part and give its time, but never volunteer what is still ahead (the answer to a worked example they have not watched); say it is coming and where, and offer to jump.

The whole-video text is identical on every step and turn, so it is sent as its own leading message part (`formatVideoReference`), ahead of the frame and the per-step context, where the provider's prefix cache holds it. Over 60k characters (about an hour of speech) it is windowed around the student's position, snapped to five minutes so it still caches; the notes cover the rest.

### The agent works the player (`video` action)

`video` with `value` of `play`, `pause`, `seek` (`text`: "6:40", or "+10" / "-15" from here) or `speed` (`text`: "0.75"). It sets the element directly: instant and exact, where clicking the scrubber from a screenshot was neither. With the whole transcript the agent maps "where he explains the sign flip" to a time itself. A seek the rabbit makes is flagged in `VideoWatcher` so it is not counted as the student going back over something. "pause" is already a local stop command; over a playing video with a quiet rabbit it pauses the video, with no model round trip.

Chapters stay on the page. Asked which chapter covers something, the agent still reads the description and points at the exact chapter line, because seeing it in the page's own list is the useful part; asked to skip to one, it seeks.

### Related and looked-up videos are real videos

`look_up` reads actual videos off YouTube's own results page, server-side and with no cookies (`youtubeSearch`): captioned videos only, so the rabbit can follow whatever gets opened, nothing under a minute, Restricted Mode on. It costs about half a second and needs no key. Supadata's search endpoint was tried first and measured 7–11s per call, too slow to sit inside the agent's chain. The page's embedded `ytInitialData` is not a contract; when it changes the search throws and `look_up` degrades to the search link. Demo mode never searches YouTube, so the e2e stays off it. Before this `look_up` could only return a YouTube search link, so the related-video banner offered "YouTube search for …" as "another video", and its query was the current video's title, whose top hit is the video already playing. The banner's query is now built from the student's question (`relatedQuery`), falling back to the title when the question only points ("what did he just do?").

### A playing video has the floor

While a video plays, the proactive engine counts as busy, so only the video gate can surface anything. Before this, a prerequisite path suggestion popped over the lesson (found by `e2e/video.mjs`).

### Permission

`Settings.videoCompanion`: `"ask"` (default) offers once after 20 seconds of a video that has a transcript; "Sure" becomes `"on"`, a standing permission to follow silently, offer help, and pause for what is crucial. `"off"` surfaces nothing. It is a toggle in the panel and the popup.

### Drawing into the video (`emptiestRegion`, `Board.tsx`)

A `<video>` has no element id and no text to quote, so the model could never anchor a sketch to it and every drawing on a video page fell back to the corner panel. While a video is being watched, a sketch with no named anchor now goes onto the video element, inside the emptiest part of the frame on screen: the frame is reduced to a 96×54 luma grid, local gradient is summed with an integral image, and the largest candidate rectangle that is actually blank wins (blank beats big; every candidate is tall enough to hold a diagram; the bottom strip with controls and captions is never used). Words and diagram both live inside that region. When nothing that size is blank the calmest region is used with a translucent scrim under the drawing.

Two rendering fixes came with it. Strokes are laid out in the canvas's own pixels instead of a stretched `viewBox` with `vector-effect: non-scaling-stroke`: under that effect Chrome measures dashes in screen pixels and ignores `pathLength`, so the draw-in's `stroke-dasharray: 100` left every stroke longer than 100px permanently dashed. The dash pattern now lives only in the keyframes. And every stroke is drawn twice (dark pass, then chalk) with a glow on text, so white ink reads on light pages; outside element wraps the 100×100 space keeps its proportions instead of stretching.

### The drawing belongs to the student

Nothing erases a drawing by itself: not a resumed video, not a new topic. It goes when the student closes it (✕, Escape) or asks the rabbit to. For that the agent is now told what is on screen (`AgentInput.board`, a numbered list from `describeSketch`) and `sketch` gained `value: "erase"` with `text` of `"all"` or item numbers (`"4 5"`, `"2-3"`), so part of a drawing can go while the rest stays exactly where it was (same board id, same position). Before this the model could neither see the board nor remove anything from it.

The student can drag a drawing anywhere by its bounding box: four thin grabbable edges and a grip beside the ✕, with a dashed box that shows on hover or drag. The inside of the box stays click-through, so a video underneath still plays and pauses. The offset is kept per board id, so extending or erasing part of a drawing does not snap it back.

### YouTube dies under Playwright's launch flags, not under the extension

Measured 2026-09-20. Launched through Playwright (`launchPersistentContext`), YouTube plays for 30 to 45 seconds, then the player shows "Something went wrong. Refresh or try again later" and resets — identically with and without the extension, headed and headless; heap flat, no renderer crash, no JS errors. The same Chrome for Testing binary spawned directly, extension loaded, played 180 seconds without a fault. So it is something among the ~40 default flags Playwright adds (which one was not isolated). The extension's script cost during playback measured about 0.05s per 10s over the bare browser.

Consequences: the live test window is spawned directly (`npm run live`, `scripts/live.mjs`), never through Playwright's launcher; the e2e suites keep using Playwright and therefore never depend on YouTube (`demo-pages/video.html` instead).

## Bubbles hold for as long as they take to read (`extension/src/content/bubbles.ts`)

Separate from video but found alongside it: `showBubble` replaced the current bubble instantly and left lifetimes to each caller, while the typewriter alone needs about five seconds for 200 characters. `BubbleQueue` now owns every bubble write. A bubble is guaranteed `bubbleHoldMs(text)` (time to type it out plus reading time, 2.5 to 16 seconds); later bubbles queue behind it, latest-wins among plain replies; an expiry shorter than the hold is stretched; a bubble with buttons stays until answered or expired; only a confirmation jumps the queue.

## Consequences

- One Supadata request and one to six model passes per new video, cached per server process. Everything after that is local.
- Every agent step on a video page carries the whole transcript (about 3–4k tokens per 20 minutes), served from the prefix cache after the first step. One request to YouTube's results page per `look_up` and per related-video banner.
- Videos with no captions and no service key get frame-only help. Tab-audio STT through the existing Deepgram path would close that gap on every site; it needs the `tabCapture` permission and is not built.
- `e2e/video.mjs` covers the flow end to end against `demo-pages/video.html` in demo mode.
