# Grants and the jump: the handoff contract

Two demo beats need the kid's laptop and the parent's laptop to talk: a parent grants a skill and the rabbit reacts on the kid's page, and the rabbit dives on one screen and pops up on the other. On one machine both work through `chrome.storage.local`, which every tab of the extension sees. Across two laptops the same records travel through the server (see `BACKEND_REQUESTS.md`). The front end only ever reads and writes these keys, so swapping the transport later touches nothing else.

## `burrow.grants`

```json
{ "read_pages": { "granted": true, "at": 1758300000000 }, "use_voice": { "granted": false, "at": 0 } }
```

Skills: `read_pages` (see what is on the page), `use_voice` (listen and talk), `browse_links` (click and open things), `remember` (keep what he learned between days), `visit_parent` (jump to the parent's laptop). The parent view writes this map. The kid's page watches `chrome.storage.onChanged`; when a skill flips to granted the rabbit celebrates and says "Your parent said yes. I can <skill> now." Revoking is quiet.

## `burrow.jump`

```json
{ "id": "j-1758300000000", "to": "parent", "stage": "requested", "at": 1758300000000, "summary": "Today I learned why castles had moats.", "graph": { "version": 1, "nodes": [], "edges": [], "updatedAt": 0 } }
```

- `to` is `"parent"` or `"kid"`. `stage` moves `requested` to `gone` to `arrived`.
- The page the rabbit is leaving sees `requested`, plays the sending sequence, and writes `gone` with the `summary` and the `graph` snapshot he carries. Only the visible tab reacts, so several open tabs do not all dive.
- The page he is going to sees `requested` too: it opens a hole and loops `hole_wait` until it sees `gone`, then pops him out, writes `arrived`, and unrolls the summary beside him (see the set piece below).
- The parent view also saves the carried `graph` under `burrow.graph` so it can show rooms after he leaves again.

## `burrow.graph`

A `GraphSnapshot` from `shared/src/graph.ts`, the latest one the rabbit carried over. The parent view reads it and falls back to a small sample graph when it is missing, so the page always has something to show in a demo.

## The set piece

The records above are the contract; `extension/src/components/tunnel.ts` is the show around them, called from `handoff.ts` at the right moments on both ends. Nothing here changes a record, a stage or a timeout, and the same code runs on the kid's page and the parent page because both mount the companion.

Leaving (the page that sees `requested` for the other side):

1. He says goodbye (2.5 s bubble) and 0.9 s later the hole opens under him.
2. As it opens, the page darkens to dirt from the edges in: four fixed layers of the same 12 x 12 earth tile (`ui/dirt.png` at 25, 50, 75 and 100 percent 4 x 4 Bayer density, from `tools/sprites/ui_px.py`), each masked to everything outside a circle on the hole. The circles shrink together over eight `steps()` (0.56 s), so the edge of the dark is a dither fringe closing in like an iris, until only a clear circle of 20 source pixels around the hole is left.
3. When the dive starts (after `hole_open`, 0.3 s) a descending whoosh plays: filtered noise sweeping 1800 Hz to 140 Hz with a square glide under it. It has its own `AudioContext`, running only once the page has had a click, and it is off with "Speak replies out loud" like every other cue.
4. Six tenths of the way through the dive the rolled notes (`ui/scroll_rolled.png`, two frames) tumble into the hole in seven 18 px steps; the hole's own pixels hide them as they pass its rim.
5. The `gone` record is written as before. A beat later the dirt lets go, back out to the edges in the same eight steps, and is removed.

Arriving (the page that sees `requested` or `gone` for itself):

1. `jumpIn` opens the hole and loops `hole_wait` as before. Once the hole is open, clods of dirt fly out of it in a short loop (squares two and three of his pixels wide, on whole pixel arcs in `steps()`, so a 4x rabbit throws 4x dirt), until the `gone` record or the 12 s timeout lets him come up, when an ascending whoosh plays.
2. He pops out, writes `arrived`, plays `celebrate` (the bounce) and the notes unroll beside him: a `ui/scroll.png` frame whose rods are its top and bottom edges grows from 30 px to its full height in 18 px steps, then the summary (or "I am back! Your parent says hi." on the kid's page) types out inside at the bubble's pace with its voice blips. A click shows all of it; a second click, or 9 s, rolls it back up. This replaces the arrival bubble.
3. The parent page keeps updating its status and buttons from the record as before. Its "What he brought back" box wears the same scroll frame and flashes gold when a new summary lands, and the status line counts dots while he is on his way.

Sending him back is the same in reverse: the parent page leaves through the tunnel, the kid's page digs, then pops him out with the arrival beat. Under reduced motion the dirt, the drop and the digging are skipped and the notes appear whole and still; the sounds and the records are unchanged.

## The drawing board (2026-09-20)

A third role, `board`, is any page on `excalidraw.com`: the window the tablet watcher opens with Alt+Shift+D. The background writes the jump records for it, the pages react exactly as for kid and parent:

- On open: `{ to: "board", from: "kid", stage: "requested" }`. The visible kid page dives and writes `gone`; the board page starts hidden and pops out on `gone` (12 s at most). A board opened by hand with no jump in flight pops him out after 400 ms.
- On stop: `{ to: "kid", from: "board", stage: "requested" }` when the board window is still open (it dives first), or `stage: "gone"` when it was closed (nothing left to dive).
- While a jump to another role is `gone` or `arrived`, a page that loads keeps him in the hole and pauses its proactive engine; the engine resumes when he lands. Jump records carry `from` so the arrival line can differ ("I am back on the page." after the board).
