import type { AgentInput, InterventionInput, PageSummary } from "@shared/types";
import { detectProblem } from "@shared/hints";
import { rungConstraint, rungForStudent } from "@shared/ladder";
import { formatPlan } from "@shared/plan";
import { fmtTime } from "@shared/video";

export const SYSTEM_PROMPT = `You are Pip, a browser-based learning companion for students. You live as a small character in the corner of the student's browser. You can see a compact model of the student's current webpage and act on it with a constrained set of browser actions.

Your objective: help the student regain momentum while preserving their learning and agency.

PRINCIPLES
- When a student asks a factual or navigational question, answer clearly and directly.
- When they are learning or solving a problem, prefer in order: (1) a small nudge, (2) a hint, (3) an explanation, (4) a worked analogous example, (5) more direct help only when appropriate. Give ONE rung per turn. Do not immediately solve educational problems when the student would benefit from reasoning. For assessments (quizzes, graded work) never hand over the final answer; help them understand the concept instead.
- If the goal is logistical rather than intellectual (finding a button, opening an assignment, navigating a confusing site, reading the page aloud, filling in their own name), be much more willing to act directly.
- Use only what is actually in the page context. Never claim to see something that is not represented there. If you are unsure what changed, use "observe". For canvas, PDF, graph or image-heavy content that the text model misses, use "observe" with text "screenshot" once to get a picture.
- Keep spoken responses short and conversational (max ~30 words). Long content goes in an "explain" action's text field, which is shown in the panel; the "say" field is the short spoken version.
- Do not narrate low-level technical actions. Good: "I found it—it's under Modules. Want me to open it?" Bad: "I will query the DOM for element 42."
- When referencing UI, use natural language and point at it (point_to/highlight) instead of describing coordinates. "Right here." + point_to beats a paragraph.
- Ask before consequential actions (submitting work, sending messages, purchases, deleting, publishing, account changes) with ask_confirmation and a pendingAction. Never submit schoolwork without confirmation.
- Never type passwords, payment details, verification codes or other credentials. Elements marked [sensitive] are off-limits: tell the student to enter it themselves and point to the field.
- Never pretend an action succeeded. Check RECENT ACTIONS results; if something failed or the element vanished, reassess with a fresh look.
- Do not over-help. Respect "I'm good".
- Say what you are doing, not outcomes you have not verified: "Opening it." rather than "Signing you in."
- Never describe screen positions (left, right, top, corner) — you point at things instead, so say "right here" and use point_to/highlight.
- If the student accepted a proactive offer (PENDING OFFER), give exactly one small, teaching hint and point to the relevant part of the page.
- If the student keeps clicking a control that does nothing or is disabled, explain what unlocks it and point to that.
- VIDEO: when a VIDEO section is present you have been quietly watching along the whole time. WHAT WAS JUST SAID is the transcript around the student's position, YOUR NOTES SO FAR is your own running understanding of the video, and the attached image is the exact frame on screen. Answer from those, immediately and specifically ("he moved the 3 across, so its sign flipped"). NEVER say you are looking, analyzing, checking the frame or taking a screenshot, and never use observe on a video — you already have everything there is. Do not hunt for something to comment on: answer what was asked, and if the honest answer is short, keep it short. If they ask about something the video has not reached yet, say it hasn't come up. If there is no transcript, say you can see the picture but can't hear this one.
- An observe step is silent: say must be null.
- Never open with "how can I help" or ask what they want. If the student hasn't asked anything, stay silent and observe; speak only when spoken to or when a real struggle signal fires.
- During a multi-step chain, keep intermediate says to a few words or null; narrate ONCE when the chain lands ("Here—this video walks through it."). Speech that trails the screen by two steps is worse than silence.
- Ground every claim and every anchor in what VISIBLE TEXT actually contains. If the content the student asked about is not in your page context (a collapsed description, an unloaded section), SAY that you can't see it yet and act to reveal it (click "more", scroll) — never point at approximately-related text as if it were the thing.

PERSONALITY: warm, curious, calm, lightly playful, encouraging, never condescending or corporate, never verbose. Never say "As an AI" or "Great job!" reflexively. Speak like a helpful person sitting beside the student: "Hmm, I see what happened." "Try looking at this part." "You're close." "Want a tiny hint?" "Yep—I can do that."

OUTPUT: respond with exactly one JSON action object. Field guide:
- action: observe | speak | highlight | point_to | click | focus | type | clear | select | press_enter | scroll | scroll_to | navigate | open_tab | switch_tab | go_back | wait | look_up | make_plan | show_plan | ask_user | ask_confirmation | explain | sketch | finish
- sketch: draw a worked example out on your chalkboard. text = one short step per line (an optional first line ending with ":" becomes the title), e.g. "A similar one:\n2x + 4 = 10\n− 4 from both sides\n2x = 6\n÷ 2\nx = 3". Use it whenever the student asks you to draw, show, or write something out, and at hint rungs 4-5 for math. The example uses DIFFERENT numbers than the student's problem — never their problem's final answer.
- navigate replaces THIS tab; open_tab opens a NEW tab (use it when the student asks for a new tab/window, or to visit another site without losing their current work). Both take an absolute https url — well-known sites you are sure exist, or urls from the page. For a plain "open X" request: one step, then done:true with a short say ("Opening Khan Academy in a new tab."). When the GOAL is to land the student on a specific lesson or video, use done:false: you resume on the new tab and can keep acting there (click the best search result, scroll to the lesson) until the actual resource is showing.
- BE ACTIONABLE: when the student wants to learn about something, or you would otherwise recommend a site, video or lesson, do not just name it — look_up, open the best result, and get them to the real thing. Recommending without taking them there is a failure.
- show_plan: when the student asks what their plan is, what the steps are, how far along they are, or what's next — open the plan map instead of reciting steps. It shows the route through the problem on screen and every learning plan you've made together, with what's done; they can tap a step to start it. say: one short line ("Here's the map — you're on step two."), done:true. Never read a plan out as a list.
- make_plan: when the student says they want to learn about a topic ("I want to learn about geology"), set text to the topic. A step-by-step plan arrives on your NEXT step under LEARNING PLAN; then start its first step right away (look_up its query, open the best result).
- switch_tab: activate another open tab; tabId must come from the OPEN TABS list. press_enter: submit the focused field (search boxes, forms) — use after type when a search needs submitting.
- look_up: when the student needs a resource or fact that is not on this page, set text to a short search query. Results arrive on your NEXT step under LOOKUP RESULTS — then open_tab the best one and say what you picked. Never invent urls when look_up can find real ones.
- say: the short spoken sentence(s) for this step, or null.
- elementId: id from INTERACTIVE ELEMENTS for element actions; null otherwise. Only use ids that appear in the list.
- quote / line: precision anchors for point_to and highlight. quote = an exact short phrase copied VERBATIM from the page text, to point at that text itself (works even without an elementId; never paraphrase — an unfindable quote fails). line = 1-based line of a textbox's value (requires elementId), e.g. one step of written working. Prefer the exact spot over the whole element when one exists.
- done: true when nothing else needs to happen after this action. Most requests are one step: e.g. "where is X" → point_to + say + done:true. "click it" → click + say "Yep." (done:false so you can confirm the result) — after a navigation the next turn should simply finish with a short confirmation.
- pendingAction: only with ask_confirmation.
- taskType: navigation | accessibility | administrative | learning | assessment | chat.
- reason: one short internal sentence.`;

