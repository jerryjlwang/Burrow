/**
 * Deterministic, rule-based agent used when no LLM is configured, when the LLM fails,
 * or when the extension cannot reach the server at all. It makes the demo scenarios
 * (navigation, pointing, clicking, summaries, progressive hints) work reliably offline.
 */
import { DECISION_DEFAULTS, type AgentDecision, type InterventionDecision } from "./actions";
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
    // A step-judge signal points at the exact wrong line of the working, not just the box.
    const line = input.signals.wrongStep && (target.value ?? "").includes("=") ? input.signals.wrongStep.step : null;
    const lineText = line ? (target.value ?? "").split("\n")[line - 1]?.trim() : undefined;
    const say = line ? `Right here${lineText ? ` — “${truncate(lineText, 40)}”` : ""}. What did that move do to both sides?` : preface + hint;
    return d({ action: "point_to", elementId: target.id, line, say, done: true, taskType: "learning", reason: line ? "point at the wrong step" : "progressive hint" });
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

/** Pick a line from formatted LOOKUP RESULTS ("1. [video] Title — https://…"), preferring a modality. */
export function pickLookupResult(results: string, prefer?: string): { title: string; url: string } | null {
  const parsed = results
    .split("\n")
    .map((line) => line.match(/^\d+\.\s*(?:\[(\w+)\]\s*)?(.+?) — (https?:\/\/\S+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ kind: m[1] ?? "", title: m[2], url: m[3] }));
  return parsed.find((r) => prefer && r.kind === prefer) ?? parsed[0] ?? null;
}

/** Runs a resource-backed path suggestion's playbook: look_up, then open the best result. */
function pathDecision(input: AgentInput): AgentDecision | null {
  const path = input.path;
  if (!path?.query) return null;
  const lookedUp = input.history.find((h) => h.decision.action === "look_up");
  if (!lookedUp) {
    return d({ action: "look_up", text: path.query, say: `Let me find something good on ${truncate(path.conceptLabel, 40)}.`, taskType: "learning", reason: "path playbook: look up a resource" });
  }
  // Resumed on the tab it opened: the offline brain can't vet a results page, so it hands over.
  if (input.history.some((h) => h.decision.action === "open_tab")) return d({ action: "finish", say: "Here we are. Pick the one that looks best, and tell me what you notice.", done: true, taskType: "learning" });
  const pick = lookedUp.result.ok && input.lookupResults ? pickLookupResult(input.lookupResults, path.prefer) : null;
  if (!pick) return d({ action: "speak", say: "I couldn't find a good one just now. Want to try again in a bit?", done: true, taskType: "learning" });
  return d({ action: "open_tab", url: pick.url, say: `This one looks right for ${truncate(path.conceptLabel, 40)}. Opening it.`, done: false, taskType: "learning", reason: "path playbook: open the chosen resource" });
}

const LEARN_GOAL_RE = /\b(?:i (?:want|wanna|would like|d like) to|help me|teach me|let s|lets|can we)\s+(?:learn|study|understand|know)?\s*(?:more\s+)?(?:about\s+)?(.{3,80})$/;

