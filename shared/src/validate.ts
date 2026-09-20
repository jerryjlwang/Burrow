import { parseKeyChord } from "./keys";
import { VIDEO_OPS, VIDEO_RATE_MAX, VIDEO_RATE_MIN, parseVideoTime } from "./video";
import { ACTIONS, DECISION_DEFAULTS, INTERVENTION_TYPES, TASK_TYPES, type ActionName, type AgentDecision, type InterventionDecision, type PendingAction } from "./actions";

const ACTION_SET = new Set<string>(ACTIONS);
const TASK_SET = new Set<string>(TASK_TYPES);
const INTERVENTION_SET = new Set<string>(INTERVENTION_TYPES);
const ELEMENT_ACTIONS = new Set<ActionName>(["highlight", "point_to", "focus", "clear", "select", "press_enter", "scroll_to"]);
/** Pointer actions aim at an element OR a viewport point, so the agent can work canvases, maps and anything the element list misses. */
const POINTER_ACTIONS = new Set<ActionName>(["click", "double_click", "right_click", "hover", "drag"]);
const MAX_COORD = 20000;
/** Actions that may carry a sub-element target (a verbatim quote or a line of a field's value): pointing, and observe's full-region read. */
const ANCHOR_ACTIONS = new Set<ActionName>(["highlight", "point_to", "observe", "sketch"]);

