import type { KnowledgeGraph, LearningPlan, ResourceKind } from "./graph";
import { MASTERY, slugify } from "./graph";
import { diagnose, preferredModality } from "./diagnostics";

/**
 * The path consumer: turn the learner graph into "what should this kid do next" — and make the
 * answer something the rabbit can DO, not just say. Moves, in priority order:
 *  - prerequisite: the current page leans on something they've never really held — shore it up first.
 *  - reconcile: they just missed questions on a concept (or a misconception came back after a
 *    Socratic fix) — take them to a resource that clears it up.
 *  - revisit: an unresolved misconception elsewhere — circle back while momentum is up.
 *  - plan: the next open step of a learning plan they asked for.
 *  - review: a once-held concept whose retention has decayed — a quick retrieval check.
 *  - advance: current ground is solid — the weakest related concept is the natural next step.
 *  - explore: nothing is pressing — follow what they keep coming back to.
 * Pure and deterministic; the engine decides WHEN to offer, this decides WHAT. A suggestion with a
 * `resource` carries a playbook in its goal, so accepting it runs look_up → open_tab → pick the
 * lesson, instead of ending in a sentence that names a website.
 */
export type PathKind = "prerequisite" | "reconcile" | "revisit" | "plan" | "review" | "advance" | "explore";

export interface ResourcePlan {
  query: string;
  prefer: ResourceKind;
}

export interface PathSuggestion {
  kind: PathKind;
  conceptId: string;
  conceptLabel: string;
  /** Bubble offer text. Never contains answers — it names topics, not content. */
  message: string;
  /** Loop goal when the learner accepts. */
  goal: string;
  /** One internal sentence for logs. */
  reason: string;
  /** What to fetch and open on accept; absent for purely conversational moves. */
  resource?: ResourcePlan;
}

export interface SuggestOptions {
  /** Concepts the learner is looking at right now (most salient first). */
  currentConceptIds?: string[];
  /** Restrict to these kinds (e.g. page-arrive wants only "prerequisite"). */
  kinds?: PathKind[];
  /** Concepts they got wrong in the practice they just finished, worst first. */
  sessionMisses?: string[];
  now?: number;
}

/** The same suggestion (kind:concept) isn't repeated inside this window, across tabs and sessions. */
export const RESUGGEST_MS = 20 * 3_600_000;
const EXPLORE_MIN_CURIOSITY = 2;
/** After a plan step's resource is opened, give them time with it before offering the next step. */
export const PLAN_STEP_GAP_MS = 10 * 60_000;

const SOCRATIC = "Guide Socratically: questions and small observations, never the final answer to any problem.";

const DEFAULT_MODALITY: Record<PathKind, ResourceKind> = {
  prerequisite: "lesson",
  reconcile: "video",
  revisit: "video",
  plan: "lesson",
  review: "lesson",
  advance: "lesson",
  explore: "video",
};

export function suggestionKey(s: Pick<PathSuggestion, "kind" | "conceptId">): string {
  return `${s.kind}:${s.conceptId}`;
}

/** The accept-goal's action script. Spelled out step by step so any agent (LLM or mock) can run it. */
export function resourcePlaybook(resource: ResourcePlan): string {
  return [
    `Make this actionable — take them there, don't just name a site:`,
    `(1) look_up "${resource.query}".`,
    `(2) From LOOKUP RESULTS pick the ONE best fit for a young learner, preferring a ${resource.prefer}; open_tab it with done:false and say in one sentence why you picked it.`,
    `(3) When you resume on the new tab: if it shows search results, click the most relevant ${resource.prefer}; once the actual ${resource.prefer} is showing, finish with one thing to look out for in it.`,
  ].join(" ");
}

/**
 * The move for one step of a learning plan. Shared by the ambient "ready for step N?" offer and a
 * tap on that step in the plan map, so both run the identical playbook.
 */
