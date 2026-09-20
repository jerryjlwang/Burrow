import type { DetectedProblem } from "./hints";

/**
 * The step-judge: given a problem and the student's written working (one step per line), find
 * WHICH step is wrong — never what the fix is. Verdicts carry only a step index and a coarse
 * category, so they are leak-safe by construction.
 *
 * Deterministic core: a line of algebra that is a valid transformation must still hold at the
 * problem's true solution; the first parsed line that doesn't is the wrong step. This runs
 * locally in the content script — no model, no latency — for every problem shape we can solve
 * ourselves. An LLM judge can sit behind the same output shape for arbitrary math later.
 */

export type StepCategory = "sign" | "arithmetic" | "unknown";

export interface StepVerdict {
  /** 1-based line number in the working. */
  step: number;
  line: string;
  /** true = holds at the solution; false = wrong; null = not parseable as an equation (skipped). */
  ok: boolean | null;
  category?: StepCategory;
}

export interface WorkingJudgement {
  /** false when the problem has no computable solution — the deterministic judge can't help. */
  judged: boolean;
  steps: StepVerdict[];
  /** First step whose equation breaks at the true solution, or null. */
  firstWrongStep: number | null;
  /** The working ends in a correct final answer (e.g. "x = 5"). */
  solved: boolean;
}

/** One side of an equation reduced to coefficient·x + constant. */
interface Linear {
  coef: number;
  konst: number;
}

const TERM_RE = /^\s*([+-]?)\s*(?:(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)?\s*(?:\*\s*)?([a-z])?)\s*/i;

/** Parse a linear expression like "3x + 5", "20 - 5", "15/3", "-x". Returns null if it isn't one. */
export function parseLinearSide(raw: string): Linear | null {
  let s = raw.replace(/−/g, "-").replace(/·/g, "*").trim();
  if (!s) return null;
  const out: Linear = { coef: 0, konst: 0 };
  let first = true;
  while (s.length) {
    const m = s.match(TERM_RE);
    if (!m || m[0].trim() === "") return null;
    const [whole, sign, fracNum, fracDen, num, variable] = m;
    if (!first && sign === "") return null; // terms after the first need an explicit + or -
    const mult = sign === "-" ? -1 : 1;
    if (fracNum !== undefined) {
      const den = Number(fracDen);
      if (den === 0) return null;
      out.konst += (mult * Number(fracNum)) / den;
    } else if (variable !== undefined) {
      out.coef += mult * (num !== undefined ? Number(num) : 1);
    } else if (num !== undefined) {
      out.konst += mult * Number(num);
    } else {
      return null;
    }
    s = s.slice(whole.length);
    first = false;
  }
  return out;
}

interface ParsedLine {
  lhs: Linear;
  rhs: Linear;
}

/** Parse "3x + 5 = 20" style lines; null when the line isn't a single linear equation. */
export function parseWorkingLine(raw: string): ParsedLine | null {
  const parts = raw.split("=");
  if (parts.length !== 2) return null;
  const lhs = parseLinearSide(parts[0]);
  const rhs = parseLinearSide(parts[1]);
  if (!lhs || !rhs) return null;
  return { lhs, rhs };
}

const evalAt = (side: Linear, x: number): number => side.coef * x + side.konst;
const holds = (line: ParsedLine, x: number): boolean => Math.abs(evalAt(line.lhs, x) - evalAt(line.rhs, x)) < 1e-6;

/**
 * A wrong step is a "sign" error when flipping the sign of exactly one term makes it hold —
 * the classic moved-it-without-flipping slip. Anything else is "arithmetic" if both sides are
 * at least linear in form, else "unknown".
 */
function categorize(line: ParsedLine, x: number): StepCategory {
  const variants: ParsedLine[] = [
    { lhs: { ...line.lhs, coef: -line.lhs.coef }, rhs: line.rhs },
    { lhs: { ...line.lhs, konst: -line.lhs.konst }, rhs: line.rhs },
    { lhs: line.lhs, rhs: { ...line.rhs, coef: -line.rhs.coef } },
    { lhs: line.lhs, rhs: { ...line.rhs, konst: -line.rhs.konst } },
  ];
  if (variants.some((v) => holds(v, x))) return "sign";
  return "arithmetic";
}

function solutionOf(problem: DetectedProblem): number | null {
  if (problem.kind !== "linear-equation" || problem.a === 0) return null;
  const x = problem.op === "+" ? (problem.c - problem.b) / problem.a : (problem.c + problem.b) / problem.a;
  return Number.isFinite(x) ? x : null;
}

/** Judge the student's working against the problem's true solution. */
export function judgeWorking(problem: DetectedProblem, working: string): WorkingJudgement {
  const x = solutionOf(problem);
  const lines = working
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (x === null) return { judged: false, steps: [], firstWrongStep: null, solved: false };
  const steps: StepVerdict[] = [];
  let firstWrongStep: number | null = null;
  let solved = false;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseWorkingLine(lines[i]);
    if (!parsed) {
      steps.push({ step: i + 1, line: lines[i], ok: null });
      continue;
    }
    const ok = holds(parsed, x);
    const verdict: StepVerdict = { step: i + 1, line: lines[i], ok };
    if (!ok) {
      verdict.category = categorize(parsed, x);
      if (firstWrongStep === null) firstWrongStep = i + 1;
    } else if (parsed.lhs.coef === 1 && parsed.lhs.konst === 0 && parsed.rhs.coef === 0) {
      // "x = <value>" and it holds → they landed the solution.
      solved = true;
    }
    steps.push(verdict);
  }
  return { judged: true, steps, firstWrongStep, solved };
}
