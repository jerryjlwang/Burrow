# Handover for a fresh Claude Code session (front end)

Read this first, then `STATUS.md`. You are the front end agent for Burrow, working for Micah. Two teammates own the backend. This file replaces the context of the long session that built everything so far.

## What Burrow is

An Alice in Wonderland themed AI learning pet for kids, a Chrome MV3 extension for HackMIT 2026. A hand-placed pixel-art White Rabbit lives on top of whatever page the kid is on. The kid teaches him in their own words; he asks naive questions, gets things wrong, forgets on a schedule so the kid re-teaches him. A parent view shows what the kid taught, where they are shaky, and grants skills as cards. The rabbit jumps between laptops by diving down a rabbit hole on one screen and popping up on the other. The demo hero is the White Rabbit only.

Demo beats, in order: he idles and reacts on a page; the kid holds to talk and he listens, thinks with a thought bubble, answers with a moving mouth; a parent grant arrives and he celebrates; he dives on the kid's laptop and pops up on the parent's with what he learned.

## Standing rules from Micah

- Prioritize demo day readiness first, impressiveness second, everything else after. Cool and unique features beat small refinements. It does not have to be perfect; judges have two minutes.
- Git is delegated to Claude on this project: work on `frontend`, small commits with plain messages authored as Micah, no AI co-author trailers, `git fetch` and merge `origin/main` before and after each task and whenever Micah says the backend pushed, then push. Add explicit paths, never `git add -A` on shared folders.
- Front end lane only: `extension/src/components`, `extension/src/newtab`, `extension/src/parent`, `extension/src/popup`, `extension/src/onboarding`, `extension/src/fx`, `extension/public`, `extension/manifest.json`, `extension/build.mjs`, `tools/`, `docs/frontend`. Backend owns `server/`, `scripts/`, `background/`, `offscreen/`, `agent/`, `proactive/`, `actions/`, `page-understanding/`, `content/`. Ask before touching `shared/`. Requests for them go in `BACKEND_REQUESTS.md`.
- The rabbit may move (hops, throws, wander) but only occasionally; holes for long trips. Whole-pixel positions and whole-number scales always. No em dashes anywhere. Copy is plain and short; kid copy warm, parent copy calm.
- Never call art done without rendering it and looking at it. Run `python tools/sprites/audit.py` before committing art. Running `rabbit_px.py` overwrites hand edits, so check first.

## Where things are

- Sprite generator and tools: `tools/sprites/rabbit_px.py` (the rabbit, 64 x 58 cells), `contact_sheet.py`, `audit.py`, `editor_data.py` (refreshes `tools/sprite-editor.html`), `ui_px.py` (9-slice frames), `scene_px.py` (the meadow), `icons_px.py` (extension icons). Output in `extension/public/characters/rabbit`, `ui`, `scene`, `icons`.
- Player and kid UI: `extension/src/components/pet` (manifest loader, `SpritePlayer`, `SpritePet`, `travel.ts`), `Character.tsx` (store state to manifest state), `CompanionRoot.tsx` (dock, hold to talk, page events `burrow:goto`, `burrow:play`, `burrow:leave`, `burrow:enter`, escorted navigation), `handoff.ts` (grants and the jump through `chrome.storage.local`), `Bubble.tsx` (typewriter with voice blips), `sounds.ts`, `styles.css`.
- Pages: `extension/src/newtab` (the meadow, boot, clock, ambience), `extension/src/parent` (rooms, shaky spots, grant cards, the d3-force map), popup, onboarding. Shared page CSS `extension/public/burrow.css`, the WebGL overlay `extension/src/fx` built as `fx.js`.
- Contracts: `CHARACTER_MANIFEST.md` (the player is driven only by the manifest), `HANDOFF.md` (grants and jump records), `KID_UI.md` (the look).

## How to verify

```
npm ci && npm run e2e:install        # once per machine; also pip install pillow for the art tools
npx tsc -p tsconfig.json --noEmit
npx vitest run
node extension/build.mjs
node tools/pet/check.mjs             # 86 checks on light and dark pages, new tab, parent, popup, onboarding; screenshots in tools/pet/shots
npm run e2e                          # the teammates' smoke test with the mock server, 35 checks
```

Load `extension/dist` unpacked in Chrome. The Developer panel (panel gear, then Developer panel) has buttons for every rabbit state, hops, throws, the jump, grants and bubbles.

## Last known state

All of the above passes as of 2026-09-20. See `STATUS.md` for the done list and the next three tasks. Subagents work well for parallel pieces if each gets a strict folder lane and you verify their work yourself.
