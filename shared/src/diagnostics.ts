import type { ConceptNode, KnowledgeGraph, LearnerConceptState, ResourceKind } from "./graph";

/**
 * Learner diagnostics: what the longitudinal graph says about HOW this child learns, not just
 * what they've seen. Pure functions over the graph, so the path consumer, the agent prompt and
 * the parent view all read the same numbers.
 *
 *  - precision: when they commit an answer on a concept, how often it's right (correct / attempts).
 *  - recall: when a concept comes back after time away, how often they retrieve it unaided
 *    (recallSuccesses / recallOpportunities). Precision without recall is cramming.
 *  - retention: a forgetting-curve estimate of how much is still held right now. Stability grows
 *    with every successful retrieval, so well-rehearsed ideas fade slower.
 *  - curiosity: voluntary engagement (their own questions, searches, return visits, dwell), decayed
 *    by recency. Assigned exposure doesn't count — being sent to a page isn't interest.
 */

const DAY_MS = 24 * 3_600_000;

export const DIAGNOSTICS = {
  /** Below this many attempts a rate is noise; report it as unknown instead. */
  minAttempts: 2,
  /** Stability of a never-rehearsed concept, in days; doubles per successful recall. */
  baseStabilityDays: 2,
  maxStabilityDays: 60,
  /** A once-held concept whose retention fell below this is due for a retrieval check. */
  reviewBelow: 0.55,
  /** Only concepts that were actually held are worth reviewing. */
  reviewMinMastery: 0.4,
  curiosityHalfLifeDays: 14,
} as const;

export interface Rate {
  /** null when there isn't enough evidence yet. */
  value: number | null;
  n: number;
}

export interface ConceptDiagnostics {
  id: string;
  label: string;
  domain?: string;
  mastery: number;
  precision: Rate;
  recall: Rate;
  retention: number;
  curiosity: number;
  dueForReview: boolean;
}

export interface ModalityStats {
  kind: ResourceKind;
  opened: number;
  /** Opened resources whose concept got a graded attempt afterwards. */
  settled: number;
  helped: number;
}

export interface HelpProfile {
  offersShown: number;
  /** Accepted / answered offers; null until a few have been answered. */
  acceptance: Rate;
  /** Share of solved problems finished without a hint. */
  independence: Rate;
  selfCorrections: number;
}

export interface LearnerDiagnostics {
  generatedAt: number;
  precision: Rate;
  recall: Rate;
  concepts: ConceptDiagnostics[];
  /** Highest curiosity first. */
  interests: ConceptDiagnostics[];
  /** Interest rolled up by domain, highest first. */
  interestDomains: Array<{ domain: string; score: number }>;
  dueForReview: ConceptDiagnostics[];
  /** High precision, low recall: gets it in the moment, loses it later. */
  fading: ConceptDiagnostics[];
  modalities: ModalityStats[];
  help: HelpProfile;
  /** Learning plans the learner asked for, most recently touched first. */
  plans: Array<{ goal: string; done: number; total: number; next: string | null }>;
}

const rate = (hits: number, n: number, min: number = DIAGNOSTICS.minAttempts): Rate => ({ value: n >= min ? hits / n : null, n });

/** Days this concept survives before retention drops to 1/e. */
function stabilityDays(st: LearnerConceptState): number {
  const rehearsed = DIAGNOSTICS.baseStabilityDays * 2 ** st.recallSuccesses * (0.5 + st.mastery);
  return Math.min(DIAGNOSTICS.maxStabilityDays, rehearsed);
}

export function retention(st: LearnerConceptState, now: number): number {
  const last = Math.max(st.lastSeenAt, st.lastPracticedAt);
  const days = Math.max(0, now - last) / DAY_MS;
  return st.mastery * Math.exp(-days / stabilityDays(st));
}

export function curiosity(st: LearnerConceptState, now: number): number {
  const raw = st.asks + 0.8 * st.voluntary + 0.6 * Math.log2(1 + st.dwellMs / 60_000) + 0.7 * Math.max(0, st.activeDays - 1);
  const days = Math.max(0, now - st.lastSeenAt) / DAY_MS;
  return raw * 0.5 ** (days / DIAGNOSTICS.curiosityHalfLifeDays);
}

export function diagnoseConcept(node: ConceptNode, now: number): ConceptDiagnostics {
  const st = node.state;
  const held = retention(st, now);
  return {
    id: node.id,
    label: node.label,
    domain: node.domain,
    mastery: st.mastery,
    precision: rate(st.correct, st.attempts),
    recall: rate(st.recallSuccesses, st.recallOpportunities, 1),
    retention: held,
    curiosity: curiosity(st, now),
    dueForReview: st.mastery >= DIAGNOSTICS.reviewMinMastery && (st.attempts > 0 || st.exposures >= 2) && held < DIAGNOSTICS.reviewBelow * st.mastery,
  };
}

