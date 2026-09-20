import type { PageSummary } from "./types";
import { slugify, type EdgeType, type KnowledgeGraph, type SourceKind } from "./graph";

/**
 * Concept extraction: the reactive PRODUCER. It turns what the learner is looking at — a page,
 * a search query, a selection — into graph mutations (exposures, edges, misconceptions).
 *
 * Two implementations behind one interface, mirroring the repo's mock-first pattern:
 *  - {@link HeuristicConceptExtractor}: deterministic, no model, runs anywhere. It reads concepts
 *    off titles/headings (where learning pages actually name their topic) and matches a small seed
 *    set of classic misconceptions. It intentionally does NOT infer edges — heuristic edges are
 *    noise.
 *  - The LLM extractor (server-side, OpenAI) drops in later behind the same interface and does the
 *    real work: fuzzy concept naming, prerequisite/related edges, and open-ended misconception
 *    detection ("a misconception embedded in a query").
 */

export interface ExtractedConcept {
  label: string;
  aliases?: string[];
  domain?: string;
  /** 0..1 — how central this concept is to what the learner is looking at. */
  salience: number;
}

export interface ExtractedEdge {
  from: string;
  to: string;
  type: EdgeType;
  weight: number;
}

export interface ExtractedMisconception {
  concept: string;
  belief: string;
  /** What revealed it, e.g. the raw query. */
  evidence?: string;
}

export interface ConceptExtraction {
  concepts: ExtractedConcept[];
  edges: ExtractedEdge[];
  misconceptions: ExtractedMisconception[];
  /** Results/feedback pages only: concepts of the questions the page marks as answered wrong. */
  missed?: string[];
}

export interface ExtractionInput {
  url: string;
  title: string;
  headings?: string[];
  /** Body summary (PageSummary.textSummary). */
  text?: string;
  /** A search query the learner typed, if this extraction is for a query. */
  query?: string;
  selection?: string;
}

export interface ConceptExtractor {
  extract(input: ExtractionInput): ConceptExtraction | Promise<ConceptExtraction>;
}

/** Adapter: a live PageSummary → the vendor-neutral extractor input. */
export function pageToExtractionInput(page: PageSummary, extras: { query?: string } = {}): ExtractionInput {
  return {
    url: page.url,
    title: page.title,
    headings: page.headings,
    text: page.textSummary,
    selection: page.selection,
    query: extras.query,
  };
}

const MAX_CONCEPTS = 8;

/** Nav chrome and section boilerplate that look like headings but name no concept. */
const NON_CONCEPT = new Set([
  "home", "next", "previous", "back", "search", "sign in", "log in", "login", "logout", "menu",
  "loading", "submit", "continue", "save", "cancel", "close", "share", "more", "results", "overview",
  "introduction", "summary", "conclusion", "references", "see also", "contents", "navigation",
  "skip to content", "table of contents", "advertisement", "related", "comments", "footer", "header",
]);

/**
 * Classic, well-documented misconceptions as a seed set — a floor, not the real detector. The LLM
 * extractor handles open-ended detection; these give the heuristic path something to catch and make
 * the behaviour testable offline.
 */
const MISCONCEPTION_SEEDS: Array<{ pattern: RegExp; concept: string; belief: string }> = [
  { pattern: /\b(?:summer|hotter|warmer)\b[^.?]*\b(?:sun|earth)\b[^.?]*\b(?:clos|near)/i, concept: "Seasons", belief: "summer happens because Earth is closer to the sun" },
  { pattern: /\b(?:clos|near)\w*\b[^.?]*\bsun\b[^.?]*\b(?:summer|hot)/i, concept: "Seasons", belief: "summer happens because Earth is closer to the sun" },
  { pattern: /\bheav\w+\b[^.?]*\b(?:fall|drop)\w*\b[^.?]*\b(?:faster|first|quicker)/i, concept: "Gravity", belief: "heavier objects fall faster than lighter ones" },
  { pattern: /\b(?:moon\s*phases?)\b[^.?]*\b(?:earth'?s?\s*shadow|shadow)/i, concept: "Moon phases", belief: "moon phases are caused by Earth's shadow" },
  { pattern: /\bevolution\b[^.?]*\b(?:just|only)\b[^.?]*\btheory\b/i, concept: "Evolution", belief: "evolution is 'just a theory' with no evidence" },
  { pattern: /\b(?:only|just)\b[^.?]*\b(?:10|ten)\s*%[^.?]*\bbrain/i, concept: "Neuroscience", belief: "humans only use 10% of their brain" },
];

/** Strip site suffix, leading numbering and trailing punctuation from a heading/title. */
function cleanPhrase(raw: string): string {
  let s = raw.split(/\s[|·–—-]\s/)[0] ?? raw; // drop "· Khan Academy" / " | MDN" style suffixes
  s = s.replace(/^\s*(?:step\s*)?\d+\s*[.):]\s*/i, ""); // leading "3. " / "Step 2: "
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[?.!:;,]+$/g, "").trim();
  return s;
}

