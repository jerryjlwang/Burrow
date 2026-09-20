import type { KnowledgeGraph } from "./graph";
import { MASTERY } from "./graph";

/**
 * The path consumer: turn the learner graph into "what should this kid do next".
 * Three moves, in priority order:
 *  - prerequisite: the current page leans on something they've never really held — shore it up first.
 *  - revisit: an unresolved (or resurfaced) misconception elsewhere — circle back while momentum is up.
 *  - advance: current ground is solid — the weakest related concept is the natural next step.
 * Pure and deterministic; the engine decides WHEN to offer, this decides WHAT.
 */
export interface PathSuggestion {
  kind: "prerequisite" | "revisit" | "advance";
  conceptId: string;
  conceptLabel: string;
  /** Bubble offer text. Never contains answers — it names topics, not content. */
  message: string;
  /** Loop goal when the learner accepts. */
  goal: string;
  /** One internal sentence for logs. */
  reason: string;
}

export interface SuggestOptions {
  /** Concepts the learner is looking at right now (most salient first). */
  currentConceptIds?: string[];
  /** Restrict to these kinds (e.g. page-arrive wants only "prerequisite"). */
  kinds?: PathSuggestion["kind"][];
}

const SOCRATIC = "Guide Socratically: questions and small observations, never the final answer to any problem.";

export function suggestNext(graph: KnowledgeGraph, opts: SuggestOptions = {}): PathSuggestion | null {
  const current = opts.currentConceptIds ?? [];
  const allowed = (k: PathSuggestion["kind"]) => !opts.kinds || opts.kinds.includes(k);

  if (allowed("prerequisite")) {
    for (const id of current) {
      const gaps = graph.unseenPrerequisites(id);
      if (gaps.length) {
        const weakest = gaps.reduce((a, b) => (a.state.mastery <= b.state.mastery ? a : b));
        const here = graph.get(id)?.label ?? id;
        return {
          kind: "prerequisite",
          conceptId: weakest.id,
          conceptLabel: weakest.label,
          message: `This leans on ${weakest.label}, which we haven't really touched. Want a quick look at that first?`,
          goal: `The student accepted a quick detour into the prerequisite "${weakest.label}" before continuing with "${here}". Give a compact, friendly grounding in ${weakest.label} as it applies here. ${SOCRATIC}`,
          reason: `unseen prerequisite of ${id}`,
        };
      }
    }
  }

  if (allowed("revisit")) {
    const open = graph.activeMisconceptions().filter((m) => !current.includes(m.concept));
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

  if (allowed("advance")) {
    for (const id of current) {
      const node = graph.get(id);
      if (!node || node.state.mastery < 0.5) continue;
      const next = graph
        .related(id)
        .filter((n) => n.state.mastery < MASTERY.unseenThreshold + 0.2)
        .sort((a, b) => a.state.mastery - b.state.mastery)[0];
      if (next) {
        return {
          kind: "advance",
          conceptId: next.id,
          conceptLabel: next.label,
          message: `Feeling solid on ${node.label}? ${next.label} builds right on it—want to try that next?`,
          goal: `The student finished work on "${node.label}" and agreed to move on to "${next.label}". Introduce it briefly and set up a first small exercise or question. ${SOCRATIC}`,
          reason: `advance from ${id} to weakest related`,
        };
      }
    }
  }

  return null;
}
