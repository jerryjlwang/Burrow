# Bunny — HackMIT Education Hack Winner

Bunny is a Chrome extension: a small animated character in the bottom‑right corner of every page. It **sees the page you're on**, **talks with you by voice**, **points at things**, **clicks and types when you ask**, and — the part that matters most — **notices when you're stuck and offers a hint** instead of doing your work for you.

```
Student is working on 3x + 5 = 20 … enters 3 … "Not quite" … enters 7 … "Not quite"
Bunny glances at the answer box, then a tiny bubble: "Looks like this one's being stubborn. Want a hint?"
Student: "Yeah."
Bunny (pointing at the answer box): "Try getting the 5 out of the way first. What could you do to both sides?"
Student enters 5 → "Correct!" → Bunny: "Nice—you got it."
```

Core principle: **help the student regain momentum without taking the learning away.**

---

## What it does

| Capability | How |
|---|---|
| Understands the page | Content script builds a compact semantic model (headings, visible text, every interactive control with a stable id, states, errors, dialogs, quiz UI). No raw DOM is ever sent to the model. |
| Talks & listens | Deepgram Flux STT (streaming, native end‑of‑turn) → agent → Deepgram Flux TTS `flux-rufus-en` (speed 1, expressivity 0), streamed and playable within ~a second. Barge‑in: talk over Bunny and it stops instantly. |
| Points | Highlight ring + spotlight + animated beam from the character to the element; scrolls off‑screen targets into view first. |
| Acts | Constrained, schema‑validated actions: click, type, select, scroll, navigate, focus, wait, observe… executed with realistic events and **verified** afterwards (DOM/URL change, new errors). |
| Asks first | Central policy: submitting schoolwork, sending, buying, deleting, publishing… always confirmed. Passwords / payment / codes are never typed or read. |
| Notices struggle | Local, model‑free signals (repeated wrong answers, hammering a dead button, validation errors, dead‑end pages, backtracking, hesitation) escalate through 4 intensity levels: look → “?” → bubble → speech. Cooldowns; “I'm good” is respected. |
| Coaches | Hint ladder: nudge → hint → explanation → analogous example → more direct. Never the final answer on assessments. |
| Survives navigation | Conversation, student model and an in‑flight agent loop persist per tab; “Open it” → page changes → “It's open.” |
| Always in the corner | Injected on every http(s) page in every tab, plus a New Tab override page so Ctrl+T never loses him. Only `chrome://` settings pages and the Web Store are off‑limits (Chrome policy). |
| Works offline | If the server or LLM is unreachable, a deterministic rule‑based brain still points, clicks, summarizes and gives hints (demo‑safe). |

---

## Architecture

```
┌──────────────────────────── Chrome ─────────────────────────────┐
│  Web page                                                        │
│  ┌──────────────── content script (shadow DOM UI) ─────────────┐ │
│  │ page-understanding ─► PageSummary + element registry        │ │
│  │ proactive/ signals ─► levels ─► offers                       │ │
│  │ agent/loop  observe → decide → policy → execute → verify     │ │
│  │ actions/    executor · overlay (highlight/point) · policy    │ │
│  │ components/ Character · Panel · Bubble · Overlay · Debug     │ │
│  └────────────▲────────────────────────────┬────────────────────┘ │
│   broadcasts  │ chrome.runtime messages    │ decide/intervene/tts │
│  ┌────────────┴────────────────────────────▼────────────────────┐ │
│  │ background service worker: routing, tab sessions, nav,        │ │
│  │ screenshots, context menu, commands, offscreen lifecycle      │ │
│  └────────────▲──────────────────────────────────────────────────┘ │
│  ┌────────────┴──────────── offscreen document ─────────────────┐ │
│  │ mic → AudioWorklet (16k PCM) → ws /ws/stt      (survives      │ │
│  │ ws /ws/tts → 24k PCM → WebAudio playback · barge‑in · echo    │ │
│  └───────────────────────────┬───────────────────────────────────┘ │
└──────────────────────────────┼───────────────────────────────────┘
                               │ localhost:8787
┌──────────────────────────────▼───────────────────────────────────┐
│ server (Node + ws)                                                │
│  POST /api/agent/decide     AgentProvider: OpenAI (strict JSON    │
│  POST /api/agent/intervene  schema) │ mock (rules) │ fallback     │
│  WS   /ws/stt  ⇄  Deepgram Flux STT (listen v2) / Nova‑3 fallback │
│  WS   /ws/tts  ⇄  Deepgram Flux TTS (speak v2 ws) / REST fallback │
│  GET  /demo/*  demo learning site · GET /health                   │
└───────────────────────────────────────────────────────────────────┘
```

