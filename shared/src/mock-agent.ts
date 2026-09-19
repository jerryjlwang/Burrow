/**
 * Deterministic, rule-based agent used when no LLM is configured, when the LLM fails,
 * or when the extension cannot reach the server at all. It makes the demo scenarios
 * (navigation, pointing, clicking, summaries, progressive hints) work reliably offline.
 */
import { DECISION_DEFAULTS, type AgentDecision, type InterventionDecision } from "./schemas";
import type { AgentInput, InterventionInput, PageElement, PageSummary } from "./types";
import { extractTarget, findBestElement, findElements, isAffirmative, isNegative, isStopCommand, normalizeText, truncate } from "./text";
import { detectProblem, hintFor } from "./hints";

function d(partial: Partial<AgentDecision> & Pick<AgentDecision, "action">): AgentDecision {
  return { ...DECISION_DEFAULTS, reason: "mock-agent", ...partial };
}

const ROLE_WORD: Record<string, string> = {
  button: "button",
  link: "link",
  textbox: "box",
  searchbox: "search box",
  checkbox: "checkbox",
  radio: "option",
  combobox: "dropdown",
  tab: "tab",
  menuitem: "menu item",
  option: "option",
  switch: "switch",
  textarea: "text area",
  spinbutton: "number box",
};

export function roleWord(role: string): string {
  return ROLE_WORD[role] ?? "one";
}

const PRONOUN_RE = /^(it|that|this|that one|this one|there|the button|the link|the one you (showed|pointed)( me| at| to)?|the highlighted one)$/;

export function findAnswerInput(page: PageSummary): PageElement | null {
  const typeable = page.elements.filter((e) => ["textbox", "spinbutton", "textarea", "searchbox"].includes(e.role) && !e.sensitive);
  return (
    typeable.find((e) => /answer|response|solution|your/i.test(`${e.name} ${e.context ?? ""} ${e.placeholder ?? ""}`)) ??
    typeable.find((e) => e.inViewport) ??
    typeable[0] ??
    null
  );
}