export function diagnose(graph: KnowledgeGraph, now: number): LearnerDiagnostics {
  const nodes = graph.all();
  const concepts = nodes.map((n) => diagnoseConcept(n, now));
  const sum = (f: (s: LearnerConceptState) => number) => nodes.reduce((t, n) => t + f(n.state), 0);

  const domains = new Map<string, number>();
  for (const c of concepts) if (c.domain && c.curiosity > 0) domains.set(c.domain, (domains.get(c.domain) ?? 0) + c.curiosity);

  const modalities = new Map<ResourceKind, ModalityStats>();
  for (const r of graph.profile.resources) {
    const m = modalities.get(r.kind) ?? { kind: r.kind, opened: 0, settled: 0, helped: 0 };
    m.opened += 1;
    if (r.helped !== null) m.settled += 1;
    if (r.helped) m.helped += 1;
    modalities.set(r.kind, m);
  }

  const offers = Object.values(graph.profile.offers);
  const shown = offers.reduce((t, o) => t + o.shown, 0);
  const accepted = offers.reduce((t, o) => t + o.accepted, 0);
  const answered = accepted + offers.reduce((t, o) => t + o.declined, 0);
  const { unaided, hinted } = graph.profile.solves;

  return {
    generatedAt: now,
    precision: rate(sum((s) => s.correct), sum((s) => s.attempts)),
    recall: rate(sum((s) => s.recallSuccesses), sum((s) => s.recallOpportunities), 1),
    concepts,
    interests: concepts.filter((c) => c.curiosity >= 1).sort((a, b) => b.curiosity - a.curiosity),
    interestDomains: [...domains].map(([domain, score]) => ({ domain, score })).sort((a, b) => b.score - a.score),
    dueForReview: concepts.filter((c) => c.dueForReview).sort((a, b) => a.retention / a.mastery - b.retention / b.mastery),
    fading: concepts.filter((c) => (c.precision.value ?? 0) >= 0.7 && c.recall.value !== null && c.recall.value < 0.5),
    modalities: [...modalities.values()].sort((a, b) => b.opened - a.opened),
    help: {
      offersShown: shown,
      acceptance: rate(accepted, answered, 3),
      independence: rate(unaided, unaided + hinted, 3),
      selfCorrections: sum((s) => s.selfCorrections),
    },
    plans: [...graph.profile.plans]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ goal: p.goal, done: p.steps.filter((s) => s.done).length, total: p.steps.length, next: p.steps.find((s) => !s.done)?.title ?? null })),
  };
}

/**
 * The modality that has actually worked for this learner, once there is evidence; otherwise null
 * and the caller falls back to a sensible default per suggestion kind.
 */
export function preferredModality(d: LearnerDiagnostics): ResourceKind | null {
  const proven = d.modalities.filter((m) => m.settled >= 2 && m.kind !== "page").sort((a, b) => b.helped / b.settled - a.helped / a.settled);
  const best = proven[0];
  return best && best.helped / best.settled >= 0.5 ? best.kind : null;
}

const pct = (r: Rate): string => (r.value === null ? "not enough data" : `${Math.round(r.value * 100)}% (n=${r.n})`);

/** Compact block for the agent prompt, so replies and resource picks fit this learner. */
export function formatDiagnostics(d: LearnerDiagnostics): string | null {
  const lines: string[] = [];
  if (d.precision.n) lines.push(`accuracy when they answer: ${pct(d.precision)}; recall after time away: ${pct(d.recall)}`);
  if (d.interests.length) lines.push(`curious about: ${d.interests.slice(0, 4).map((c) => c.label).join(", ")}`);
  if (d.dueForReview.length) lines.push(`fading, due a quick check: ${d.dueForReview.slice(0, 3).map((c) => c.label).join(", ")}`);
  if (d.fading.length) lines.push(`gets it in the moment but loses it later: ${d.fading.slice(0, 3).map((c) => c.label).join(", ")}`);
  const modality = preferredModality(d);
  if (modality) lines.push(`resources that have worked for them: ${modality}s`);
  if (d.help.independence.value !== null) lines.push(`solves without hints ${Math.round(d.help.independence.value * 100)}% of the time; self-corrected ${d.help.selfCorrections}×`);
  for (const p of d.plans.slice(0, 3)) lines.push(`learning plan "${p.goal}": ${p.done}/${p.total} steps done${p.next ? `; next: ${p.next}` : " (finished)"}`);
  if (d.help.acceptance.value !== null) lines.push(`accepts ${Math.round(d.help.acceptance.value * 100)}% of proactive offers`);
  return lines.length ? lines.join("\n") : null;
}