export type DecisionValidation = { ok: true; decision: AgentDecision } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`${field} must be a string or null`);
  return v;
};
const optNum = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${field} must be a number or null`);
  return v;
};
const optInt = (v: unknown, field: string): number | null => {
  const n = optNum(v, field);
  if (n !== null && !Number.isInteger(n)) throw new Error(`${field} must be an integer`);
  return n;
};

function parsePending(raw: unknown): PendingAction | null {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw)) throw new Error("pendingAction must be an object");
  const action = raw.action;
  if (typeof action !== "string" || !ACTION_SET.has(action)) throw new Error("pendingAction.action is not a known action");
  return {
    action: action as ActionName,
    elementId: optInt(raw.elementId, "pendingAction.elementId"),
    text: optStr(raw.text, "pendingAction.text"),
    url: optStr(raw.url, "pendingAction.url"),
    value: optStr(raw.value, "pendingAction.value"),
  };
}

/**
 * Validates arbitrary (model-produced) output into a safe AgentDecision.
 * Missing optional fields are tolerated (filled with null); wrong shapes are rejected.
 * Malformed agent output must never execute.
 */
export function validateDecision(raw: unknown): DecisionValidation {
  if (!isObj(raw)) return { ok: false, error: "decision is not an object" };
  try {
    const action = raw.action;
    if (typeof action !== "string" || !ACTION_SET.has(action)) return { ok: false, error: `unknown action ${String(action)}` };
    const direction = raw.direction === undefined || raw.direction === null ? null : raw.direction;
    if (direction !== null && direction !== "up" && direction !== "down") return { ok: false, error: "direction must be up|down|null" };
    const taskType = raw.taskType === undefined || raw.taskType === null ? null : raw.taskType;
    if (taskType !== null && (typeof taskType !== "string" || !TASK_SET.has(taskType))) return { ok: false, error: "invalid taskType" };
    if (raw.done !== undefined && typeof raw.done !== "boolean") return { ok: false, error: "done must be boolean" };
    const d: AgentDecision = {
      ...DECISION_DEFAULTS,
      action: action as ActionName,
      say: optStr(raw.say, "say"),
      elementId: optInt(raw.elementId, "elementId"),
      text: optStr(raw.text, "text"),
      url: optStr(raw.url, "url"),
      direction: direction as AgentDecision["direction"],
      amount: optNum(raw.amount, "amount"),
      value: optStr(raw.value, "value"),
      quote: optStr(raw.quote, "quote"),
      line: optInt(raw.line, "line"),
      tabId: optInt(raw.tabId, "tabId"),
      x: optNum(raw.x, "x"),
      y: optNum(raw.y, "y"),
      toElementId: optInt(raw.toElementId, "toElementId"),
      toX: optNum(raw.toX, "toX"),
      toY: optNum(raw.toY, "toY"),
      trusted: raw.trusted === true ? true : null,
      pendingAction: parsePending(raw.pendingAction),
      taskType: taskType as AgentDecision["taskType"],
      reason: typeof raw.reason === "string" ? raw.reason : "",
      done: raw.done === true,
    };
    // Anchors only make sense on pointing actions; quash them elsewhere rather than reject.
    if (!ANCHOR_ACTIONS.has(d.action)) {
      d.quote = null;
      d.line = null;
    } else {
      // observe/sketch take whole-region targets; only quote/elementId apply — a stray line is noise, not an error.
      if (d.action === "observe" || d.action === "sketch") d.line = null;
      if (d.quote !== null) d.quote = d.quote.trim().slice(0, 200) || null;
      if (d.line !== null && d.line < 1) return { ok: false, error: "line must be >= 1" };
      if (d.line !== null && d.elementId === null) return { ok: false, error: "line anchoring requires an elementId" };
    }
    // point_to/highlight may target a quote instead of an element; everything else needs the element.
    // point_to may also name a described part in text ("the 25 on line 2"): on the drawing tablet the handwriting has no elements.
    const elementSatisfied = d.elementId !== null && d.elementId >= 0;
    const described = d.action === "point_to" && typeof d.text === "string" && d.text.trim().length > 0;
    if (ELEMENT_ACTIONS.has(d.action) && !elementSatisfied && !(ANCHOR_ACTIONS.has(d.action) && (d.quote || d.x !== null)) && !described) {
      return { ok: false, error: `${d.action} requires a valid elementId` };
    }
    if (ELEMENT_ACTIONS.has(d.action) && d.elementId !== null && d.elementId < 0) return { ok: false, error: `${d.action} requires a valid elementId` };
    for (const [name, v] of [["x", d.x], ["y", d.y], ["toX", d.toX], ["toY", d.toY]] as const) {
      if (v !== null && (v < 0 || v > MAX_COORD)) return { ok: false, error: `${name} is outside the page` };
    }
    // A half-specified point is a model slip, not a target.
    if ((d.x === null) !== (d.y === null)) return { ok: false, error: "x and y must be given together" };
    if ((d.toX === null) !== (d.toY === null)) return { ok: false, error: "toX and toY must be given together" };
    if (d.elementId !== null && d.elementId < 0 && (POINTER_ACTIONS.has(d.action) || d.action === "type")) d.elementId = null;
    const hasSource = (d.elementId !== null && d.elementId >= 0) || d.x !== null;
    if (POINTER_ACTIONS.has(d.action) && !hasSource) return { ok: false, error: `${d.action} requires an elementId or x,y` };
    if (d.action === "drag" && !((d.toElementId !== null && d.toElementId >= 0) || d.toX !== null)) return { ok: false, error: "drag requires a destination: toElementId or toX,toY" };
    if (d.action === "press_key" && (!d.text || !parseKeyChord(d.text))) return { ok: false, error: 'press_key requires text naming a key or chord, e.g. "Escape", "ArrowDown", "Control+a"' };
    if (d.action === "type" && (d.text === null || d.text.length === 0)) return { ok: false, error: "type requires text" };
    if (d.action === "type" && d.text!.length > 2000) return { ok: false, error: "type text too long" };
    if (d.action === "select" && d.value === null) return { ok: false, error: "select requires value" };
    if ((d.action === "navigate" || d.action === "open_tab") && (!d.url || !/^https?:\/\//i.test(d.url))) return { ok: false, error: `${d.action} requires an absolute http(s) url` };
    if (d.action === "switch_tab" && d.tabId === null) return { ok: false, error: "switch_tab requires a tabId from the open tabs list" };
    if (d.action === "look_up" && (!d.text || !d.text.trim())) return { ok: false, error: "look_up requires text (the query)" };
    if (d.action === "sketch" && (!d.text || !d.text.trim())) return { ok: false, error: d.value === "erase" ? 'sketch erase requires text: "all", or the item numbers from DRAWING ON SCREEN' : "sketch requires text (the lines to draw)" };
    if (d.action === "sketch" && d.value === "erase" && !/^\s*(all|everything|[\d\s,-]+)\s*$/i.test(d.text!)) return { ok: false, error: 'sketch erase text must be "all" or item numbers like "2 5" or "3-6"' };
    if (d.action === "sketch" && d.text!.length > 1200) return { ok: false, error: "sketch text too long" };
    // sketch's value is a mode switch: "add" extends the drawing on screen, "erase" removes from it; anything else means a fresh one.
    if (d.action === "sketch" && d.value !== null && d.value !== "add" && d.value !== "erase") d.value = null;
    if (d.action === "video") {
      if (!(VIDEO_OPS as readonly string[]).includes(d.value ?? "")) return { ok: false, error: 'video requires value: "play", "pause", "seek" or "speed"' };
      if (d.value === "seek" && (!d.text || parseVideoTime(d.text, 0) === null)) return { ok: false, error: 'video seek requires text: a time like "6:40", or "+10" / "-10" seconds from here' };
      const rate = Number(d.text);
      if (d.value === "speed" && !(rate >= VIDEO_RATE_MIN && rate <= VIDEO_RATE_MAX)) return { ok: false, error: `video speed requires text: a rate from ${VIDEO_RATE_MIN} to ${VIDEO_RATE_MAX}, e.g. "0.75"` };
    }
    if (d.action === "look_up" && d.text!.length > 200) return { ok: false, error: "look_up query too long" };
    if (d.action === "make_plan" && (!d.text || !d.text.trim())) return { ok: false, error: "make_plan requires text (what the student wants to learn)" };
    if (d.action === "make_plan" && d.text!.length > 200) return { ok: false, error: "make_plan goal too long" };
    if (d.action === "scroll" && d.direction === null) return { ok: false, error: "scroll requires direction" };
    if (d.action === "ask_confirmation") {
      if (!d.pendingAction) return { ok: false, error: "ask_confirmation requires pendingAction" };
      if (!d.say && !d.text) return { ok: false, error: "ask_confirmation requires a message" };
      const inner = validateDecision({ ...d.pendingAction, reason: "pending" });
      if (!inner.ok) return { ok: false, error: `pendingAction invalid: ${inner.error}` };
      if (inner.decision.action === "ask_confirmation") return { ok: false, error: "nested confirmation" };
    }
    if (d.action === "ask_user" && !d.say && !d.text) return { ok: false, error: "ask_user requires a question" };
    if (d.action === "explain" && !d.text && !d.say) return { ok: false, error: "explain requires text" };
    if (d.action === "wait") d.amount = Math.min(Math.max(d.amount ?? 800, 100), 5000);
    if (d.action === "scroll") d.amount = Math.min(Math.max(Math.abs(d.amount ?? 500), 80), 4000);
    if (d.say !== null) d.say = d.say.trim().slice(0, 400) || null;
    return { ok: true, decision: d };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function validateIntervention(raw: unknown): { ok: true; decision: InterventionDecision } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "intervention is not an object" };
  try {
    const type = raw.type === undefined || raw.type === null ? "none" : raw.type;
    if (typeof type !== "string" || !INTERVENTION_SET.has(type)) return { ok: false, error: "invalid intervention type" };
    const confidence = raw.confidence === undefined || raw.confidence === null ? 0 : raw.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) return { ok: false, error: "confidence must be within 0..1" };
    if (raw.intervene !== undefined && typeof raw.intervene !== "boolean") return { ok: false, error: "intervene must be boolean" };
    const d: InterventionDecision = {
      intervene: raw.intervene === true,
      confidence,
      type: type as InterventionDecision["type"],
      message: optStr(raw.message, "message"),
      elementId: optInt(raw.elementId, "elementId"),
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
    if (d.intervene && !d.message) return { ok: false, error: "intervene=true requires a message" };
    if (d.message) d.message = d.message.trim().slice(0, 240);
    return { ok: true, decision: d };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
