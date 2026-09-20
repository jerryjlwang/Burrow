/**
 * Zod schemas used by the SERVER for LLM structured outputs. The extension uses the
 * zod-free validators in ./validate and the constants/types in ./actions instead.
 */
import { z } from "zod";
import { ACTIONS, INTERVENTION_TYPES, TASK_TYPES } from "./actions";

export { ACTIONS, TASK_TYPES, INTERVENTION_TYPES, DECISION_DEFAULTS } from "./actions";
export type { ActionName, TaskType, InterventionType, AgentDecision, InterventionDecision, PendingAction } from "./actions";
export { validateDecision, validateIntervention } from "./validate";
export type { DecisionValidation } from "./validate";

export const ActionNameSchema = z.enum(ACTIONS);
export const TaskTypeSchema = z.enum(TASK_TYPES);

export const PendingActionSchema = z.object({
  action: ActionNameSchema,
  elementId: z.number().int().nullable(),
  text: z.string().nullable(),
  url: z.string().nullable(),
  value: z.string().nullable(),
});

/**
 * Flat decision shape. Every field is present (nullable) so it works with strict
 * structured-output JSON schemas. Per-action requirements are enforced in validateDecision().
 */
export const AgentDecisionSchema = z.object({
  action: ActionNameSchema.describe("The single browser/companion action to take this step."),
  say: z
    .string()
    .nullable()
    .describe("What the companion says out loud right now, if anything. Conversational, at most ~30 words. Use null to stay silent."),
  elementId: z
    .number()
    .int()
    .nullable()
    .describe("Target element id from INTERACTIVE ELEMENTS. Required for highlight, point_to, click, focus, type, clear, select and scroll_to. Otherwise null."),
  text: z
    .string()
    .nullable()
    .describe("Text to type (type); the question to ask (ask_user); a longer written explanation shown in the panel (explain); or 'screenshot' to request visual context (observe). Otherwise null."),
  url: z.string().nullable().describe("Absolute http(s) URL for navigate. Otherwise null."),
  direction: z.enum(["up", "down"]).nullable().describe("Scroll direction for scroll. Otherwise null."),
  amount: z.number().nullable().describe("Pixels for scroll or milliseconds for wait. Otherwise null."),
  value: z.string().nullable().describe("Option label or value for select. Otherwise null."),
  pendingAction: PendingActionSchema.nullable().describe("Only for ask_confirmation: the action to run if the student agrees. Otherwise null."),
  taskType: TaskTypeSchema.nullable().describe("Your classification of what the student is trying to do."),
  reason: z.string().describe("One short internal sentence explaining the choice. Never spoken."),
  done: z.boolean().describe("true when nothing else should happen after this action."),
});

export const InterventionDecisionSchema = z.object({
  intervene: z.boolean().describe("Whether the companion should proactively reach out right now."),
  confidence: z.number().min(0).max(1).describe("0..1 confidence that helping now is welcome and useful."),
  type: z.enum(INTERVENTION_TYPES).describe("Kind of help to offer."),
  message: z
    .string()
    .nullable()
    .describe("The short, warm thing to say (max ~15 words). Usually an offer, e.g. 'Want a hint?'. null if not intervening."),
  elementId: z.number().int().nullable().describe("Element to look toward / highlight, if relevant. Otherwise null."),
  reason: z.string().describe("One short internal sentence. Never shown."),
});