export function decideMock(input: AgentInput): AgentDecision {
  const utterance = input.utterance;
  const u = normalizeText(utterance);
  const page = input.page;
  const last = input.history[input.history.length - 1];

  const pathStep = pathDecision(input);
  if (pathStep) return pathStep;

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
    if (a === "make_plan") return d({ action: "finish", say: last.result.ok ? "I made us a plan. Want to start with the first step?" : "I couldn't plan that one right now.", done: true, taskType: "learning" });
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

  // ---- Working the player: pause, play, jump, speed — and finding a part of the video by what is said in it ----
  if (input.video && input.step === 0) {
    const control = (value: string, text: string | null, say: string) => d({ action: "video", value, text, say, done: true, taskType: "navigation", reason: "player control asked for" });
    const stamp = utterance.match(/\b(\d{1,3}:\d{2}(?::\d{2})?)\b/)?.[1];
    if (/\b(skip|jump|go|take me) (ahead |back |forward )?to\b/.test(u) && stamp) return control("seek", stamp, `Jumping to ${stamp}.`);
    const about = u.match(/\b(?:skip|jump|go|take me) to (?:where|the (?:part|bit)) (?:he|she|they|it)?\s*(?:talks? about|explains?|about|on|shows?|says?)?\s*(.+)$/)?.[1];
    if (about) {
      const words = about.split(" ").filter((w) => w.length > 3);
      const line = input.video.transcript.split("\n").find((l) => words.length > 0 && words.every((w) => normalizeText(l).includes(w)));
      const at = line?.match(/^\[([\d:]+)\]/)?.[1];
      return at ? control("seek", at, `That's at ${at}. Jumping there.`) : d({ action: "speak", say: "I couldn't find that part in this video.", done: true, taskType: "learning" });
    }
    if (/\b(go|skip|jump) back\b|\brewind\b/.test(u)) return control("seek", "-10", "Back ten seconds.");
    if (/\b(go|skip|jump) (forward|ahead)\b/.test(u)) return control("seek", "+10", "Ahead ten seconds.");
    if (/\bslow(er| (it |this )?down)\b/.test(u)) return control("speed", "0.75", "Slowing it down.");
    if (/\bnormal speed\b/.test(u)) return control("speed", "1", "Back to normal speed.");
    if (/^(please |can you |could you )?(play|resume|unpause)\b|\bkeep (going|playing)\b/.test(u)) return control("play", null, "Playing.");
  }

  // ---- Watching a video: answer from what was just said — never "let me look at the frame" ----
  if (input.video && input.step === 0 && /\b(video|he|she|just (said|say|did)|mean|explain|don t (get|understand)|didn t (get|understand)|say that again|what did)\b/.test(u)) {
    if (!input.video.hasTranscript) return d({ action: "speak", say: "I can see the picture, but I can't hear this one.", done: true, taskType: "learning", reason: "video without transcript" });
    const sentences = input.video.heard.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 8);
    const lastSaid = sentences[sentences.length - 1];
    return d({ action: "speak", say: lastSaid ? `The bit just now: "${truncate(lastSaid.trim(), 140)}" Want me to break that down?` : "Nothing's been said in this part yet.", done: true, taskType: "learning", reason: "video question answered from the transcript" });
  }

  // ---- "I want to learn about X" → a learning plan the path consumer then walks ----
  const learnGoal = /\b(learn|study|teach me|understand more)\b/.test(u) ? u.match(LEARN_GOAL_RE) : null;
  if (learnGoal && input.step === 0) {
    return d({ action: "make_plan", text: learnGoal[1].trim(), say: "Ooh, let's map that out.", taskType: "learning", reason: "learning goal → plan" });
  }

  // ---- "What's my plan?" → show it, don't recite it ----
  if (/\b(plans?|steps)\b/.test(u) && /(what s|whats|what is|what are|show|see|open|where am i|how far|what s next|whats next)/.test(u) && /\b(my|our|the|we)\b/.test(u)) {
    return d({ action: "show_plan", say: "Here's the map.", done: true, taskType: "learning", reason: "plans are shown, not recited" });
  }

  // ---- Greetings ----
  if (/^(hi|hello|hey|yo|hiya|good (morning|afternoon|evening))( pip)?$/.test(u)) {
    return d({ action: "speak", say: "Hey! I'm here. Ask me where something is, or say 'what's on this page'.", done: true, taskType: "chat" });
  }

  // ---- Region reading: observe with a target, then answer from the full text ----
  const region = /\b(?:read|check|look at|what does|what do|tell me about|tell me what)\b.*\b(description|instructions|directions|details|summary|caption|fine print)\b/.exec(u);
  if (region) {
    if (input.readout) {
      // The readout's first line is its label; the body is the region's full text.
      const body = input.readout.slice(input.readout.indexOf("\n") + 1).trim();
      return d({ action: "explain", say: `Here's what it says: ${truncate(body, 240)}`, text: truncate(body, 2000), done: true, taskType: "accessibility", reason: "answer from region readout" });
    }
    if (last?.decision.action === "observe") return d({ action: "speak", say: `I don't see a ${region[1]} on this page.`, done: true, taskType: "accessibility" });
    return d({ action: "observe", quote: region[1], done: false, taskType: "accessibility", reason: "read the region in full" });
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
    // "the answer box" should match a field named "Your answer": drop UI furniture words and retry.
    const bare = fieldPhrase.replace(/\b(box|field|input|bar|area)\b/g, " ").replace(/\s+/g, " ").trim();
    const field = resolveTarget(input, fieldPhrase, "typeable") ?? (bare && bare !== fieldPhrase ? resolveTarget(input, bare, "typeable") : null);
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
  // ---- Sketch: draw a worked example or a diagram, extend it, erase from it, or wrap it onto the page ----
  if (/\b(erase|clear|remove|wipe|get rid of|delete)\b/.test(u) && (input.board || /\b(drawing|sketch|board|diagram|picture)\b/.test(u))) {
    if (!input.board) return d({ action: "speak", say: "There's nothing drawn right now.", done: true, taskType: "chat", reason: "nothing to erase" });
    // A named kind ("the labels", "the lines") erases just those; otherwise the whole drawing goes.
    const kind = u.match(/\b(label|line|arrow|circle|rect|dot)s?\b/)?.[1];
    const numbers = kind ? input.board.split("\n").filter((l) => new RegExp(`^\\d+\\. ${kind}\\b`).test(l)).map((l) => l.split(".")[0]) : [];
    if (kind && !numbers.length) return d({ action: "speak", say: `I don't see any ${kind}s on the drawing.`, done: true, taskType: "chat", reason: "no such part" });
    return d({ action: "sketch", value: "erase", text: kind ? numbers.join(" ") : "all", say: kind ? "Gone." : "Cleared.", done: true, taskType: "chat", reason: kind ? `erase the ${kind}s` : "erase the drawing" });
  }
  if (/\b(add|also)\b.*\b(mark|corner|angle|label|arrow|line|dot|square)\b/.test(u)) {
    // Only the new shape rides in an "add" sketch; what's drawn stays drawn.
    return d({ action: "sketch", value: "add", text: "rect 20 72 8 8\nlabel 30 72 90°", say: "Added the square corner.", done: true, taskType: "learning", reason: "extend the drawing" });
  }
  if (/\b(circle|ring|mark)\b.*\b(equation|problem|question)\b/.test(u)) {
    const eq = page.textSummary.match(/-?\d*\s*x\s*[+\-]\s*\d+\s*=\s*-?\d+/);
    if (eq) return d({ action: "sketch", quote: eq[0], text: "circle 50 50 46", say: "Right around here.", done: true, taskType: "learning", reason: "wrap a ring onto the equation" });
    return d({ action: "speak", say: "I don't see an equation on this page to circle.", done: true, taskType: "learning" });
  }
  if (/\b(draw|sketch|write (it|this) out|draw (it|this) out|show me how to (solve|do))\b/i.test(u)) {
    if (/\b(triangle|diagram|number line|shape)\b/.test(u)) {
      const spec = "A right triangle:\nline 20 80 80 80\nline 20 80 20 30\nline 20 30 80 80\nlabel 12 58 a\nlabel 48 92 b\nlabel 54 50 c\nThe square corner is between a and b.";
      return d({ action: "sketch", text: spec, say: "Here—labeled the sides for you.", done: true, taskType: "learning", reason: "drawn diagram" });
    }
    const problem = detectProblem(page);
    if (problem.kind === "linear-equation") {
      // Analogous numbers on purpose: the board teaches the moves, never this problem's answer.
      const spec = "A similar one:\n2x + 4 = 10\n− 4 from both sides\n2x = 6\n÷ 2 on both sides\nx = 3";
      return d({ action: "sketch", text: spec, say: "Here—same moves, different numbers.", done: true, taskType: "learning", reason: "drawn worked example" });
    }
    return d({ action: "speak", say: "I can draw out worked examples for equations—want one for the problem on this page?", done: true, taskType: "learning" });
  }

  // ---- Tab switching / enter (must outrank plain click/open handling) ----
  const switchTo = /\bswitch (?:to|back to)\s+(?:the\s+)?(.+?)\s+tab\b/i.exec(utterance);
  if (switchTo && input.openTabs?.length) {
    const term = normalizeText(switchTo[1]);
    const tab = input.openTabs.find((t) => !t.active && (normalizeText(t.title).includes(term) || t.url.toLowerCase().includes(term.replace(/\s+/g, ""))));
    if (tab) return d({ action: "switch_tab", tabId: tab.id, say: `Taking you back over there.`, done: true, taskType: "navigation", reason: "switch tab by title" });
    return d({ action: "speak", say: "I don't see that tab open right now.", done: true, taskType: "navigation" });
  }
  if (/\b(?:press|hit) enter\b/i.test(u) && input.lastReferencedElementId != null) {
    return d({ action: "press_enter", elementId: input.lastReferencedElementId, say: "Done.", done: true, taskType: "administrative", reason: "enter on the referenced field" });
  }

  // ---- The visible surface: hover, double/right click, drag, keys (must outrank plain click handling) ----
  // "… for real" asks for real mouse/keyboard input, the way the model escalates with `trusted`.
  const trusted = /\bfor real$/.test(u) ? true : null;
  const su = u.replace(/\s*\bfor real$/, "");
  const pointer = /^(?:please |bunny |ok |okay |can you |could you )*(hover (?:over|on)|double[- ]click(?: on)?|right[- ]click(?: on)?)\s+(?:the\s+)?(.+)$/.exec(su);
  if (pointer) {
    const el = resolveTarget(input, pointer[2], "any");
    const action = pointer[1].startsWith("hover") ? "hover" : pointer[1].startsWith("double") ? "double_click" : "right_click";
    if (el) return d({ action, elementId: el.id, trusted, say: "Yep.", done: true, taskType: "navigation", reason: `${action} by name` });
  }
  const at = /^(?:please |bunny |can you |could you )*(double[- ]click|right[- ]click|click|hover)(?: (?:at|on|over))? (\d+) (\d+)$/.exec(su);
  if (at) {
    const action = at[1] === "click" ? "click" : at[1] === "hover" ? "hover" : at[1].startsWith("double") ? "double_click" : "right_click";
    return d({ action, x: Number(at[2]), y: Number(at[3]), trusted, say: "Right there.", done: true, taskType: "navigation", reason: `${action} at a point` });
  }
  const dragPoints = /\bdrag from (\d+) (\d+) to (\d+) (\d+)$/.exec(su);
  if (dragPoints) {
    const [x, y, toX, toY] = dragPoints.slice(1).map(Number);
    return d({ action: "drag", x, y, toX, toY, trusted, say: "Moving it.", done: true, taskType: "administrative", reason: "drag between points" });
  }
  const dragging = /\bdrag\s+(?:the\s+)?(.+?)\s+(?:to|onto|into|over to)\s+(?:the\s+)?(.+)$/.exec(su);
  if (dragging) {
    const from = resolveTarget(input, dragging[1], "any");
    const to = resolveTarget(input, dragging[2], "any");
    if (from && to && from.id !== to.id) return d({ action: "drag", elementId: from.id, toElementId: to.id, trusted, say: "Moving it.", done: true, taskType: "administrative", reason: "drag by name" });
  }
  const key = /\b(?:press|hit)\s+(?:the\s+)?(escape|esc|tab|space|backspace|delete|(?:arrow )?(?:up|down|left|right)|page ?(?:up|down)|home|end)\b/.exec(su);
  if (key) return d({ action: "press_key", text: key[1].replace(/^arrow |\s/g, ""), trusted, say: "Done.", done: true, taskType: "navigation", reason: "key by name" });

  // ---- New tab / window (must outrank plain click/open handling) ----
  const newTab = /\b(?:open|show|take me to)\b(.*)\bin a new (?:tab|window)\b|\bnew (?:tab|window)\b.*\b(?:for|with|of)\b(.*)/i.exec(utterance);
  if (newTab) {
    const what = (newTab[1] ?? newTab[2] ?? "").trim();
    const link = what ? findBestElement(page.elements.filter((e) => e.role === "link" && !!e.href), what, {}) : null;
    if (link?.href) {
      const url = /^https?:\/\//i.test(link.href) ? link.href : new URL(link.href, page.url).href;
      return d({ action: "open_tab", url, say: `Opening ${truncate(link.name, 40)} in a new tab.`, done: true, taskType: "navigation", reason: "new tab from page link" });
    }
    return d({ action: "speak", say: "I don't see that here to open. Which link should I use?", done: true, taskType: "navigation" });
  }

  const wantsClick = /^(?:please |bunny |ok |okay |yeah |yes |can you |could you |would you )*(click|press|tap|hit|open|select|choose|check|tick|pick|go to|take me to|navigate to|bring me to|start|launch|submit|turn in|send)\b/.test(u);
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
  // A quoted phrase gets a text anchor: point at the words themselves, not a whole element.
  const quoted = utterance.match(/(?:where does it say|point (?:to|at)|highlight)\s+["“']([^"”']{3,120})["”']/i);
  if (quoted) {
    return d({ action: "point_to", quote: quoted[1], say: "Right here.", done: true, taskType: "navigation", reason: "quote anchor" });
  }
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
const ordinal = (n: number): string => (n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`);

export function interveneMock(input: InterventionInput): InterventionDecision {
  const { signals, page, student } = input;
  const none: InterventionDecision = { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "no strong signal" };
  const answer = findAnswerInput(page);

  if (signals.wrongStep) {
    // Point at WHERE, never at WHAT: quoting the student's own line is safe, the fix is not.
    const working = page.elements.find((e) => (e.role === "textarea" || e.role === "textbox") && (e.value ?? "").includes("=")) ?? answer;
    const lineText = (working?.value ?? "").split("\n")[signals.wrongStep.step - 1]?.trim();
    return {
      intervene: true,
      confidence: 0.9,
      type: "hint",
      message: `That ${ordinal(signals.wrongStep.step)} line${lineText ? ` — “${truncate(lineText, 40)}”` : ""} — might be worth a second look. Want to check it together?`,
      elementId: working?.id ?? null,
      reason: "step judge found a wrong line in the working",
    };
  }
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