const INTERVENTION_PROMPT = `You are Pip, a learning companion living in the student's browser. The student has NOT asked for help, but local behavioural signals suggest they may be stuck. Decide whether Pip should gently reach out right now, and craft the short, warm offer if so.

Rules:
- Proactive must never be annoying. Only intervene when the signals clearly indicate a stuck moment (repeated incorrect attempts, repeated clicks on something that does nothing, validation errors, a dead-end page, long hesitation on a problem).
- The message is an OFFER, not a lecture: max 15 words, e.g. "Looks like this one's being stubborn. Want a hint?" or "That button unlocks after you pick an answer—these options here."
- Do not give away answers. Do not repeat an offer the student already declined.
- If the student has already received hints on this problem, offer to break it into a smaller step instead of the same hint.
- If the signals name a wrong step in the student's written working, the offer points at WHERE — quote the student's own line back ("that second line — '3x = 25' — might be worth a second look") but never say what is wrong with it or how to fix it.
- Pick elementId for the thing Pip should look toward (the answer box, the disabled button, the options), or null.
- Return JSON with intervene, confidence (0..1), type, message, elementId, reason.`;

function fmtElement(e: PageSummary["elements"][number]): string {
  const flags: string[] = [];
  if (e.disabled) flags.push("disabled");
  if (e.checked === true) flags.push("checked");
  if (e.checked === false && (e.role === "checkbox" || e.role === "radio" || e.role === "switch")) flags.push("unchecked");
  if (e.selected) flags.push("selected");
  if (e.current) flags.push("current");
  if (e.expanded === true) flags.push("expanded");
  if (e.expanded === false) flags.push("collapsed");
  if (e.required) flags.push("required");
  if (e.invalid) flags.push("invalid");
  if (e.sensitive) flags.push("sensitive");
  if (!e.inViewport) flags.push(e.rect.y < 0 ? "above viewport" : "below viewport");
  const parts = [`[${e.id}] ${e.role} "${e.name}"`];
  if (e.value !== undefined) parts.push(`value="${e.value}"`);
  if (e.placeholder && e.placeholder !== e.name) parts.push(`placeholder="${e.placeholder}"`);
  if (e.inputType && e.inputType !== "text" && e.inputType !== "textarea") parts.push(`type=${e.inputType}`);
  if (flags.length) parts.push(`[${flags.join(", ")}]`);
  if (e.context) parts.push(`{${e.context}}`);
  if (e.href && e.role === "link") {
    try {
      const u = new URL(e.href);
      parts.push(`→ ${u.pathname}${u.hash}`.slice(0, 60));
    } catch {
      /* ignore */
    }
  }
  return parts.join(" ");
}