export function pageSummarySpeech(page: PageSummary): { say: string; detail: string } {
  const title = page.title || "this page";
  const headings = page.headings.filter((h) => normalizeText(h) !== normalizeText(title)).slice(0, 3);
  const buttons = page.elements.filter((e) => e.role === "button");
  const links = page.elements.filter((e) => e.role === "link");
  const inputs = page.elements.filter((e) => ["textbox", "textarea", "searchbox", "spinbutton", "combobox"].includes(e.role));
  const parts: string[] = [];
  if (page.isPdf) parts.push(`This is a PDF, so I can't read its text directly.`);
  else parts.push(`This is ${truncate(title, 60)}.`);
  if (headings.length) parts.push(`It covers ${headings.map((h) => truncate(h, 40)).join(", ")}.`);
  if (page.errors.length) parts.push(`There's a message saying "${truncate(page.errors[0], 60)}".`);
  const main = [...buttons, ...links].filter((e) => e.inViewport).slice(0, 4).map((e) => truncate(e.name, 24));
  if (main.length) parts.push(`The main things you can do here: ${main.join(", ")}.`);
  if (inputs.length) parts.push(`There ${inputs.length === 1 ? "is one place" : `are ${inputs.length} places`} to type.`);
  const say = truncate(parts.join(" "), 320);
  const detail = [
    `**${title}**`,
    page.url,
    headings.length ? `Headings: ${page.headings.slice(0, 8).join(" · ")}` : "",
    page.textSummary ? truncate(page.textSummary, 700) : "",
    `Interactive: ${buttons.length} buttons, ${links.length} links, ${inputs.length} inputs.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { say, detail };
}

function hintDecision(input: AgentInput, opts: { fromOffer: boolean }): AgentDecision {
  const problem = detectProblem(input.page);
  const idx = input.student.hintsForCurrentProblem;
  const hint = hintFor(problem, idx, input.student);
  const target =
    (input.pendingOffer?.elementId != null && input.page.elements.find((e) => e.id === input.pendingOffer!.elementId)) ||
    findAnswerInput(input.page) ||
    null;
  const preface = opts.fromOffer ? "" : "";
  if (target) {
    return d({ action: "point_to", elementId: target.id, say: preface + hint, done: true, taskType: "learning", reason: "progressive hint" });
  }
  return d({ action: "speak", say: preface + hint, done: true, taskType: "learning", reason: "progressive hint" });
}

function resolveTarget(input: AgentInput, phrase: string, prefer: "clickable" | "typeable" | "any"): PageElement | null {
  const p = normalizeText(phrase);
  if (!p || PRONOUN_RE.test(p)) {
    if (input.lastReferencedElementId != null) {
      const el = input.page.elements.find((e) => e.id === input.lastReferencedElementId);
      if (el) return el;
    }
    return null;
  }
  const opts = prefer === "any" ? {} : { preferRoles: [prefer] };
  return findBestElement(input.page.elements, p, opts);
}

export function decideMock(input: AgentInput): AgentDecision {
  const utterance = input.utterance;
  const u = normalizeText(utterance);
  const page = input.page;
  const last = input.history[input.history.length - 1];

  // ---- Continuation steps (after an action was executed) ----
  if (input.step > 0 && last) {
    const a = last.decision.action;
    if (a === "click") {
      if (!last.result.ok) return d({ action: "finish", say: "Hmm, that didn't seem to work. Want me to try again?", done: true });
      if (last.result.urlChanged || input.resumedAfterNavigation) return d({ action: "finish", say: "It's open.", done: true, taskType: "navigation" });
      if (last.result.newErrors?.length) return d({ action: "finish", say: `It says: ${truncate(last.result.newErrors[0], 80)}`, done: true });
      return d({ action: "finish", say: last.result.changed ? "Done." : "I clicked it, but nothing seemed to change.", done: true });
    }
    if (a === "type") return d({ action: "finish", say: last.result.ok ? "Typed it in." : "I couldn't type there.", done: true });
    if (a === "navigate" || a === "go_back") return d({ action: "finish", say: "Here we are.", done: true, taskType: "navigation" });
    if (a === "select") return d({ action: "finish", say: last.result.ok ? "Selected." : "I couldn't select that.", done: true });
    if (a !== "observe") return d({ action: "finish", done: true });
  }

  // ---- Offers / confirmations ----
  if (input.pendingOffer) {
    if (isAffirmative(u)) {
      if (input.pendingOffer.type === "navigation" && input.pendingOffer.elementId != null) {
        return d({ action: "click", elementId: input.pendingOffer.elementId, say: "On it.", taskType: "navigation" });
      }
      return hintDecision(input, { fromOffer: true });
    }
    if (isNegative(u)) return d({ action: "finish", say: "Okay—I'm here if you need me.", done: true });
  }
  if (isStopCommand(u)) return d({ action: "finish", say: null, done: true });

  // ---- Greetings ----
  if (/^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening))( pip)?$/.test(u)) {
    return d({ action: "speak", say: "Hey! I'm here. Ask me where something is, or say 'what's on this page'.", done: true, taskType: "chat" });
  }

  // ---- Page description / accessibility ----
  if (/(what s on|what is on|whats on|describe|summari[sz]e|what can i do|what is this page|what s this page|whats this page|where am i|what am i looking at|read (me )?(this|the) page|tell me about this page)/.test(u)) {
    const s = pageSummarySpeech(page);
    return d({ action: "explain", say: s.say, text: s.detail, done: true, taskType: "accessibility" });
  }
  if (/^read (this|that|it|the (question|problem|selection|text))( (to me|aloud|out loud))?$/.test(u)) {
    const text = page.selection?.trim() || page.textSummary;
    if (!text) return d({ action: "speak", say: "I don't see any text to read here.", done: true, taskType: "accessibility" });
    return d({ action: "explain", say: truncate(text, 420), text: truncate(text, 2000), done: true, taskType: "accessibility" });
  }

  // ---- Learning: hints and coaching ----
  if (/(hint|help me|i m stuck|im stuck|stuck|i don t get|i dont get|don t understand|dont understand|how do i (solve|do|start|answer)|what do i do|explain (this|the question|the problem|it)|walk me through|nudge)/.test(u)) {
    return hintDecision(input, { fromOffer: false });
  }
  if (/(what s the answer|whats the answer|what is the answer|tell me the answer|just (tell|give) me|solve it|answer it for me|do it for me|give me the answer)/.test(u)) {
    const problem = detectProblem(page);
    const first = hintFor(problem, 0, input.student);
    const target = findAnswerInput(page);
    return d({
      action: target ? "point_to" : "speak",
      elementId: target?.id ?? null,
      say: `I'd rather help you get there yourself—it'll stick better. One step: ${first}`,
      done: true,
      taskType: "assessment",
    });
  }

  // ---- Typing ----
  const typeMatch = u.match(/^(?:please )?(?:type|enter|put|write|fill in|fill)\s+(.+?)\s+(?:in|into|in the|on|onto|to)\s+(?:the |my )?(.+)$/);
  if (typeMatch) {
    const [, text, fieldPhrase] = typeMatch;
    const field = resolveTarget(input, fieldPhrase, "typeable");
    if (!field) return d({ action: "speak", say: `I don't see a "${truncate(fieldPhrase, 30)}" field on this page.`, done: true, taskType: "administrative" });
    if (field.sensitive) return d({ action: "point_to", elementId: field.id, say: "That's a private field—please type that one yourself.", done: true, taskType: "administrative" });
    return d({ action: "type", elementId: field.id, text: text.trim(), say: "Sure.", taskType: "administrative" });
  }
  const typeShort = u.match(/^(?:please )?(?:type|enter|write)\s+(.+)$/);
  if (typeShort) {
    const field =
      (input.lastReferencedElementId != null && page.elements.find((e) => e.id === input.lastReferencedElementId && ["textbox", "textarea", "searchbox", "spinbutton"].includes(e.role))) ||
      findAnswerInput(page);
    if (!field) return d({ action: "speak", say: "Which box should I type that into?", done: true });
    if (field.sensitive) return d({ action: "point_to", elementId: field.id, say: "That's a private field—please type that one yourself.", done: true });
    return d({ action: "type", elementId: field.id, text: typeShort[1].trim(), say: "Sure.", taskType: "administrative" });
  }

  // ---- Scrolling / back ----
  if (/^(scroll|go|page|move)( (down|up))?( (a bit|a little|more|further))?$/.test(u) || /(scroll|page) (down|up)/.test(u)) {
    const dir = /up/.test(u) ? "up" : "down";
    const big = /(top|bottom|all the way|end)/.test(u);
    return d({ action: "scroll", direction: dir, amount: big ? 100000 : 600, done: true, taskType: "accessibility" });
  }
  if (/^(go|take me|head) back$/.test(u) || /^back$/.test(u)) return d({ action: "go_back", say: "Going back.", taskType: "navigation" });

  // ---- Clicking / navigating ----
  const wantsClick = /^(?:please |pip |ok |okay |yeah |yes |can you |could you |would you )*(click|press|tap|hit|open|select|choose|check|tick|pick|go to|take me to|navigate to|bring me to|start|launch|submit|turn in|send)\b/.test(u);
  if (wantsClick) {
    const urlMatch = utterance.match(/((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i);
    const target = extractTarget(utterance);
    const el = resolveTarget(input, target, "clickable");
    if (el) {
      if (el.disabled) return d({ action: "point_to", elementId: el.id, say: `That ${roleWord(el.role)} is disabled right now—there's probably something to fill in first.`, done: true });
      const isNav = el.role === "link" || /^(go to|take me to|navigate to|bring me to|open)/.test(u);
      return d({ action: "click", elementId: el.id, say: isNav ? "On it." : "Yep.", taskType: isNav ? "navigation" : "administrative" });
    }
    if (urlMatch && !/\s/.test(urlMatch[1]) && /^(go to|take me to|navigate to|open)/.test(u)) {
      const url = urlMatch[1].startsWith("http") ? urlMatch[1] : `https://${urlMatch[1]}`;
      return d({ action: "navigate", url, say: "Heading there.", taskType: "navigation" });
    }
    if (!target || PRONOUN_RE.test(target)) return d({ action: "speak", say: "Which one? Tell me what it's called, or ask me to find it first.", done: true });
    const near = findElements(page.elements, target, { minScore: 0.3 })[0];
    if (near) return d({ action: "point_to", elementId: near.element.id, say: `I don't see exactly that, but there's "${truncate(near.element.name, 30)}" here. Want me to click it?`, done: true });
    return d({ action: "speak", say: `I don't see a "${truncate(target, 30)}" on this page.`, done: true });
  }

  // ---- Pointing / finding ----
  const wantsFind = /(where|find|show me|which (one|button|link)|point (to|at)|highlight|locate|how do i (get to|find|open|submit)|where do i)/.test(u);
  if (wantsFind) {
    const target = extractTarget(utterance);
    if (!target) return d({ action: "speak", say: "What are you looking for?", done: true });
    const el = resolveTarget(input, target, "any");
    if (el) {
      const say = el.inViewport ? `I see it—it's this ${roleWord(el.role)} right here.` : `It's a little further down—here.`;
      return d({ action: "point_to", elementId: el.id, say, done: true, taskType: "navigation" });
    }
    return d({ action: "speak", say: `I don't see anything like "${truncate(target, 30)}" on this page. Want me to describe what's here?`, done: true, taskType: "navigation" });
  }

  // ---- Yes/no without context ----
  if (isAffirmative(u)) return d({ action: "speak", say: "Okay! What would you like me to do?", done: true });
  if (isNegative(u)) return d({ action: "finish", say: "Okay.", done: true });

  // ---- Fallback (offline brain) ----
  return d({
    action: "speak",
    say: "I'm running in offline mode, so I can find things on the page, click them, or give hints—but I can't answer that one right now.",
    done: true,
    taskType: "chat",
  });
}

/** Rule-based proactive decision. `level` is computed by the client; we decide message + target. */
export function interveneMock(input: InterventionInput): InterventionDecision {
  const { signals, page, student } = input;
  const none: InterventionDecision = { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "no strong signal" };
  const answer = findAnswerInput(page);

  if (signals.incorrectAttempts >= 2) {
    const n = student.hintsForCurrentProblem;
    const message =
      n === 0 ? "Looks like this one's being stubborn. Want a hint?" : n === 1 ? "Still tricky? I can break it into one smaller step." : "Want to try a similar, easier one together?";
    return { intervene: true, confidence: Math.min(0.95, 0.7 + 0.1 * signals.incorrectAttempts), type: "hint", message, elementId: answer?.id ?? null, reason: "repeated incorrect attempts" };
  }
  if (signals.failedUiAction || signals.repeatedClicks >= 3) {
    const clicked = signals.lastClickedName ? findElements(page.elements, signals.lastClickedName, { minScore: 0.6 })[0]?.element : undefined;
    if (clicked?.disabled) {
      const need = page.elements.find((e) => (e.role === "radio" || e.role === "checkbox") && !e.checked) ?? page.elements.find((e) => ["textbox", "textarea"].includes(e.role) && !e.value);
      return {
        intervene: true,
        confidence: 0.85,
        type: "navigation",
        message: need ? "That one unlocks once you answer—these options right here." : "That button's disabled for now—there's probably something to fill in first.",
        elementId: need?.id ?? clicked.id,
        reason: "repeated clicks on a disabled control",
      };
    }
    const alt = signals.lastClickedName ? findElements(page.elements, signals.lastClickedName, { minScore: 0.4 }).find((m) => m.element.id !== clicked?.id && !m.element.disabled) : undefined;
    return {
      intervene: true,
      confidence: 0.7,
      type: "navigation",
      message: alt ? "I think the button you're looking for is over here." : "That doesn't seem to be doing anything. Want me to take a look?",
      elementId: alt?.element.id ?? null,
      reason: "repeated clicks without progress",
    };
  }
  if (signals.validationErrors >= 2) {
    return { intervene: true, confidence: 0.7, type: "nudge", message: "That form's fighting you. Want me to show you what it needs?", elementId: null, reason: "validation errors" };
  }
  if (signals.deadEnd) {
    return { intervene: true, confidence: 0.75, type: "navigation", message: "Looks like a dead end. Want me to take you back?", elementId: null, reason: "error page" };
  }
  if (signals.navigationOscillation) {
    return { intervene: true, confidence: 0.6, type: "navigation", message: "Going back and forth? Tell me what you're looking for and I'll find it.", elementId: null, reason: "backtracking" };
  }
  if (signals.timeOnCurrentProblemMs > 90_000 && page.hasQuizUi) {
    return { intervene: true, confidence: 0.55, type: "nudge", message: "Need a hand with this one? I can give a small nudge.", elementId: answer?.id ?? null, reason: "hesitation on a problem" };
  }
  return none;
}
