# Requests for the backend team

Things the front end needs from backend-owned code. Anything not done yet is mocked on the front end so work is not blocked.

## 1. Finish the rename from Pip to Wonderland

Status: open. Requested 2026-09-19.

Front end files now say Wonderland, and the default character name is White Rabbit. These strings live in backend-owned files:

- `server/src/agent/prompt.ts`: the persona still tells the model it is Pip. The pet should be the White Rabbit: curious, a little naive, asks the kid questions, forgets on a schedule and asks to be re-taught.
- `extension/src/background/index.ts`: context menu titles "Pip", "Explain this with Pip", "Summarize this with Pip".
- `extension/src/content/controller.ts`: the "Pip was updated" status string.
- `extension/src/offscreen/offscreen.html`: page title.
- `server/src/index.ts`: startup log line.
- `demo-pages/*.html`: footer text.
- `README.md` and `CHECKLIST.md`.

Internal identifiers can stay as they are: `pip-` CSS classes, the `pip.settings` storage key, `__PIP_VERSION__`, and the `[pip:*]` logger namespaces.

One line in `e2e/smoke.mjs` was changed by the front end to match the new onboarding heading ("Meet the White Rabbit"). Please keep that in sync if the heading changes again.

## 2. Cross-laptop jump handoff

Status: heads-up, not needed until the on-page pet exists. Will be mocked with a local timer.

The jump is a two-step handoff. The receiving laptop confirms it is ready, then the sending laptop plays the dive. The front end needs a way to send a "ready?" question to the other laptop and get a "ready" answer back, plus a final "done" message with whatever the rabbit carries over. A proposal: three messages over the existing server socket, `jump.request`, `jump.ready` and `jump.done`, keyed by a pairing code the parent view shows.

## 3. Parent approval event

Status: heads-up, not needed yet. Will be mocked with a debug panel button.

The demo needs a parent approval to arrive on the kid's laptop and unlock a skill. The front end needs a pushed event with the skill name. The parent UI will send the grant, the kid's extension reacts.