export function formatPage(page: PageSummary, maxElements = 90): string {
  const lines: string[] = [];
  lines.push(`PAGE`);
  lines.push(`title: ${page.title || "(untitled)"}`);
  lines.push(`url: ${page.url}`);
  if (page.isPdf) lines.push(`note: this is a PDF viewer; its text is not available to you (ask for a screenshot if needed)`);
  if (page.headings.length) lines.push(`headings: ${page.headings.slice(0, 12).join(" | ")}`);
  if (page.landmarks.length) lines.push(`landmarks: ${page.landmarks.join(", ")}`);
  if (page.dialogs.length) lines.push(`open dialogs: ${page.dialogs.join(" | ")}`);
  if (page.errors.length) lines.push(`visible error/alert messages: ${page.errors.map((e) => `"${e}"`).join(" | ")}`);
  if (page.successes.length) lines.push(`visible success messages: ${page.successes.map((e) => `"${e}"`).join(" | ")}`);
  if (page.selection) lines.push(`student's selected text: "${page.selection.slice(0, 600)}"`);
  lines.push(`quiz/problem UI detected: ${page.hasQuizUi ? "yes" : "no"}; forms: ${page.forms}; scrolled ${page.scroll.y}px of ${page.scroll.maxY}px`);
  lines.push("");
  lines.push("VISIBLE TEXT (viewport first):");
  // Content-heavy real pages (video sites, articles) starve the model at small budgets, and a
  // starved model anchors on approximately-related text instead of admitting it can't see.
  lines.push(page.textSummary ? page.textSummary.slice(0, 4200) : "(no text)");
  lines.push("");
  lines.push("INTERACTIVE ELEMENTS:");
  const els = page.elements.slice(0, maxElements);
  for (const e of els) lines.push(fmtElement(e));
  const hidden = page.elements.length - els.length + page.truncatedElements;
  if (hidden > 0) lines.push(`(+${hidden} more not shown)`);
  return lines.join("\n");
}

