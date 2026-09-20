import type { Misconception } from "./graph";

/**
 * Composes the proactive Socratic nudge for a detected misconception.
 *
 * The bubble message IS the Socratic question — it prompts the learner to test their own belief,
 * and never states the correct answer (rung 1–2 of the hint ladder, not a lecture). If the learner
 * engages, `goal` steers the agent loop with the misconception context so the conversation stays
 * Socratic instead of falling back to generic hinting.
 */
export interface MisconceptionNudge {
  /** What the bubble says — a question that pokes at the belief, answer withheld. */
  message: string;
  /** Loop goal if the learner engages, carrying the belief + teaching constraints. */
  goal: string;
}

/**
 * Hand-written Socratic questions for the classic seed misconceptions. Keyed by regex over the
 * belief text (LLM-extracted beliefs are phrased freely, so exact matching would miss). Each asks
 * the learner to test a prediction of their own belief — none states the right answer.
 */
const SEED_QUESTIONS: Array<{ pattern: RegExp; question: string }> = [
  { pattern: /\bsun\b[^.]*\b(?:clos|near)|\b(?:clos|near)\w*\b[^.]*\bsun\b/i, question: "If being closer to the sun made summer, would Australia have summer at the same time as us?" },
  { pattern: /\bheav\w+\b[^.]*\bfall/i, question: "If a hammer and a feather fell with nothing else around—say, on the Moon—which would land first?" },
  { pattern: /\bshadow\b[^.]*\bmoon|moon\b[^.]*\bshadow/i, question: "If moon phases were Earth's shadow, why can you sometimes see a half-lit moon and the sun in the sky together?" },
  { pattern: /\btheory\b/i, question: "In everyday talk 'theory' means a guess—does it mean the same thing in science?" },
  { pattern: /\b(?:10|ten)\s*%[^.]*\bbrain|brain\b[^.]*\b(?:10|ten)\s*%/i, question: "If 90% of the brain did nothing, why would damage to almost any part of it cause problems?" },
];

/** First sentence, trimmed to a spoken-bubble length. */
function brief(text: string, max = 140): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

export function composeMisconceptionNudge(m: Misconception): MisconceptionNudge {
  const isRecurring = m.status === "recurring" && !!m.resolution?.note;
  let message: string;
  if (isRecurring) {
    // Their own past insight is the strongest, least leaky hint there is.
    message = `We've untangled this one before—remember what cracked it? ${brief(m.resolution!.note)}. Does that still work here?`;
  } else {
    const seed = SEED_QUESTIONS.find((s) => s.pattern.test(m.belief));
    message = seed ? seed.question : `Here's an idea worth testing: “${brief(m.belief)}.” What would you expect to see if that were true?`;
  }
  const goal = [
    `The student appears to hold the misconception: "${m.belief}" (concept: ${m.concept}).`,
    m.evidence ? `Evidence: they wrote "${m.evidence}".` : null,
    isRecurring ? `They resolved this same misconception before; what unstuck them then: "${m.resolution!.note}". Gently invoke that memory.` : null,
    `You just asked them: "${message}".`,
    `Guide them Socratically to test their own belief. Ask questions and offer small observations; do NOT state the correct explanation outright unless they have worked most of the way there themselves.`,
  ]
    .filter(Boolean)
    .join(" ");
  return { message, goal };
}