Secrets (Deepgram, LLM keys) live only in the server's `.env`. The extension never sees them.

### Repository layout

```
extension/           Chrome MV3 extension (TypeScript + React, esbuild)
  manifest.json      permissions, entry points
  build.mjs          esbuild build (prod by default; --watch / --dev)
  src/content/       entry, controller (composition), store
  src/background/    service worker
  src/offscreen/     mic capture worklet, STT/TTS sockets, playback
  src/page-understanding/  extractor, registry, change watcher
  src/actions/       executor, overlay/pointer, confirmation policy
  src/agent/         bounded agent loop, per-tab session/student model
  src/proactive/     signal tracker, intervention engine
  src/voice/         content-side voice controller
  src/components/    Character, Panel, Bubble, Overlay, DebugPanel, styles
  src/onboarding/    first-run page (mic permission, privacy)
  src/popup/         toolbar popup (status, toggles)
server/src/          Node server: agent providers, prompt, voice proxies, static
shared/src/          action schema + validators, types, mock agent, hint bank, text matching
demo-pages/          "Riverside Learning" fake LMS for the demo scenarios
e2e/smoke.mjs        Playwright smoke test (real Chrome + extension)
CHECKLIST.md         manual test checklist
```

---

## Setup

Requirements: Node 20+, Google Chrome.

```bash
npm install
cp .env.example .env          # then add your keys (see below)
npm run dev                   # server (tsx watch) + extension build (watch)
```

Or separately: `npm run dev:server` and `npm run build` (one‑off production build).

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `DEEPGRAM_API_KEY` | **Secret.** Enables voice (STT + TTS). Without it Bunny is text‑only. |
| `LLM_API_KEY` | **Secret.** OpenAI (`sk-…`) key; `OPENAI_API_KEY` also works. Without it the server runs the rule‑based mock agent. |
| `LLM_PROVIDER` | `openai` or `mock`. If omitted, an `sk-…` key selects `openai` and no key falls back to `mock`. |
| `LLM_MODEL` | Default `gpt-6-astra`. |
| `LLM_EFFORT` | Reasoning effort for decisions: `none` (fastest, recommended for voice) / `minimal` / `low` (default) / `medium` / `high`. The server adapts the name to what the model supports. |
| `DEEPGRAM_TTS_MODEL` | `flux-rufus-en` (default) |
| `DEEPGRAM_TTS_SPEED` | `1` (default) |
| `DEEPGRAM_TTS_EXPRESSIVITY` | `0` (default) |
| `DEEPGRAM_STT_MODEL` | `flux-general-en` (default). Any `nova-*` model switches to the Nova (listen v1) path. |
| `PORT` | `8787` |
| `DEMO_MODE` | `1` forces the deterministic mock agent for a fully predictable demo. |

Never put real keys in `.env.example`, the extension, or logs. The Deepgram key you were given belongs only in your local `.env`.

### Load the extension in Chrome