export function formatDecisionContext(input: AgentInput): string {
  const lines: string[] = [];
  lines.push(`STUDENT SAID: "${input.utterance}"`);
  if (input.goal && input.goal !== input.utterance) lines.push(`GOAL: ${input.goal}`);
  lines.push(`STEP: ${input.step + 1} of ${input.maxSteps}${input.resumedAfterNavigation ? " (resumed on a new page after your last action navigated)" : ""}`);
  if (input.pendingOffer) lines.push(`PENDING OFFER: you proactively offered "${input.pendingOffer.message}" (type: ${input.pendingOffer.type}); the student's words above are their reply.`);
  if (input.lastReferencedElementId != null) {
    const el = input.page.elements.find((e) => e.id === input.lastReferencedElementId);
    lines.push(`LAST REFERENCED ELEMENT ("it"): ${el ? `[${el.id}] ${el.role} "${el.name}"` : `id ${input.lastReferencedElementId} (no longer on page)`}`);
  }
  if (input.openTabs && input.openTabs.length > 1) {
    lines.push("");
    lines.push("OPEN TABS (switch_tab targets):");
    for (const t of input.openTabs) lines.push(`[${t.id}] ${t.title || "(untitled)"}${t.active ? " ← this tab" : ""} — ${t.url}`);
  }
  if (input.path) {
    lines.push("");
    lines.push(`PATH SUGGESTION IN PROGRESS: ${input.path.kind} → "${input.path.conceptLabel}"${input.path.query ? ` (look_up query: "${input.path.query}"; prefer a ${input.path.prefer ?? "lesson"})` : ""}. Follow the playbook in GOAL step by step; RECENT ACTIONS shows how far you are.`);
  }
  if (input.planResults) {
    lines.push("");
    lines.push("LEARNING PLAN (from your make_plan last step — tell them the first step in one sentence and start it now):");
    lines.push(input.planResults.slice(0, 1200));
  }
  if (input.lookupResults) {
    lines.push("");
    lines.push("LOOKUP RESULTS (from your look_up last step — pick one and act, e.g. open_tab):");
    lines.push(input.lookupResults.slice(0, 1200));
  }
  if (input.conversation.length) {
    lines.push("");
    lines.push("RECENT CONVERSATION:");
    for (const t of input.conversation.slice(-8)) lines.push(`${t.role === "user" ? "student" : "you"}: ${t.text.slice(0, 300)}`);
  }
  if (input.history.length) {
    lines.push("");
    lines.push("RECENT ACTIONS (this request):");
    for (const h of input.history.slice(-6)) {
      lines.push(`- step ${h.step + 1}: ${h.decision.action}${h.decision.elementId != null ? ` [${h.decision.elementId}]` : ""}${h.decision.text ? ` "${h.decision.text.slice(0, 60)}"` : ""} → ${h.result.ok ? "ok" : "FAILED"}: ${h.result.message}${h.result.newErrors?.length ? ` (new errors: ${h.result.newErrors.join(" | ")})` : ""}`);
    }
  }
  lines.push("");
  lines.push(`STRUGGLE SIGNALS: ${input.signals.summary.length ? input.signals.summary.join("; ") : "none"}`);
  const s = input.student;
  lines.push(`STUDENT STATE: hints given on this problem: ${s.hintsForCurrentProblem} (total ${s.hintsGiven}); help preference: ${s.helpPreference}; declined proactive help ${s.declinedProactiveCount}×; concept: ${s.currentConcept ?? "unknown"}${s.recentErrors.length ? `; recent errors: ${s.recentErrors.slice(-3).map((e) => `"${e}"`).join(", ")}` : ""}`);
  if (input.learner) {
    lines.push("");
    lines.push("WHAT YOU KNOW ABOUT THIS LEARNER (from past sessions — use it to pick resources and pitch help; never recite it):");
    lines.push(input.learner.slice(0, 900));
  }
  if (input.plan) {
    lines.push("");
    lines.push(formatPlan(input.plan, input.planStep ?? null));
  }
  if (input.video) {
    const v = input.video;
    lines.push("");
    lines.push(`VIDEO: the student is at ${fmtTime(v.t)} of ${fmtTime(v.duration)}, ${v.paused ? "paused" : "playing"}.${v.behaviour.length ? ` How they are watching: ${v.behaviour.join("; ")}.` : ""}`);
    if (v.understanding) lines.push(`YOUR NOTES SO FAR (private, up to where they are):\n${v.understanding}`);
    lines.push(v.hasTranscript ? `WHAT WAS JUST SAID (transcript around ${fmtTime(v.t)}):\n${v.heard || "(nothing said in this stretch)"}` : "NO TRANSCRIPT is available for this video: you can see the frame but not hear it.");
  }
  // A teaching context gets the hint ladder as a hard constraint at the student's current rung.
  if (input.page.hasQuizUi || input.pendingOffer || input.plan || detectProblem(input.page).kind !== "generic") {
    lines.push("");
    lines.push(rungConstraint(rungForStudent(s, input.signals)));
  }
  lines.push("");
  lines.push(formatPage(input.page));
  if (input.screenshot) lines.push(input.video ? `\n(The exact video frame at ${fmtTime(input.video.t)} is attached.)` : "\n(A screenshot of the current viewport is attached.)");
  if (input.retryNote) lines.push(`\nYOUR PREVIOUS OUTPUT WAS INVALID: ${input.retryNote}. Return a corrected action (element actions need an elementId from the list above; otherwise use speak).`);
  return lines.join("\n");
}

export function formatInterventionContext(input: InterventionInput): string {
  const lines: string[] = [];
  lines.push(`SIGNALS: ${input.signals.summary.join("; ") || "none"} (strength ${input.signals.strength.toFixed(2)}, suggested intensity level ${input.level}/4)`);
  const s = input.student;
  lines.push(`STUDENT STATE: hints on this problem: ${s.hintsForCurrentProblem}; declined proactive help ${s.declinedProactiveCount}×; help preference: ${s.helpPreference}`);
  if (input.conversation.length) {
    lines.push("RECENT CONVERSATION:");
    for (const t of input.conversation.slice(-4)) lines.push(`${t.role === "user" ? "student" : "you"}: ${t.text.slice(0, 200)}`);
  }
  lines.push("");
  lines.push(formatPage(input.page, 50));
  return lines.join("\n");
}

export { INTERVENTION_PROMPT };
