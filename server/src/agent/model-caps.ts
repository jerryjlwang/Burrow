/**
 * Model-family probes shared by the agent provider and the concept extractor.
 *
 * Reasoning models take `reasoning_effort` and reject `temperature`, so the two have to be
 * chosen together. The accepted effort names also move between generations: gpt-5 has
 * "none"/"minimal" below "low", gpt-6 (Astra) starts at "low", so callers normalise before
 * sending rather than paying for a round trip that 400s.
 */

export type Effort = "none" | "minimal" | "low" | "medium" | "high";

export function isReasoningModel(model: string): boolean {
  return /^(gpt-[56]|o\d)/.test(model);
}

/** gpt-6 has no sub-"low" effort, so anything faster clamps up to "low". */
export function normalizeEffort(model: string, effort: Effort): Effort {
  if (/^gpt-6/.test(model) && (effort === "none" || effort === "minimal")) return "low";
  return effort;
}
