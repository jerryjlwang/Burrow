import type { DetectedProblem } from "./hints";
import { slugify } from "./graph";

/**
 * Step plans: the ordered route through ANY problem or topic, not just the shapes we can parse.
 *
 *  - kind "problem": the moves that solve the problem on screen. The step-judge grades the
 *    student's working against it and the tutor hints at the step they're on.
 *  - kind "topic": a multi-session route through something they want to learn ("geology"). Each
 *    step names a concept and a resource query, so the path consumer can walk them through it.
 *
 * Step titles say what to DO, never what comes out, so a plan is as leak-safe as a hint.
 * Planners sit behind one shape: deterministic for shapes we can solve locally (zero latency),
 * the server LLM for everything else, and a generic scaffold when neither is available.
 */
export interface PlanStep {
  title: string;
  /** Concept this step exercises — where its struggles and successes land in the graph. */
  concept?: string;
  /** Topic plans: what to look up to learn this step. */
  query?: string;
}

export interface StepPlan {
  key: string;
  kind: "problem" | "topic";
  goal: string;
  steps: PlanStep[];
  source: "deterministic" | "llm" | "scaffold";
}

export const PLAN_LIMITS = { minSteps: 2, maxSteps: 8, titleChars: 140 } as const;

export function topicPlanKey(goal: string): string {
  return `topic:${slugify(goal)}`;
}

/** Zero-latency plan for the one shape the local judge can also solve. */
export function linearPlan(problem: Extract<DetectedProblem, { kind: "linear-equation" }>, key: string): StepPlan {
  const concept = "Linear equations";
  const undo = problem.op === "+" ? "subtracting" : "adding";
  const steps: PlanStep[] = [{ title: `Clear the constant next to the variable by ${undo} the same amount on both sides`, concept }];
  if (Math.abs(problem.a) !== 1) steps.push({ title: "Undo the multiplication on the variable by dividing both sides by its coefficient", concept });
  steps.push({ title: "Check the value by substituting it back into the original equation", concept });
  return { key, kind: "problem", goal: `Solve ${problem.raw}`, steps, source: "deterministic" };
}

/** Offline floor for problems we can't plan: Pólya's four moves apply to anything. */
export function scaffoldPlan(key: string, goal: string): StepPlan {
  return {
    key,
    kind: "problem",
    goal,
    steps: [
      { title: "Say in your own words what the question is asking for" },
      { title: "List what you are given and pick an approach that connects it to what is asked" },
      { title: "Carry the approach out one step at a time, writing each step down" },
      { title: "Check the result against the question: does it answer what was asked, and is it sensible?" },
    ],
    source: "scaffold",
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate model/server output into a StepPlan; null for anything unusable (including "no problem here"). */
export function parsePlan(raw: unknown, fallback: { key: string; source: StepPlan["source"] }): StepPlan | null {
  if (!isObj(raw) || !Array.isArray(raw.steps) || typeof raw.goal !== "string" || !raw.goal.trim()) return null;
  const steps: PlanStep[] = [];
  for (const s of raw.steps) {
    if (!isObj(s) || typeof s.title !== "string" || !s.title.trim()) continue;
    const step: PlanStep = { title: s.title.trim().slice(0, PLAN_LIMITS.titleChars) };
    if (typeof s.concept === "string" && s.concept.trim()) step.concept = s.concept.trim().slice(0, 60);
    if (typeof s.query === "string" && s.query.trim()) step.query = s.query.trim().slice(0, 120);
    steps.push(step);
  }
  if (steps.length < PLAN_LIMITS.minSteps) return null;
  return {
    key: typeof raw.key === "string" && raw.key ? raw.key : fallback.key,
    kind: raw.kind === "topic" ? "topic" : "problem",
    goal: raw.goal.trim().slice(0, 200),
    steps: steps.slice(0, PLAN_LIMITS.maxSteps),
    source: raw.source === "deterministic" || raw.source === "llm" || raw.source === "scaffold" ? raw.source : fallback.source,
  };
}

/** Prompt block: where the student is on the route, so help lands on the step they're actually at. */
export function formatPlan(plan: StepPlan, reachedStep: number | null): string {
  const current = Math.min((reachedStep ?? 0) + 1, plan.steps.length);
  const lines = [`STEP PLAN for "${plan.goal}" (tutor ONE step at a time; the student is on step ${current} of ${plan.steps.length}):`];
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.title}${i + 1 < current ? " ✓" : i + 1 === current ? " ← current" : ""}`));
  lines.push("Hint only at the current step. Never reveal later steps' results or the final answer.");
  return lines.join("\n");
}