function isConcepty(label: string): boolean {
  if (label.length < 3 || label.length > 60) return false;
  if (!/[a-z]/i.test(label)) return false; // needs a letter, not pure numbers/symbols
  if (NON_CONCEPT.has(label.toLowerCase())) return false;
  if (label.split(/\s+/).length > 6) return false; // a sentence, not a concept
  return true;
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Deterministic extractor: concepts from titles/headings, misconceptions from the seed set. */
export class HeuristicConceptExtractor implements ConceptExtractor {
  readonly name = "heuristic";

  extract(input: ExtractionInput): ConceptExtraction {
    return {
      concepts: this.concepts(input),
      // Heuristic edge inference is unreliable; leave prerequisite/related links to the LLM extractor.
      edges: [],
      misconceptions: this.misconceptions(input),
    };
  }

  private concepts(input: ExtractionInput): ExtractedConcept[] {
    const out: ExtractedConcept[] = [];
    const seen = new Set<string>();
    const add = (raw: string | undefined, salience: number) => {
      if (!raw) return;
      const label = cleanPhrase(raw);
      if (!isConcepty(label)) return;
      const slug = slugify(label);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      out.push({ label, salience });
    };
    (input.headings ?? []).forEach((h, i) => add(h, clamp(0.9 - i * 0.1, 0.5, 0.9)));
    add(input.title, 0.6);
    return out.slice(0, MAX_CONCEPTS);
  }

  private misconceptions(input: ExtractionInput): ExtractedMisconception[] {
    const evidence = input.query?.trim();
    const haystack = [input.query, input.selection, input.title, input.text].filter(Boolean).join(" \n ");
    if (!haystack) return [];
    const out: ExtractedMisconception[] = [];
    const seen = new Set<string>();
    for (const seed of MISCONCEPTION_SEEDS) {
      if (!seed.pattern.test(haystack)) continue;
      const key = slugify(seed.belief);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ concept: seed.concept, belief: seed.belief, evidence });
    }
    return out;
  }
}

export interface ApplyContext {
  url: string;
  title: string;
  /** How the learner encountered this — "page", "query", "selection", "video". */
  kind: SourceKind;
  /** Attention on this view, split across concepts by salience. */
  dwellMs?: number;
}

export interface ApplySummary {
  concepts: number;
  edges: number;
  misconceptions: number;
}

/**
 * Fold an extraction into the graph: exposures (dwell split by salience), edges, and misconceptions.
 * The single write path from browsing → graph, whether the extraction came from the heuristic or LLM.
 */
export function applyExtraction(graph: KnowledgeGraph, extraction: ConceptExtraction, ctx: ApplyContext, now: number): ApplySummary {
  const totalSalience = extraction.concepts.reduce((s, c) => s + Math.max(0.01, c.salience), 0) || 1;
  for (const c of extraction.concepts) {
    const dwellMs = ctx.dwellMs ? Math.round(ctx.dwellMs * (Math.max(0.01, c.salience) / totalSalience)) : 0;
    graph.recordExposure(c.label, now, {
      aliases: c.aliases,
      domain: c.domain,
      dwellMs,
      source: { url: ctx.url, title: ctx.title, at: now, kind: ctx.kind },
    });
  }
  for (const e of extraction.edges) graph.link(e.from, e.to, e.type, e.weight, now);
  for (const m of extraction.misconceptions) {
    graph.recordMisconception(m.concept, m.belief, now, {
      evidence: m.evidence,
      source: { url: ctx.url, title: ctx.title, at: now, kind: "query" },
    });
  }
  const missed = extraction.missed ?? [];
  if (missed.length && graph.claimGradedPage(ctx.url, missed, now)) for (const label of missed) graph.recordAttempt(label, now, { correct: false });
  return { concepts: extraction.concepts.length, edges: extraction.edges.length, misconceptions: extraction.misconceptions.length };
}
