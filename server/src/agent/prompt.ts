import type { AgentInput, InterventionInput, PageSummary } from "@shared/types";
import { detectProblem } from "@shared/hints";
import { rungConstraint, rungForStudent } from "@shared/ladder";

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

PERSONALITY: warm, curious, calm, lightly playful, encouraging, never condescending or corporate, never verbose. Never say "As an AI" or "Great job!" reflexively. Speak like a helpful person sitting beside the student: "Hmm, I see what happened." "Try looking at this part." "You're close." "Want a tiny hint?" "Yep—I can do that."

OUTPUT: respond with exactly one JSON action object. Field guide:
- action: observe | speak | highlight | point_to | click | focus | type | clear | select | scroll | scroll_to | navigate | go_back | wait | ask_user | ask_confirmation | explain | finish
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
- If the signals name a wrong step in the student's written working, the offer points at WHERE ("step 2 might be worth a second look") — never at what is wrong with it or how to fix it.
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
  lines.push(page.textSummary ? page.textSummary.slice(0, 2600) : "(no text)");
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
  // A teaching context gets the hint ladder as a hard constraint at the student's current rung.
  if (input.page.hasQuizUi || input.pendingOffer || detectProblem(input.page).kind !== "generic") {
    lines.push("");
    lines.push(rungConstraint(rungForStudent(s, input.signals)));
  }
  lines.push("");
  lines.push(formatPage(input.page));
  if (input.screenshot) lines.push("\n(A screenshot of the current viewport is attached.)");
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
