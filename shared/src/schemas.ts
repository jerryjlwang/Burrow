import { z } from "zod";

/**
 * The constrained action vocabulary the agent may use. The model never emits code —
 * only one of these validated, structured actions per step.
 */
export const ACTIONS = [
  "observe",
  "speak",
  "highlight",
  "point_to",
  "click",
  "focus",
  "type",
  "clear",
  "select",
  "scroll",
  "scroll_to",
  "navigate",
  "go_back",
  "wait",
  "ask_user",
  "ask_confirmation",
  "explain",
  "finish",
] as const;

export const ActionNameSchema = z.enum(ACTIONS);
export type ActionName = z.infer<typeof ActionNameSchema>;

export const TASK_TYPES = ["navigation", "accessibility", "administrative", "learning", "assessment", "chat"] as const;
export const TaskTypeSchema = z.enum(TASK_TYPES);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const PendingActionSchema = z.object({
  action: ActionNameSchema,
  elementId: z.number().int().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  value: z.string().nullable(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

/**
 * Flat decision shape. Every field is present (nullable) so it works with strict
 * structured-output JSON schemas. Per-action requirements are enforced in validateDecision().
 */
export const AgentDecisionSchema = z.object({
  action: ActionNameSchema.describe("The single browser/companion action to take this step."),
  say: z
    .string()
    .nullable()
    .describe(
      "What the companion says out loud right now, if anything. Conversational, at most ~30 words. Use null to stay silent.",
    ),
  elementId: z
    .number()
    .int()
    .nullable()
    .describe(
      "Target element id from INTERACTIVE ELEMENTS. Required for highlight, point_to, click, focus, type, clear, select and scroll_to. Otherwise null.",
    ),
  text: z
    .string()
    .nullable()
    .describe(
      "Text to type (type); the question to ask (ask_user); a longer written explanation shown in the panel (explain); or 'screenshot' to request visual context (observe). Otherwise null.",
    ),
  url: z.string().nullable().describe("Absolute http(s) URL for navigate. Otherwise null."),
  direction: z.enum(["up", "down"]).nullable().describe("Scroll direction for scroll. Otherwise null."),
  amount: z.number().nullable().describe("Pixels for scroll or milliseconds for wait. Otherwise null."),
  value: z.string().nullable().describe("Option label or value for select. Otherwise null."),
  pendingAction: PendingActionSchema.nullable().describe(
    "Only for ask_confirmation: the action to run if the student agrees. Otherwise null.",
  ),
  taskType: TaskTypeSchema.nullable().describe("Your classification of what the student is trying to do."),
  reason: z.string().describe("One short internal sentence explaining the choice. Never spoken."),
  done: z.boolean().describe("true when nothing else should happen after this action."),
});
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const DECISION_DEFAULTS: Omit<AgentDecision, "action" | "reason"> = {
  say: null,
  elementId: null,
  text: null,
  url: null,
  direction: null,
  amount: null,
  value: null,
  pendingAction: null,
  taskType: null,
  done: false,
};

const ELEMENT_ACTIONS = new Set<ActionName>(["highlight", "point_to", "click", "focus", "type", "clear", "select", "scroll_to"]);

export type DecisionValidation = { ok: true; decision: AgentDecision } | { ok: false; error: string };

/**
 * Validates arbitrary (model-produced) output into a safe AgentDecision.
 * Missing optional fields are tolerated (filled with null) but wrong shapes are rejected.
 * Malformed agent output must never execute.
 */
export function validateDecision(raw: unknown): DecisionValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "decision is not an object" };
  const candidate = { ...DECISION_DEFAULTS, reason: "", ...(raw as Record<string, unknown>) };
  const parsed = AgentDecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
  }
  const d = parsed.data;
  if (ELEMENT_ACTIONS.has(d.action) && (d.elementId === null || d.elementId < 0)) {
    return { ok: false, error: `${d.action} requires a valid elementId` };
  }
  if (d.action === "type" && (d.text === null || d.text.length === 0)) return { ok: false, error: "type requires text" };
  if (d.action === "type" && d.text!.length > 2000) return { ok: false, error: "type text too long" };
  if (d.action === "select" && d.value === null) return { ok: false, error: "select requires value" };
  if (d.action === "navigate") {
    if (!d.url || !/^https?:\/\//i.test(d.url)) return { ok: false, error: "navigate requires an absolute http(s) url" };
  }
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
  if (d.action === "wait") {
    const ms = d.amount ?? 800;
    d.amount = Math.min(Math.max(ms, 100), 5000);
  }
  if (d.action === "scroll") {
    const px = d.amount ?? 500;
    d.amount = Math.min(Math.max(Math.abs(px), 80), 4000);
  }
  if (d.say !== null) d.say = d.say.trim().slice(0, 400) || null;
  return { ok: true, decision: d };
}

export const InterventionDecisionSchema = z.object({
  intervene: z.boolean().describe("Whether the companion should proactively reach out right now."),
  confidence: z.number().min(0).max(1).describe("0..1 confidence that helping now is welcome and useful."),
  type: z.enum(["hint", "nudge", "navigation", "explain", "encourage", "none"]).describe("Kind of help to offer."),
  message: z
    .string()
    .nullable()
    .describe("The short, warm thing to say (max ~15 words). Usually an offer, e.g. 'Want a hint?'. null if not intervening."),
  elementId: z.number().int().nullable().describe("Element to look toward / highlight, if relevant. Otherwise null."),
  reason: z.string().describe("One short internal sentence. Never shown."),
});
export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>;

export function validateIntervention(raw: unknown): { ok: true; decision: InterventionDecision } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "intervention is not an object" };
  const candidate = { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "", ...(raw as object) };
  const parsed = InterventionDecisionSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const d = parsed.data;
  if (d.intervene && !d.message) return { ok: false, error: "intervene=true requires a message" };
  if (d.message) d.message = d.message.trim().slice(0, 240);
  return { ok: true, decision: d };
}
