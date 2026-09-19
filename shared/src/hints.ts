import type { PageSummary, StudentSessionState } from "./types";

export type DetectedProblem =
  | { kind: "linear-equation"; a: number; op: "+" | "-"; b: number; c: number; raw: string }
  | { kind: "generic"; question: string | null };

const EQ_RE = /(-?\d*)\s*([a-z])\s*([+\-−])\s*(\d+)\s*=\s*(-?\d+)/i;

/** Finds the educational problem currently on screen (deliberately small: a few common shapes). */
export function detectProblem(page: PageSummary): DetectedProblem {
  const corpus = [page.textSummary, ...page.headings, ...page.elements.map((e) => e.context ?? "")].join("\n");
  const m = corpus.match(EQ_RE);
  if (m) {
    const a = m[1] === "" || m[1] === "-" ? (m[1] === "-" ? -1 : 1) : Number(m[1]);
    const op = m[3] === "-" || m[3] === "−" ? "-" : "+";
    return { kind: "linear-equation", a, op, b: Number(m[4]), c: Number(m[5]), raw: m[0].replace(/\s+/g, " ") };
  }
  const q = corpus.split(/\n|\.\s/).find((line) => /\?\s*$/.test(line.trim()) && line.length < 200);
  return { kind: "generic", question: q ? q.trim() : null };
}

export function problemKey(problem: DetectedProblem, page: PageSummary): string {
  if (problem.kind === "linear-equation") return `eq:${problem.raw}`;
  return `page:${page.url.split("#")[0]}:${problem.question ?? page.title}`;
}

/**
 * Progressive hints: nudge → hint → explanation → worked analogous example → more direct.
 * Never reveals the final answer outright for assessment-like problems.
 */
export function hintFor(problem: DetectedProblem, hintIndex: number, student?: StudentSessionState): string {
  if (problem.kind === "linear-equation") {
    const { a, op, b, c } = problem;
    const undo = op === "+" ? "subtract" : "add";
    const afterB = op === "+" ? c - b : c + b;
    const ladder = [
      `Try getting the ${b} out of the way first. What could you do to both sides?`,
      `You want the ${a === 1 ? "x" : `${a}x`} alone. If you ${undo} ${b} on both sides, what's left on the right?`,
      `After that step you'd have ${a === 1 ? "x" : `${a}x`} = ${afterB}. What undoes multiplying by ${a}?`,
      `Here's a similar one: 2x + 3 = 11. Subtract 3 → 2x = 8, then divide by 2 → x = 4. Try the same moves here.`,
      `Divide both sides by ${a}, then plug your answer back into the original to check it.`,
    ];
    return ladder[Math.min(hintIndex, ladder.length - 1)];
  }
  const ladder = [
    `Let's slow down a step. What is the question actually asking you to find?`,
    `Look at the pieces you're given and name each one. Which one haven't you used yet?`,
    `Try the smallest version of this problem you can imagine. What happens there?`,
    `Write down what you know on one side and what you need on the other. What connects them?`,
    `You're close. Check the last step you did—does the result still make sense with the question?`,
  ];
  const i = Math.min(hintIndex, ladder.length - 1);
  if (student && student.helpPreference === "show" && i === 0) return ladder[1];
  return ladder[i];
}