export function planStepSuggestion(graph: KnowledgeGraph, plan: LearningPlan, index: number, prefer: ResourceKind = DEFAULT_MODALITY.plan): PathSuggestion | null {
  const step = plan.steps[index];
  if (!step) return null;
  const conceptLabel = step.concept ?? step.title;
  const resource: ResourcePlan = { query: step.query ?? `${conceptLabel} for kids`, prefer };
  return {
    kind: "plan",
    conceptId: graph.resolve(conceptLabel) ?? slugify(conceptLabel),
    conceptLabel,
    message: `Ready for step ${index + 1} of your ${plan.goal} plan—${step.title}?`,
    goal: `The student is working through their learning plan "${plan.goal}" and chose step ${index + 1} of ${plan.steps.length}: "${step.title}". ${resourcePlaybook(resource)}`,
    reason: `step ${index + 1} of plan ${plan.key}`,
    resource,
  };
}

export function suggestNext(graph: KnowledgeGraph, opts: SuggestOptions = {}): PathSuggestion | null {
  const current = opts.currentConceptIds ?? [];
  const now = opts.now ?? Date.now();
  const allowed = (k: PathKind) => !opts.kinds || opts.kinds.includes(k);
  const fresh = (kind: PathKind, conceptId: string) => now - graph.lastSuggestedAt(suggestionKey({ kind, conceptId })) >= RESUGGEST_MS;
  const diagnostics = diagnose(graph, now);
  const proven = preferredModality(diagnostics);
  const resourceFor = (kind: PathKind, query: string): ResourcePlan => ({ query, prefer: proven ?? DEFAULT_MODALITY[kind] });

  if (allowed("prerequisite")) {
    for (const id of current) {
      const gaps = graph.unseenPrerequisites(id).filter((n) => fresh("prerequisite", n.id));
      if (gaps.length) {
        const weakest = gaps.reduce((a, b) => (a.state.mastery <= b.state.mastery ? a : b));
        const here = graph.get(id)?.label ?? id;
        const resource = resourceFor("prerequisite", `${weakest.label} introduction`);
        return {
          kind: "prerequisite",
          conceptId: weakest.id,
          conceptLabel: weakest.label,
          message: `This leans on ${weakest.label}, which we haven't really touched. Want a quick look at that first?`,
          goal: `The student accepted a quick detour into the prerequisite "${weakest.label}" before continuing with "${here}". Give a compact, friendly grounding in ${weakest.label} as it applies here. ${SOCRATIC} If one short explanation isn't enough, ${resourcePlaybook(resource)}`,
          reason: `unseen prerequisite of ${id}`,
          resource,
        };
      }
    }
  }

  if (allowed("reconcile")) {
    const missed = (opts.sessionMisses ?? []).map((id) => graph.get(id)).find((n) => n && fresh("reconcile", n.id));
    const recurring = graph.activeMisconceptions().find((m) => m.status === "recurring" && fresh("reconcile", m.concept));
    const target = missed ?? (recurring ? graph.get(recurring.concept) : null);
    if (target) {
      const resource = resourceFor("reconcile", `${target.label} explained`);
      const why = missed
        ? `The student just finished practice where they missed questions on "${target.label}".`
        : `The student's misconception on "${target.label}" ("${recurring!.belief}") came back after an earlier fix, so another round of questions alone won't do.`;
      return {
        kind: "reconcile",
        conceptId: target.id,
        conceptLabel: target.label,
        message: missed
          ? `A couple of those on ${target.label} were slippery. Want me to find a short ${resource.prefer} that clears it up?`
          : `${target.label} keeps tripping us up. Want me to find a ${resource.prefer} that shows what's really going on?`,
        goal: `${why} ${resourcePlaybook(resource)} Never state the answers to the questions they missed.`,
        reason: missed ? `missed attempts on ${target.id} this session` : `recurring misconception on ${target.id}`,
        resource,
      };
    }
  }

  if (allowed("revisit")) {
    const open = graph.activeMisconceptions().filter((m) => !current.includes(m.concept) && fresh("revisit", m.concept));
    if (open.length) {
      const m = open[0];
      const label = graph.get(m.concept)?.label ?? m.concept;
      return {
        kind: "revisit",
        conceptId: m.concept,
        conceptLabel: label,
        message: `While you're on a roll—want to circle back to ${label}? We left an idea there untested.`,
        goal: `The student agreed to revisit "${label}", where they showed the misconception: "${m.belief}". Help them test that belief. ${SOCRATIC} Do not state the correct explanation outright.`,
        reason: `active misconception on ${m.concept}`,
      };
    }
  }

  if (allowed("plan")) {
    const plan = graph.activePlan();
    const index = plan ? plan.steps.findIndex((s) => !s.done) : -1;
    if (plan && index >= 0 && now - plan.updatedAt >= (index === 0 ? 0 : PLAN_STEP_GAP_MS)) {
      const suggestion = planStepSuggestion(graph, plan, index, proven ?? DEFAULT_MODALITY.plan);
      if (suggestion && fresh("plan", suggestion.conceptId)) return suggestion;
    }
  }

  if (allowed("review")) {
    const due = diagnostics.dueForReview.find((c) => !current.includes(c.id) && fresh("review", c.id));
    if (due) {
      const resource = resourceFor("review", `${due.label} refresher`);
      return {
        kind: "review",
        conceptId: due.id,
        conceptLabel: due.label,
        message: `It's been a while since ${due.label}. Want to see how much stuck?`,
        goal: `The student agreed to a quick memory check on "${due.label}", which they held before but haven't seen for a while. Ask ONE question they must answer from memory. If they retrieve it, celebrate briefly and stop. If they can't, don't re-teach yourself: ${resourcePlaybook(resource)}`,
        reason: `retention ${due.retention.toFixed(2)} of mastery ${due.mastery.toFixed(2)}`,
        resource,
      };
    }
  }

  if (allowed("advance")) {
    for (const id of current) {
      const node = graph.get(id);
      if (!node || node.state.mastery < 0.5) continue;
      const next = graph
        .related(id)
        .filter((n) => n.state.mastery < MASTERY.unseenThreshold + 0.2 && fresh("advance", n.id))
        .sort((a, b) => a.state.mastery - b.state.mastery)[0];
      if (next) {
        const resource = resourceFor("advance", `${next.label} introduction`);
        return {
          kind: "advance",
          conceptId: next.id,
          conceptLabel: next.label,
          message: `Feeling solid on ${node.label}? ${next.label} builds right on it—want me to pull up a ${resource.prefer}?`,
          goal: `The student finished work on "${node.label}" and agreed to move on to "${next.label}". ${resourcePlaybook(resource)}`,
          reason: `advance from ${id} to weakest related`,
          resource,
        };
      }
    }
  }

  if (allowed("explore")) {
    const interest = diagnostics.interests.find((c) => c.curiosity >= EXPLORE_MIN_CURIOSITY && !current.includes(c.id));
    if (interest) {
      // Prefer the unexplored neighbour of what they love; failing that, go deeper on the thing itself.
      const neighbour = graph.related(interest.id).find((n) => n.state.mastery < 0.5 && !current.includes(n.id));
      const target = neighbour ?? graph.get(interest.id)!;
      if (fresh("explore", target.id)) {
        const resource = resourceFor("explore", neighbour ? `${neighbour.label} for kids` : `amazing facts about ${interest.label}`);
        return {
          kind: "explore",
          conceptId: target.id,
          conceptLabel: target.label,
          message: neighbour
            ? `You keep coming back to ${interest.label}. ${neighbour.label} is part of the same story—want to see?`
            : `You keep coming back to ${interest.label}. Want me to find something new about it?`,
          goal: `The student keeps returning to "${interest.label}" out of their own curiosity and agreed to explore ${neighbour ? `the connected idea "${neighbour.label}"` : "it further"}. This is for fun: no quizzing. ${resourcePlaybook(resource)}`,
          reason: `curiosity ${interest.curiosity.toFixed(1)} on ${interest.id}`,
          resource,
        };
      }
    }
  }

  return null;
}
