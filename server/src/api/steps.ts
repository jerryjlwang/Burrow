import { parsePlan, scaffoldPlan, topicPlanKey, type StepPlan } from "@shared/plan";
import { parseJudgement, splitWorking, type WorkingJudgement } from "@shared/steps";
import type { OpenAIProvider } from "../agent/openai";
import { log } from "../util/logger";

const logger = log("steps");

export interface PlanRequest {
  /** Stable key of the problem (the client's problemKey); ignored for topic plans. */
  key?: string;
  /** Topic plans: what the student wants to learn. Absent → plan the problem on the page. */
  topic?: string;
  url?: string;
  title?: string;
  headings?: string[];
  text?: string;
}

export interface JudgeRequest {
  plan: StepPlan;
  /** Page text around the problem, so the judge sees the actual question. */
  text?: string;
  working: string;
}

const PROBLEM_PLANNER_PROMPT = `You plan the route through the problem a student is looking at in their browser. It can be ANY subject: maths, science, grammar, history, coding, reading comprehension.

Return:
- found: false if the page shows no problem or question for the student to work (then steps: [], finalAnswers: []).
- goal: the problem restated in one short sentence.
- steps: 2-6 ordered moves that solve it. Each title says what to DO ("Find a common denominator"), NEVER the result of doing it — a student may see these. concept is the curriculum idea the step exercises (canonical name, e.g. "Equivalent fractions"). query is null.
- finalAnswers: the final answer(s) in the shortest form a tutor might blurt out (e.g. "5", "x = 5", "photosynthesis"). These are used ONLY by a server-side leak filter and are never shown. [] if the problem is open-ended.`;

const TOPIC_PLANNER_PROMPT = `A young student wants to learn about a topic. Build a short learning plan that a browser companion will walk them through over several sessions by opening real lessons and videos.

Return found: true, goal: the topic in a few words, finalAnswers: [], and steps: 3-6 ordered steps from foundations to the interesting parts. Each step has a kid-friendly title (what they'll find out), a canonical concept name, and query: a short search query that would find a good Khan Academy lesson or kid-friendly video for that step.`;

