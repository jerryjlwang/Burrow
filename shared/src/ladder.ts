import type { StruggleSignals, StudentSessionState } from "./types";
import type { DetectedProblem } from "./hints";

/**
 * The hint ladder: how much to reveal when giving learning help (the assistance dilemma).
 * Start at the lowest rung that could plausibly unstick the student; climb only while the stall
 * continues. The rung is passed to the generator as a HARD constraint, and a leak-check pass
 * rejects any output that states the final answer regardless of rung.
 */
export interface HintRung {
  rung: 1 | 2 | 3 | 4 | 5;
  name: string;
  /** The hard constraint injected into the generator prompt. */
  constraint: string;
}

export const HINT_RUNGS: HintRung[] = [
  {
    rung: 1,
    name: "metacognitive prompt",
    constraint: "Ask ONE short question that helps the student notice what they are trying to find or what they already know. Say nothing about the solution itself.",
  },
  {
    rung: 2,
    name: "pointing",
    constraint: "Direct the student's attention to the exact place to look (use point_to/highlight, 'read this part again'). Name what to look AT — never what they will find there.",
  },
  {
    rung: 3,
    name: "prerequisite clarification",
    constraint: "Briefly re-explain the ONE underlying rule or concept needed here, in general terms. Never apply it to this problem's own numbers.",
  },
  {
    rung: 4,
    name: "redirect / analogous example",
    constraint: "Suggest a better approach, or walk through ONE analogous example with different numbers. Never operate on this problem's own values.",
  },
  {
    rung: 5,
    name: "worked step",
    constraint: "Perform exactly ONE next step of this problem and stop there. The step's intermediate result is fine; the final answer is not.",
  },
];

/**
 * Lowest rung that could plausibly unstick this student right now: climb one rung per hint
 * already given on the problem, with a one-rung boost when they are visibly thrashing.
 */
export function rungForStudent(student: Pick<StudentSessionState, "hintsForCurrentProblem">, signals?: Pick<StruggleSignals, "incorrectAttempts">): HintRung {
  let level = 1 + student.hintsForCurrentProblem;
  if ((signals?.incorrectAttempts ?? 0) >= 3) level += 1;
  const idx = Math.min(Math.max(level, 1), 5) - 1;
  return HINT_RUNGS[idx];
}

/** Prompt block for the generator. Applies to learning help only — navigation etc. is unaffected. */
export function rungConstraint(rung: HintRung): string {
  return [
    "HINT LADDER (hard constraint whenever you give learning help; ignore for navigation/administrative/accessibility requests):",
    `You are on rung ${rung.rung} of 5 — ${rung.name}. ${rung.constraint}`,
    "Higher rungs come later, only if the student stays stuck after this hint.",
    "NEVER state the final answer to a problem or quiz question, at any rung, in digits or words — even if the student asks directly, begs, or claims to give up. Offer the next rung instead.",
  ].join("\n");
}

/** Final answer values (as strings) for a detected problem, for the leak check. */
export function finalAnswersFor(problem: DetectedProblem): string[] {
  if (problem.kind !== "linear-equation") return [];
  const raw = problem.op === "+" ? (problem.c - problem.b) / problem.a : (problem.c + problem.b) / problem.a;
  if (!Number.isFinite(raw)) return [];
  const rounded = Math.round(raw * 1000) / 1000;
  return [String(rounded)];
}

/**
 * Does the text state a final answer? Value-anchored on purpose: problem constants may appear in
 * a legitimate hint ("subtract 5 from both sides" when the answer happens to be 5), so only an
 * equality tied to the unknown/answer — or the bare value as the entire message — counts.
 */
const ANSWER_EQUALITY_RE = /(?:\bx\b|\banswer\b|\bsolution\b|\bresult\b|\bit\b)[^a-z0-9\n]{0,6}(?:is|=|equals?|:)\s*(-?\d+(?:\.\d+)?)/gi;

const AFFIRMATION_RE = /^\s*(?:yes|yep|yeah|yup|correct|right|exactly|that's (?:right|it|correct)|you got it)\b/i;

export function leakedAnswer(text: string, finalAnswers: string[], opts: { utterance?: string } = {}): { leaked: boolean; matched?: string } {
  if (!text || !finalAnswers.length) return { leaked: false };
  // Worded answers (from the step planner): the whole answer phrase appearing verbatim is a leak.
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const said = ` ${norm(text)} `;
  const phrase = finalAnswers.filter((a) => !Number.isFinite(Number(a)) && norm(a).length >= 4).find((a) => said.includes(` ${norm(a)} `));
  if (phrase) return { leaked: true, matched: phrase };
  const targets = finalAnswers.map(Number).filter(Number.isFinite);
  if (!targets.length) return { leaked: false };
  const bare = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[.!]?$/);
  if (bare && targets.some((t) => Math.abs(Number(bare[1]) - t) < 1e-9)) return { leaked: true, matched: bare[1] };
  for (const m of text.matchAll(ANSWER_EQUALITY_RE)) {
    const value = Number(m[1]);
    if (targets.some((t) => Math.abs(value - t) < 1e-9)) return { leaked: true, matched: m[0] };
  }
  // Leak by confirmation: the student guessed the right value and the reply opens by affirming it.
  // ("is it 5?" → "Yes!"). Affirming a WRONG guess isn't possible here (only correct values match),
  // and "not quite" on a wrong guess is normal tutoring, so this stays precise.
  if (opts.utterance && AFFIRMATION_RE.test(text)) {
    for (const m of opts.utterance.matchAll(/-?\d+(?:\.\d+)?/g)) {
      if (targets.some((t) => Math.abs(Number(m[0]) - t) < 1e-9)) return { leaked: true, matched: `affirmed guess "${m[0]}"` };
    }
  }
  return { leaked: false };
}
