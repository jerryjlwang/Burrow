import type { AgentDecision, TaskType } from "@shared/actions";
import type { PageElement, PageSummary } from "@shared/types";
import { normalizeText } from "@shared/text";

export interface PolicyContext {
  element?: PageElement | null;
  page?: PageSummary | null;
  utterance?: string;
}

export interface PolicyVerdict {
  required: boolean;
  reason?: string;
  message?: string;
}

const CONSEQUENTIAL_RE =
  /\b(submit|turn in|hand in|send|purchase|buy( now)?|checkout|check out|place order|pay(ment)?|order now|delete|remove|erase|discard|publish|post( comment| reply)?|share|finish (quiz|exam|test|attempt)|end (quiz|exam|test)|sign out|log out|logout|unsubscribe|cancel (subscription|order|account)|transfer|withdraw|donate|enroll|unenroll|drop (course|class)|change (password|email)|reset password|delete account|grant|allow|accept (terms|all)|agree|confirm (order|purchase|payment)|report|block|unfriend|leave (group|class)|reply all|save changes)\b/i;
const SAFE_WORD_RE = /\b(search|filter|sort|preview|draft|save draft|cancel$|close|dismiss|next question|previous|back|show|hide|expand|collapse|more)\b/i;
const SUBMIT_WORK_RE = /\b(submit|turn in|hand in|finish attempt|end (quiz|exam|test)|submit (all|quiz|exam|test|assignment|answers?))\b/i;

/**
 * Central policy: which actions must be confirmed by the student before execution.
 * Keep every rule here rather than scattered through components.
 */
export function requiresConfirmation(decision: AgentDecision, ctx: PolicyContext = {}): PolicyVerdict {
  const el = ctx.element ?? null;
  const page = ctx.page ?? null;

  if (decision.action === "ask_confirmation") return { required: false };

  if (decision.action === "click" && el) {
    const label = `${el.name} ${el.context ?? ""}`;
    if (SAFE_WORD_RE.test(el.name) && !SUBMIT_WORK_RE.test(el.name)) return { required: false };
    if (SUBMIT_WORK_RE.test(label) || (page?.hasQuizUi && /\b(submit|turn in|finish)\b/i.test(el.name))) {
      return { required: true, reason: "submits schoolwork", message: `This will submit your work. Want me to go ahead?` };
    }
    if (CONSEQUENTIAL_RE.test(el.name)) {
      const verb = el.name.match(CONSEQUENTIAL_RE)?.[0]?.toLowerCase() ?? "do that";
      return { required: true, reason: `consequential control: ${verb}`, message: `This will ${verb}—want me to go ahead?` };
    }
    if (el.tag === "input" && el.inputType === "submit") {
      return { required: true, reason: "form submit", message: `This sends the form. Want me to go ahead?` };
    }
    if (el.role === "button" && el.tag === "button" && page?.forms && page.forms > 0 && /\b(send|apply|register|sign up|create account|join)\b/i.test(el.name)) {
      return { required: true, reason: "form submission", message: `This looks like it sends the form. Want me to go ahead?` };
    }
  }
  if (decision.action === "press_enter" && page?.hasQuizUi) {
    // Enter inside quiz UI can submit graded work; a search box on a content page is fine.
    return { required: true, reason: "enter may submit assessed work", message: "Pressing Enter here might submit your answer. Want me to go ahead?" };
  }
  if (decision.action === "navigate" || decision.action === "open_tab") {
    if (page && decision.url) {
      try {
        const from = new URL(page.url);
        const to = new URL(decision.url);
        if (/(checkout|payment|billing|delete|unsubscribe)/i.test(to.pathname)) {
          return { required: true, reason: "sensitive destination", message: `That goes to a ${to.pathname.includes("checkout") ? "checkout" : "sensitive"} page. Want me to open it?` };
        }
        if (from.origin !== to.origin && !/^https?:$/.test(to.protocol)) {
          return { required: true, reason: "non-http navigation", message: `Open ${to.href}?` };
        }
      } catch {
        return { required: true, reason: "unparseable url", message: `Open ${decision.url}?` };
      }
    }
  }
  if (decision.action === "type" && el && /\b(message|comment|reply|post|chat|email body)\b/i.test(`${el.name} ${el.context ?? ""}`) && (decision.text?.length ?? 0) > 200) {
    return { required: false };
  }
  return { required: false };
}

export interface ForbiddenVerdict {
  forbidden: boolean;
  reason?: string;
  message?: string;
}

const CARD_RE = /^(?:\d[ -]?){13,19}$/;
const PASSWORD_UTTERANCE_RE = /\b(password|passcode|pin code|verification code|auth(entication)? code|one[- ]time code|cvv|cvc|card number|social security|ssn)\b/i;

/** Actions the companion never performs, regardless of confirmation. */
export function isForbidden(decision: AgentDecision, ctx: PolicyContext = {}): ForbiddenVerdict {
  const el = ctx.element ?? null;
  if ((decision.action === "type" || decision.action === "clear" || decision.action === "select") && el?.sensitive) {
    return { forbidden: true, reason: "sensitive field", message: "That's a private field—passwords, payment details and codes are yours to type. I'll stay out of it." };
  }
  if (decision.action === "type" && decision.text) {
    const t = decision.text.trim();
    if (CARD_RE.test(t.replace(/\s/g, " ")) && t.replace(/\D/g, "").length >= 13) {
      return { forbidden: true, reason: "card-like number", message: "That looks like a card number, so I won't type it. Please enter it yourself." };
    }
    if (ctx.utterance && PASSWORD_UTTERANCE_RE.test(ctx.utterance)) {
      return { forbidden: true, reason: "credential typing requested", message: "I don't type passwords or codes—please enter that yourself." };
    }
  }
  if (decision.action === "click" && el?.sensitive && el.role !== "button") {
    return { forbidden: false };
  }
  return { forbidden: false };
}

/** Rough task classification used for coaching intensity and the student model. */
export function classifyTask(utterance: string, page?: PageSummary | null): TaskType {
  const u = normalizeText(utterance);
  if (/(what s on|whats on|describe|summari|read (this|the|it|me)|what does (this|it) say|what am i looking at|where am i)/.test(u)) return "accessibility";
  if (/(how do i (solve|do|find x|factor|simplify|start)|why (is|does|do)|what (is|are|does) (a|an|the)? ?[a-z ]+ mean|explain|hint|stuck|don t (get|understand)|dont (get|understand)|help me (with|understand)|walk me through|derivative|integral|equation|formula|concept)/.test(u)) return "learning";
  if (/(answer (question|number|q)|what s the answer|whats the answer|tell me the answer|solve (it|this|question|number \d+) for me|solve (question|number) \d+|pick the (right|correct)|which (answer|option) is (right|correct)|do question)/.test(u)) return "assessment";
  if (/(type|enter|fill|put|write) (my|the|in|into)|my name|my email|fill (in|out) (the|this) form/.test(u)) return "administrative";
  if (/(where|open|go to|take me|find|click|press|navigate|show me|which button|submit|scroll|back)/.test(u)) return "navigation";
  if (page?.hasQuizUi && /(this (one|question|problem)|number \d|question \d)/.test(u)) return "learning";
  return "chat";
}
