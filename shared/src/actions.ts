/** Action vocabulary and defaults shared by the extension and the server. Zod-free so the content script stays small. */
export const ACTIONS = [
  "observe",
  "speak",
  "highlight",
  "point_to",
  "click",
  "double_click",
  "right_click",
  "hover",
  "drag",
  "focus",
  "type",
  "clear",
  "select",
  "press_enter",
  "press_key",
  "scroll",
  "scroll_to",
  "navigate",
  "open_tab",
  "switch_tab",
  "go_back",
  "wait",
  "look_up",
  "make_plan",
  "show_plan",
  "ask_user",
  "ask_confirmation",
  "explain",
  "sketch",
  "finish",
] as const;
export type ActionName = (typeof ACTIONS)[number];

export const TASK_TYPES = ["navigation", "accessibility", "administrative", "learning", "assessment", "chat"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const INTERVENTION_TYPES = ["hint", "nudge", "navigation", "explain", "encourage", "none"] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export interface PendingAction {
  action: ActionName;
  elementId: number | null;
  text: string | null;
  url: string | null;
  value: string | null;
}

/** Flat decision shape (every field present, nullable) — matches the structured-output schema. */
export interface AgentDecision {
  action: ActionName;
  say: string | null;
  elementId: number | null;
  text: string | null;
  url: string | null;
  direction: "up" | "down" | null;
  amount: number | null;
  value: string | null;
  /** point_to/highlight: exact text copied verbatim from the page to anchor the pointer inside/without an element. */
  quote: string | null;
  /** point_to/highlight on a textbox/textarea: 1-based line of its value to anchor to (e.g. a working step). */
  line: number | null;
  /** switch_tab: the id of the tab to activate, from the OPEN TABS list. */
  tabId: number | null;
  /** Pointer target in CSS pixels from the viewport's top-left (= screenshot pixels); an alternative to elementId. */
  x: number | null;
  y: number | null;
  /** drag: where to drop — another element, or a viewport point. */
  toElementId: number | null;
  toX: number | null;
  toY: number | null;
  pendingAction: PendingAction | null;
  taskType: TaskType | null;
  reason: string;
  done: boolean;
}

export interface InterventionDecision {
  intervene: boolean;
  confidence: number;
  type: InterventionType;
  message: string | null;
  elementId: number | null;
  reason: string;
}

export const DECISION_DEFAULTS: Omit<AgentDecision, "action" | "reason"> = {
  say: null,
  elementId: null,
  text: null,
  url: null,
  direction: null,
  amount: null,
  value: null,
  quote: null,
  line: null,
  tabId: null,
  x: null,
  y: null,
  toElementId: null,
  toX: null,
  toY: null,
  pendingAction: null,
  taskType: null,
  done: false,
};