1. `npm run build` → `extension/dist/`
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, pick `extension/dist`.
3. The onboarding tab opens: meet Bunny → **Enable microphone** (Chrome asks once, for the extension) → privacy note.
4. Open any page (or the demo at http://localhost:8787/demo/). Bunny sits bottom‑right.

After code changes: `npm run build`, then click the reload icon on the extension card. Already‑open tabs get the content script re‑injected automatically; reload a tab if in doubt.

Keyboard: `Alt+Shift+P` opens/closes the panel, `Alt+Shift+V` toggles voice mode (change in `chrome://extensions/shortcuts`). Right‑click selected text → **Bunny ▸ Explain / Summarize / Read aloud / Hint**.

---

## How voice works

1. Click the mic (or `Alt+Shift+V`). The background creates an **offscreen document** (extension origin) which calls `getUserMedia` — that's why onboarding asks for the permission once.
2. An `AudioWorklet` converts mic audio to 16 kHz linear16 PCM (40 ms chunks) and streams it over `ws://localhost:8787/ws/stt`. The server relays to **Deepgram Flux** (`listen.v2`, `eot_threshold 0.7`). `TurnInfo` updates become interim transcripts; `EndOfTurn` becomes the student's turn.
3. The transcript goes to the active tab's content script → agent loop → decision. The `say` text goes back through the background to the offscreen document, which asks the server over `ws://…/ws/tts`. The server holds one **Deepgram Flux TTS** socket (`speak.v2`, `flux-rufus-en`, linear16 24 kHz, speed 1, expressivity 0), sends `Speak` + `Flush`, and forwards PCM frames as they arrive. Playback starts on the first frame.
4. **Barge‑in:** while Bunny speaks, any new speech (`StartOfTurn`/`Update`) that isn't an echo of what Bunny just said stops playback locally (WebAudio sources stopped), sends `Interrupt` upstream, and the new utterance is processed. “Stop”, “wait”, “hold on” are handled locally with no model call.
5. Failures degrade gracefully: no key → voice off with a friendly note; socket loss → up to 3 reconnects, then “Voice is having trouble connecting. You can still type to me.”; TTS socket failure → REST fallback.

The green dot on the character means the mic is live; one click on the mic button mutes. No audio is stored anywhere.

## How the agent works

Each student turn runs a **bounded loop** (max 6 steps): `observe → decide → policy → execute → verify`.

- `observe` builds a `PageSummary` (≤ ~2.5k chars of text, ≤ 120 elements, viewport first). Elements get stable ids kept in a `WeakMap` registry, so “it” keeps working across rescans.
- `decide` posts `AgentInput` (utterance, goal, recent conversation, page, recent action results, struggle signals, student state, last referenced element) to the server. The OpenAI provider uses **structured outputs** (`response_format: json_schema`, `strict: true`), so the model can only return a schema‑valid action. Any output is re‑validated on both sides; malformed output never executes.
- `policy` (`extension/src/actions/policy.ts`) is the single place that decides what needs confirmation (`requiresConfirmation`) and what is forbidden (`isForbidden`: sensitive fields, card‑like numbers, credential requests).
- `execute` runs the action with realistic pointer/mouse events or framework‑compatible value setting, then `verify` waits for DOM/URL changes and diffs error messages. Stale elements cause a re‑observe, never a repeated click on a dead node.
- If an action navigates, the loop state is stored per tab and the next page's content script resumes it.

Provider abstraction: `server/src/agent/provider.ts` (`AgentProvider.decide/intervene`). Implementations: `openai.ts` (Chat Completions + strict JSON schema), `mock.ts`. `api/agent.ts` wraps them with fallback + validation. The same mock also runs **inside the extension** when the server is unreachable. Try the configured provider without a browser: `npx tsx scripts/try-agent.ts` (or pass an utterance).

## Proactive help

`extension/src/proactive/signals.ts` tracks cheap local signals (no model calls): repeated clicks without DOM change, clicks on disabled controls, validation errors after actions, wrong‑answer loops per problem, time on a problem, URL oscillation, dead‑end pages. `computeLevel` maps signal strength to levels 0–4, honouring cooldowns (45 s), declines (3 min, lowered intensity) and the proactive toggle. Only at level ≥ 3 is the agent asked *whether* to intervene (`/api/agent/intervene`, mock fallback). Level 3 shows a bubble (also spoken when you're already in a voice conversation), level 4 speaks.

## Demo

Start the server (add `DEMO_MODE=1` for fully deterministic behaviour) and open http://localhost:8787/demo/.

| Scenario | Where | What to do |
|---|---|---|
| A · Confused student | Practice: Linear Equations (`/demo/algebra.html`) | Enter two wrong answers → “Want a hint?” → say/click yes → a hint that teaches, pointing at the answer box. Enter 5 → Bunny celebrates. |
| B · Navigation | Dashboard | “Where is my assignment?” → highlight. “Open it.” → Bunny clicks, page changes, “It's open.” |
| C · Accessibility | Any demo page | “What's on this page?” → summary. “Take me to the quiz.” → scrolls, highlights, navigates. |
| D · UI confusion | Module 3 Quiz | Click the greyed‑out Continue 3× → Bunny: “That one unlocks once you answer—these options right here.” |
| Safety | Quiz / Assignment | “Submit the quiz” → confirmation bubble first. Sign‑in page: Bunny never types into the password box. |
| Dead end | Grades (403) | Bunny offers to take you back. |

Definition‑of‑done walkthrough (see the task spec): install → `.env` → `npm run dev` → build → load unpacked → any page → click Bunny → enable mic → speak → transcript → “Where is the sign in button?” → highlight → “Click it” → navigation with the companion intact → demo problem → repeated mistakes → offer → hint that teaches → interrupt speech → confirmations → graceful failures.

## Development

```bash
npm run dev            # server + extension watch
npm run typecheck      # tsc over extension, server, shared
npm test               # vitest: extraction, hidden filtering, schemas, policy, signals, executor, mock agent, hints
npm run e2e:install    # once: downloads Playwright's Chromium (Google Chrome ≥137 ignores --load-extension)
npm run e2e            # Playwright: Chromium + built extension + demo server, headless (npm run e2e:headed to watch)
npm run build          # production bundle → extension/dist
npx tsx scripts/try-agent.ts      # run the demo scenarios through the configured LLM provider (no browser)
npx tsx scripts/voice-check.ts    # TTS → STT loopback through a running server: latency + transcript accuracy
```

Developer panel: panel ⚙ → **Developer panel** (or popup). Shows page summary, detected elements, character state, last transcript, goal, last decision/result, provider latency, proactive signals and a live log. Logger namespaces: `[pip:page] [pip:agent] [pip:action] [pip:voice] [pip:proactive] [pip:character] [pip:bg] [pip:offscreen]`; sensitive keys are redacted before logging.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings (`chrome.storage.local`) and per‑tab session state (`chrome.storage.session`). |
| `activeTab`, `tabs` | Find the active tab for voice routing, navigate/go back, capture a screenshot when the DOM isn't enough (canvas/PDF). |
| `scripting` | Re‑inject the content script into already‑open tabs after install/reload. |
| `offscreen` | Microphone capture and audio playback that outlive page navigations. |
| `contextMenus` | “Ask Bunny about this” on selected text. |
| `topSites`, `favicon` | The New Tab override page shows your most‑visited sites with their icons. |
| `chrome_url_overrides.newtab` | Chrome forbids extensions on its own New Tab page, so Bunny ships his own start page (search box + shortcuts) and lives there too. |
| `host_permissions: <all_urls>` | Bunny must appear on arbitrary pages (content script) — broad for the hackathon; restrict to a domain list for a real release. `localhost:8787` is listed explicitly for the server. |

## Known limitations

- Chrome's PDF viewer isolates content: Bunny detects PDFs, doesn't crash, and can only use screenshots/selected text (limited). Cross‑origin iframes are not inspected.
- `chrome://` pages (settings, extensions, history) and the Chrome Web Store cannot host extensions at all; the New Tab page is covered by Bunny's own start page.
- The mic permission is per extension origin; if onboarding was skipped, the first voice start fails with a bubble that opens setup.
- Echo suppression is heuristic (Chrome AEC + transcript/spoken‑text similarity). Use headphones for the cleanest barge‑in.
- The offline rule‑based brain handles navigation, pointing, summaries and hints, but not open‑ended questions.
- Screenshot context is only requested when the model asks (`observe` + `"screenshot"`), never continuously.
- Pages that hide the character (`hiddenOnHosts`) must be edited via the storage for now (no UI).