const JUDGE_PROMPT = `You check a student's written working against the plan for a problem. The working is numbered, one line per step. You locate errors; you never correct them.

Return:
- judged: false if the working is not an attempt at this problem (then steps: [], solved: false, planStep: 0).
- steps: one entry per numbered line: ok true if the line follows validly from the problem and the lines before it, false if it is wrong, null if it is not a step at all (a note, a restatement, an unfinished line still being typed). For a wrong line give category: "sign" (a sign or direction flipped), "arithmetic" (a calculation slip), "reasoning" (wrong method, rule or claim), else "unknown". For other lines category is null.
- solved: true only if the working reaches a correct final answer.
- planStep: how many steps of the plan the working has completed correctly (0 if none).
Judge only what is written. A line that is merely incomplete is null, not false.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    goal: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, concept: nullable({ type: "string" }), query: nullable({ type: "string" }) },
        required: ["title", "concept", "query"],
        additionalProperties: false,
      },
    },
    finalAnswers: { type: "array", items: { type: "string" } },
  },
  required: ["found", "goal", "steps", "finalAnswers"],
  additionalProperties: false,
} as const;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    judged: { type: "boolean" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          step: { type: "integer" },
          ok: nullable({ type: "boolean" }),
          category: nullable({ type: "string", enum: ["sign", "arithmetic", "reasoning", "unknown"] }),
        },
        required: ["step", "ok", "category"],
        additionalProperties: false,
      },
    },
    solved: { type: "boolean" },
    planStep: { type: "integer" },
  },
  required: ["judged", "steps", "solved", "planStep"],
  additionalProperties: false,
} as const;

interface RawPlan {
  found: boolean;
  goal: string;
  steps: Array<{ title: string; concept: string | null; query: string | null }>;
  finalAnswers: string[];
}

/** Bounded insertion-ordered cache; a re-set key moves to the fresh end. */
class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

function topicScaffold(topic: string): StepPlan {
  return {
    key: topicPlanKey(topic),
    kind: "topic",
    goal: topic,
    steps: [
      { title: `Get the big picture of ${topic}`, concept: topic, query: `${topic} for kids` },
      { title: `See ${topic} in action, with examples`, concept: `${topic} in action`, query: `${topic} explained with examples` },
      { title: `Try some questions on ${topic}`, concept: `${topic} practice`, query: `${topic} practice questions` },
    ],
    source: "scaffold",
  };
}

const NO_JUDGEMENT: WorkingJudgement = { judged: false, steps: [], firstWrongStep: null, solved: false, planStep: null };

/**
 * Plans and judges for problems the local deterministic judge can't handle. Same
 * degrade-to-deterministic pattern as the agent and extractor: no LLM → scaffold plans, no judging.
 * Final answers the planner derives stay in this process, feeding only the hint leak filter.
 */
export class StepService {
  private plans = new Lru<{ plan: StepPlan | null; finalAnswers: string[] }>(200);
  private judgements = new Lru<WorkingJudgement>(200);

  constructor(private llm: OpenAIProvider | null) {}

  /** Final answers for a planned problem, for the leak filter. Empty when unknown. */
  answersFor(key: string | undefined): string[] {
    return key ? this.plans.get(key)?.finalAnswers ?? [] : [];
  }

  async plan(req: PlanRequest): Promise<StepPlan | null> {
    const topic = req.topic?.trim().slice(0, 120);
    const key = topic ? topicPlanKey(topic) : req.key ?? `page:${req.url ?? ""}`;
    const cached = this.plans.get(key);
    if (cached) return cached.plan;
    const goal = topic ?? req.title ?? "this problem";
    const fallback = topic ? topicScaffold(topic) : scaffoldPlan(key, goal);
    if (!this.llm) return fallback;
    try {
      const user = topic
        ? `TOPIC: ${topic}`
        : [`URL: ${req.url ?? ""}`, `TITLE: ${req.title ?? ""}`, req.headings?.length ? `HEADINGS: ${req.headings.slice(0, 12).join(" | ")}` : "", `PAGE TEXT:\n${(req.text ?? "").slice(0, 3000)}`].filter(Boolean).join("\n");
      const raw = await this.llm.complete<RawPlan>(topic ? TOPIC_PLANNER_PROMPT : PROBLEM_PLANNER_PROMPT, [{ type: "text", text: user }], "step_plan", PLAN_SCHEMA as unknown as Record<string, unknown>, 900, "low");
      const plan = raw.found ? parsePlan({ ...raw, key, kind: topic ? "topic" : "problem", source: "llm", steps: raw.steps.map((s) => ({ title: s.title, concept: s.concept ?? undefined, query: s.query ?? undefined })) }, { key, source: "llm" }) : null;
      const finalAnswers = (raw.finalAnswers ?? []).filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim().slice(0, 80)).slice(0, 4);
      this.plans.set(key, { plan, finalAnswers });
      logger.info("plan", { key: key.slice(0, 80), kind: plan?.kind ?? "none", steps: plan?.steps.length ?? 0 });
      return plan;
    } catch (e) {
      logger.warn("planner failed; using scaffold", { error: e instanceof Error ? e.message : String(e) });
      return fallback;
    }
  }

  async judge(req: JudgeRequest): Promise<WorkingJudgement> {
    const lines = splitWorking(req.working).slice(0, 30);
    if (!this.llm || !lines.length) return NO_JUDGEMENT;
    const cacheKey = `${req.plan.key}\n${lines.join("\n")}`;
    const cached = this.judgements.get(cacheKey);
    if (cached) return cached;
    try {
      const user = [
        `PROBLEM: ${req.plan.goal}`,
        req.text ? `PAGE TEXT:\n${req.text.slice(0, 2000)}` : "",
        `PLAN:\n${req.plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join("\n")}`,
        `STUDENT'S WORKING:\n${lines.map((l, i) => `${i + 1}. ${l.slice(0, 300)}`).join("\n")}`,
      ].filter(Boolean).join("\n\n");
      const raw = await this.llm.complete<unknown>(JUDGE_PROMPT, [{ type: "text", text: user }], "working_judgement", JUDGE_SCHEMA as unknown as Record<string, unknown>, 700, "low");
      const judgement = parseJudgement(raw, lines.join("\n"), req.plan.steps.length);
      this.judgements.set(cacheKey, judgement);
      logger.info("judge", { key: req.plan.key.slice(0, 80), lines: lines.length, firstWrongStep: judgement.firstWrongStep, planStep: judgement.planStep });
      return judgement;
    } catch (e) {
      logger.warn("judge failed", { error: e instanceof Error ? e.message : String(e) });
      return NO_JUDGEMENT;
    }
  }
}
