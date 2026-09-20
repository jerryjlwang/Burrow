/**
 * Hand-written strict JSON schemas (every property required, no additionalProperties) for
 * providers whose structured-output mode needs plain JSON Schema (OpenAI). Kept in sync with
 * shared/src/actions.ts; the shared validators re-check every field at runtime anyway.
 */
import { ACTIONS, INTERVENTION_TYPES, TASK_TYPES } from "@shared/actions";

const nullable = (schema: Record<string, unknown>, description?: string) => ({ anyOf: [schema, { type: "null" }], ...(description ? { description } : {}) });
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });

const PENDING_ACTION = {
  type: "object",
  description: "The action to run if the student agrees.",
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    elementId: nullable({ type: "integer" }),
    text: nullable({ type: "string" }),
    url: nullable({ type: "string" }),
    value: nullable({ type: "string" }),
  },
  required: ["action", "elementId", "text", "url", "value"],
  additionalProperties: false,
};

export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "The single browser/companion action to take this step." },
    say: nullable(str(), "What the companion says out loud right now, if anything. Conversational, at most ~30 words. null to stay silent."),
    elementId: nullable({ type: "integer" }, "Target element id from INTERACTIVE ELEMENTS. Required for highlight, point_to, click, focus, type, clear, select, scroll_to. Otherwise null."),
    text: nullable(str(), "Text to type (type); the question (ask_user); a longer written explanation for the panel (explain); or 'screenshot' to request visual context (observe). Otherwise null."),
    url: nullable(str(), "Absolute http(s) URL for navigate. Otherwise null."),
    direction: nullable({ type: "string", enum: ["up", "down"] }, "Scroll direction for scroll. Otherwise null."),
    amount: nullable({ type: "number" }, "Pixels for scroll or milliseconds for wait. Otherwise null."),
    value: nullable(str(), "Option label or value for select. Otherwise null."),
    quote: nullable(str(), "point_to/highlight only: EXACT short text (3-12 words) copied verbatim from VISIBLE TEXT, to point at that specific text; may replace elementId. Otherwise null."),
    line: nullable({ type: "integer" }, "point_to/highlight on a textbox/textarea: 1-based line of its value to anchor to (requires elementId), e.g. a step of written working. Otherwise null."),
    pendingAction: nullable(PENDING_ACTION, "Only for ask_confirmation. Otherwise null."),
    taskType: nullable({ type: "string", enum: [...TASK_TYPES] }, "Your classification of what the student is trying to do."),
    reason: str("One short internal sentence explaining the choice. Never spoken."),
    done: { type: "boolean", description: "true when nothing else should happen after this action." },
  },
  required: ["action", "say", "elementId", "text", "url", "direction", "amount", "value", "quote", "line", "pendingAction", "taskType", "reason", "done"],
  additionalProperties: false,
} as const;

export const INTERVENTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    intervene: { type: "boolean", description: "Whether the companion should proactively reach out right now." },
    confidence: { type: "number", description: "0..1 confidence that helping now is welcome and useful." },
    type: { type: "string", enum: [...INTERVENTION_TYPES], description: "Kind of help to offer." },
    message: nullable(str(), "The short, warm offer (max ~15 words), e.g. 'Want a hint?'. null if not intervening."),
    elementId: nullable({ type: "integer" }, "Element to look toward / highlight, if relevant. Otherwise null."),
    reason: str("One short internal sentence. Never shown."),
  },
  required: ["intervene", "confidence", "type", "message", "elementId", "reason"],
  additionalProperties: false,
} as const;
