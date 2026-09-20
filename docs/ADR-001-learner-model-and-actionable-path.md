# ADR-001: General step plans, an actionable path consumer, and learner diagnostics

Date: 2026-09-20. Status: accepted.

## Context

Three limits showed up once the base was solid:

1. Step-judging only worked for `ax ± b = c`, via a regex parser. Any other problem got generic hints and no step awareness.
2. The path consumer produced a sentence ("want to look at fractions?") and, on accept, a Socratic chat. It never took the learner anywhere.
3. The longitudinal graph recorded exposure, not performance. `recordSuccess`, `recordStruggle` and `recordAsk` existed but had no callers, so mastery was a function of page views and nothing could be said about accuracy, retention or interest.

The third was the root: you can't suggest well, or check whether a suggestion worked, without evidence of how the learner actually does.

## Decisions

### One event stream into the graph (`shared/src/events.ts`)

Everything the graph learns is a `LearnerEvent`. A tab applies it to its RAM mirror and forwards the same event to the background, which replays it through the same `applyLearnerEvent`. `Session.record(event)` is the only write path. This replaces hand-mirrored calls in the controller and engine, and makes "the tab and the persisted graph disagree" structurally impossible.

New evidence, and where it comes from:

| Event | Source |
| --- | --- |
| `attempt` | Page feedback the tracker already attributes to an action: a counted incorrect answer, or a success matching `CORRECT_RE` ("Draft saved" is a success but not an attempt). Also `missed` concepts the extractor reads off graded results pages. |
| `struggle` / `selfCorrection` | A wrong working step that outlives the grace window (so half-typed lines don't count); then fixed with no hint in between. |
| `ask` + query extraction | The learner's own utterances run through the extractor with `kind: "query"`. |
| `offer` | Every proactive offer shown/accepted/declined, by kind. |
| `resource` | A tab the rabbit opened for a path suggestion, by modality. Settled as helped/not by the next graded attempt on that concept. |
| `plan` | A learning plan from `make_plan`. |

Snapshot stays `version: 1`: new state fields default to zero on parse and `profile` is optional, so existing persisted graphs load unchanged.

### Diagnostics are pure functions over the graph (`shared/src/diagnostics.ts`)

- **precision** = correct / attempts: when they commit an answer, is it right.
- **recall** = unaided first attempts after ≥ 6 h away that were right / such attempts. Precision without recall is cramming; the `fading` list is exactly that set.
- **retention** = mastery × exp(−days / stability); stability doubles per successful recall. Drives `dueForReview`.
- **curiosity** = asks, voluntary engagement, dwell and return days, with a 14-day half-life. Assigned exposure deliberately doesn't count.
- **help profile** = offer acceptance, share of unaided solves, self-corrections.
- **modality efficacy** = per resource kind, how often the next attempt was right.

Rates report `null` under an evidence floor instead of a noisy number. The same `diagnose()` output feeds the path consumer, a compact block in the agent prompt, and the parent view, so they can't disagree.

These are heuristics, not psychometrics. If they need to become principled, the event log shape already fits BKT/FSRS-style models; only `diagnostics.ts` changes.

### Step plans generalise the step judge (`shared/src/plan.ts`, `server/src/api/steps.ts`)

A `StepPlan` is an ordered list of moves whose titles say what to do, never what comes out. Planners sit behind one shape: deterministic for linear equations (zero latency, unchanged behaviour), the server LLM for anything else, a Pólya scaffold offline.

The judge generalises the same way. The local algebra judge still runs first at 350 ms with no model. Anything it can't parse goes to the server judge on a 1.6 s debounce, only for multi-line textarea working, single-flight, cached by working text. **Leak safety is structural**: `parseJudgement` keeps only step indices, booleans, a category enum and `planStep`, and copies each `line` from the student's own text, so no model-authored string can reach the student through a verdict.

Final answers the planner derives stay in the server process and feed only the existing hint leak filter, which now also matches worded answers.

Topic plans ("I want to learn about geology") use the same type with a concept and a lookup query per step, persist in the learner profile, and are walked by the path consumer across sessions.

### The path consumer acts (`shared/src/path.ts`)

Kinds, in priority order: `prerequisite`, `reconcile`, `revisit`, `plan`, `review`, `advance`, `explore`. Resource-backed suggestions carry a `ResourcePlan` (query + preferred modality, which becomes the modality that has actually worked once there's evidence) and a step-by-step playbook in the accept goal: `look_up` → `open_tab` → pick the lesson on the new page.

A recurring misconception escalates from `revisit` (Socratic) to `reconcile` (resource): if questions fixed it once and it came back, more questions aren't the answer.

Making chains actually complete needed two loop changes:

- **Cross-tab continuation.** `open_tab` with `done: false` hands the loop to the new tab: the background seeds the new tab's session with the pending loop and the conversation. `MAX_TOTAL_STEPS` bounds a chain across all hops.
- **Handoff survives document replacement.** The pending loop is now cleared when the resumed loop receives its first decision, not at content-script init. Sites that replace their document right after load (Khan Academy does) used to consume the handoff in a page that died before running it.

Suggestions are deduped across tabs and days through the profile (`RESUGGEST_MS`), ambient kinds (`plan`, `review`, `explore`) are rate-limited globally and suppressed right after a resource is opened, and the next plan step waits `PLAN_STEP_GAP_MS`.

### Plans are shown, not recited (`extension/src/components/PlanMap.tsx`)

Where plans live and how they surface:

| Plan | Stored | Progress comes from |
| --- | --- | --- |
| Topic plan ("learn about geology") | `profile.plans` in the persisted graph (cap 5), so it survives tabs, restarts and days, and travels to the parent view with the graph | Evidence: the step's resource was opened, or a correct attempt landed on its concept. Never from chat. |
| Problem plan (the question on screen) | Engine RAM, keyed by problem; reproducible from the server's plan cache. Only per-step outcomes persist, as attempts/struggles on the step's concept. | The step judge's `planStep`. |

A plan is a structure, so answering "what's my plan?" in chat is the wrong medium. The agent's `show_plan` action opens the **plan map** (same pattern as the chalkboard: store slot + component + action): the problem route with a "you are here" marker, then every learning plan with done/current/todo. `make_plan` opens it too, and it refreshes live off `Session.onRecord` and the engine's `onPlanProgress`. It is a control, not a readout: tapping a step runs `planStepSuggestion`, the same playbook the ambient "ready for step N?" offer uses. The prompt's learner block lists plan progress so the model knows what exists; the parent view renders the same plans from the carried graph.

Showing step titles is safe because titles name moves, never results — the same property that makes plans usable in hints.

## Consequences

- Extra model calls: one planner call per problem page with quiz UI (prefetched, so hints don't wait on it), judge calls only while multi-line working is being written, one extractor call per learner utterance. All degrade to deterministic behaviour with no server.
- `look_up` returns actual videos only with `YOUTUBE_API_KEY`; otherwise a search URL the agent clicks through after resuming on the new tab.
- A results page re-extracted under a new title/heading signature would double-count its `missed` concepts. Accepted for now; the fix is keying attempts by page URL.
- `KnowledgeGraph.merge` does not merge profiles. It has no production caller.
