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
- The page he is going to sees `requested` too: it opens a hole and loops `hole_wait` until it sees `gone`, then pops him out, writes `arrived`, and shows the summary in a bubble.
- The parent view also saves the carried `graph` under `burrow.graph` so it can show rooms after he leaves again.

## `burrow.graph`

A `GraphSnapshot` from `shared/src/graph.ts`, the latest one the rabbit carried over. The parent view reads it and falls back to a small sample graph when it is missing, so the page always has something to show in a demo.

## The drawing board (2026-09-20)

A third role, `board`, is any page on `excalidraw.com`: the window the tablet watcher opens with Alt+Shift+D. The background writes the jump records for it, the pages react exactly as for kid and parent:

- On open: `{ to: "board", from: "kid", stage: "requested" }`. The visible kid page dives and writes `gone`; the board page starts hidden and pops out on `gone` (12 s at most). A board opened by hand with no jump in flight pops him out after 400 ms.
- On stop: `{ to: "kid", from: "board", stage: "requested" }` when the board window is still open (it dives first), or `stage: "gone"` when it was closed (nothing left to dive).
- While a jump to another role is `gone` or `arrived`, a page that loads keeps him in the hole and pauses its proactive engine; the engine resumes when he lands. Jump records carry `from` so the arrival line can differ ("I am back on the page." after the board).
