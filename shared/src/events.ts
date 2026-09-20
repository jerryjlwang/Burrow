import { applyExtraction, type ApplyContext, type ConceptExtraction } from "./concepts";
import type { KnowledgeGraph, ResolutionMethod, ResourceKind } from "./graph";

/**
 * Everything the learner graph learns arrives as one of these. A tab applies the event to its RAM
 * mirror and forwards the same event to the background, which replays it onto the canonical
 * persisted graph through {@link applyLearnerEvent} — one code path, so the two can't drift.
 */
export type LearnerEvent =
  | { kind: "extraction"; extraction: ConceptExtraction; ctx: ApplyContext; at: number }
  | { kind: "resolve"; concept: string; belief: string; at: number; resolution: { method: ResolutionMethod; rung?: number; note: string } }
  /** A graded attempt (the page marked an answer right or wrong). */
  | { kind: "attempt"; concept: string; correct: boolean; hinted: boolean; at: number }
  /** Ungraded trouble: a step of written working that doesn't check out. */
  | { kind: "struggle"; concept: string; at: number }
  | { kind: "selfCorrection"; concept: string; at: number }
  /** The learner asked about a concept in their own words. */
  | { kind: "ask"; concept: string; at: number }
  | { kind: "offer"; offer: string; outcome: "shown" | "accepted" | "declined" | "dismissed"; key?: string; at: number }
  | { kind: "resource"; concept: string; url: string; title: string; resourceKind: ResourceKind; reason: string; at: number }
  | { kind: "plan"; plan: { key: string; goal: string; steps: Array<{ title: string; concept?: string; query?: string }> }; at: number };

export function applyLearnerEvent(graph: KnowledgeGraph, e: LearnerEvent): void {
  switch (e.kind) {
    case "extraction":
      applyExtraction(graph, e.extraction, e.ctx, e.at);
      return;
    case "resolve":
      graph.resolveMisconception(e.concept, e.belief, e.at, e.resolution);
      return;
    case "attempt":
      graph.recordAttempt(e.concept, e.at, { correct: e.correct, hinted: e.hinted });
      return;
    case "struggle":
      graph.recordStruggle(e.concept, e.at);
      return;
    case "selfCorrection":
      graph.recordSelfCorrection(e.concept, e.at);
      return;
    case "ask":
      graph.recordAsk(e.concept, e.at);
      return;
    case "offer":
      graph.recordOffer(e.offer, e.outcome, e.at, e.key);
      return;
    case "resource":
      graph.recordResource(e.concept, e.at, { url: e.url, title: e.title, kind: e.resourceKind, reason: e.reason });
      return;
    case "plan":
      graph.savePlan(e.plan, e.at);
      return;
  }
}

/** Classify a destination so resource efficacy can be tracked per modality. */
export function resourceKindOf(url: string): ResourceKind {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname;
  } catch {
    return "page";
  }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)vimeo\.com$/.test(host)) return "video";
  if (/(^|\.)khanacademy\.org$/.test(host)) return /\/(e|exercise|quiz|test)\//.test(path) ? "practice" : /\/v\//.test(path) ? "video" : "lesson";
  if (/wikipedia\.org$|britannica\.com$|kiddle\.co$|nationalgeographic\.com$/.test(host)) return "article";
  return "page";
}
