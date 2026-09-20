import { z } from "zod";

/**
 * The learner knowledge graph: the shared spine of both pillars.
 *
 *  - Reactive PRODUCES it: the background concept-extraction loop turns pages the learner
 *    sees into concept nodes, prerequisite/related edges and per-node learner state.
 *  - Reactive CONSUMES it for grounding: `recentExposures` lets an answer say
 *    "remember the orbit video from ten minutes ago?" because the graph knows what was seen.
 *  - Proactive CONSUMES it for detection: `unseenPrerequisites` fires when a page's concepts
 *    depend on things this learner has never met.
 *
 * The graph is pure (no DOM, no chrome APIs) so it lives in shared/ and is unit-testable in
 * node. Persistence is pluggable behind {@link GraphStore}: content-script RAM today, the
 * background service worker + chrome.storage tomorrow — the graph logic never changes.
 */

export type SourceKind = "page" | "video" | "query" | "selection" | "hint" | "answer";

export interface ConceptSource {
  url: string;
  title: string;
  at: number;
  kind: SourceKind;
  /** Short human anchor for grounding, e.g. the video title or the sentence a concept came from. */
  snippet?: string;
}

export interface LearnerConceptState {
  firstSeenAt: number;
  lastSeenAt: number;
  /** Times the concept was encountered (passive exposure). */
  exposures: number;
  /** Accumulated attention on the concept, ms. */
  dwellMs: number;
  /** Times the learner explicitly asked about it. */
  asks: number;
  /** Struggle events tied to this concept (wrong attempts, stalls, misconceptions). */
  struggles: number;
  /** Running mastery estimate in [0,1]. Heuristic, not psychometric — see MASTERY. */
  mastery: number;
}

export type EdgeType = "prerequisite" | "related";

export interface ConceptEdge {
  /** For "prerequisite", `from` must be understood before `to` (from → to). */
  from: string;
  to: string;
  type: EdgeType;
  /** Confidence/strength of the link in [0,1]. */
  weight: number;
}

/** How a misconception got resolved — the trace we call back to next time. */
export type ResolutionMethod = "self" | "hint" | "resource" | "peer" | "unknown";

export interface MisconceptionResolution {
  at: number;
  method: ResolutionMethod;
  /** Hint rung that worked, if resolved via a hint — feeds the rung-choice bandit later. */
  rung?: number;
  /** The thing that unstuck them, in plain words. This is what a future callback references. */
  note: string;
}

/** active = open · resolved = fixed and quiet since · recurring = fixed but came back (a stronger signal). */
export type MisconceptionStatus = "active" | "resolved" | "recurring";

/** A durable wrong belief the learner held, and how (if) they got past it. */
export interface Misconception {
  /** Stable slug of the belief. */
  id: string;
  /** Concept node id this attaches to. */
  concept: string;
  /** The wrong mental model, in plain words, e.g. "closer to the sun causes summer". */
  belief: string;
  status: MisconceptionStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Times it has surfaced; a resolved one resurfacing bumps this and flips status to recurring. */
  occurrences: number;
  /** What revealed it, e.g. the search query. */
  evidence?: string;
  /** Most recent resolution, if any. */
  resolution?: MisconceptionResolution;
}

export interface ConceptNode {
  /** Stable slug identity; aliases fold into this. */
  id: string;
  label: string;
  aliases: string[];
  domain?: string;
  state: LearnerConceptState;
  /** Most recent sources, capped (ring) so a persisted graph stays bounded. */
  sources: ConceptSource[];
  /** Durable misconceptions on this concept — the "what they got wrong and how they fixed it" memory. */
  misconceptions: Misconception[];
}

export interface GraphSnapshot {
  version: 1;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  updatedAt: number;
}

/** Tunable heuristics for the mastery estimate. Centralized so they are easy to sweep. */
export const MASTERY = {
  /** Passive exposure nudges mastery up a little. */
  exposureGain: 0.15,
  /** A confirmed success (got it right, celebrated) moves it up a lot. */
  successGain: 0.4,
  /** A struggle event pulls it down proportionally. */
  struggleDecay: 0.3,
  /** Asking about a concept signals uncertainty — a small pull down. */
  askDecay: 0.1,
  /** Below this, a prerequisite counts as "unseen / not yet held". */
  unseenThreshold: 0.3,
} as const;

const CAP = {
  sourcesPerNode: 12,
  /** Hard ceiling on nodes to bound persisted size; LRU-evicted by lastSeenAt on prune(). */
  nodes: 2000,
} as const;

const ConceptSourceSchema = z.object({
  url: z.string(),
  title: z.string(),
  at: z.number(),
  kind: z.enum(["page", "video", "query", "selection", "hint", "answer"]),
  snippet: z.string().optional(),
});

const LearnerConceptStateSchema = z.object({
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  exposures: z.number(),
  dwellMs: z.number(),
  asks: z.number(),
  struggles: z.number(),
  mastery: z.number(),
});

const MisconceptionResolutionSchema = z.object({
  at: z.number(),
  method: z.enum(["self", "hint", "resource", "peer", "unknown"]),
  rung: z.number().optional(),
  note: z.string(),
});

const MisconceptionSchema = z.object({
  id: z.string(),
  concept: z.string(),
  belief: z.string(),
  status: z.enum(["active", "resolved", "recurring"]),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
  occurrences: z.number(),
  evidence: z.string().optional(),
  resolution: MisconceptionResolutionSchema.optional(),
});

const ConceptNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  domain: z.string().optional(),
  state: LearnerConceptStateSchema,
  sources: z.array(ConceptSourceSchema),
  // Optional so a graph persisted before misconceptions still loads; normalized to [] on load.
  misconceptions: z.array(MisconceptionSchema).optional(),
});

const ConceptEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: z.enum(["prerequisite", "related"]),
  weight: z.number(),
});

export const GraphSnapshotSchema = z.object({
  version: z.literal(1),
  nodes: z.array(ConceptNodeSchema),
  edges: z.array(ConceptEdgeSchema),
  updatedAt: z.number(),
});

/** Persistence boundary. Content-script RAM now; background + chrome.storage later. */
export interface GraphStore {
  load(): Promise<GraphSnapshot | null>;
  save(snapshot: GraphSnapshot): Promise<void>;
}

/** Normalize a label to a stable id. Extractors do fuzzy matching; the graph only matches exactly. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Status is derived, never hand-set, so record/resolve/merge/load can't drift out of sync. */
function deriveStatus(m: Misconception): MisconceptionStatus {
  if (!m.resolution) return "active";
  return m.lastSeenAt > m.resolution.at ? "recurring" : "resolved";
}

export interface RecordExposureOpts {
  source?: ConceptSource;
  dwellMs?: number;
  domain?: string;
  aliases?: string[];
}

/**
 * In-memory knowledge graph. Mutating methods keep learner state and edges consistent;
 * {@link toJSON}/{@link fromJSON} cross the persistence boundary with validation so a corrupt
 * or stale persisted blob can never crash a session.
 */
export class KnowledgeGraph {
  private nodes = new Map<string, ConceptNode>();
  /** id -> its concept id, for alias resolution. */
  private aliasIndex = new Map<string, string>();
  private edges: ConceptEdge[] = [];
  private edgeKeys = new Set<string>();

  get size(): number {
    return this.nodes.size;
  }

  /** Resolve a raw label to an existing concept id via slug or a known alias, else null. */
  resolve(label: string): string | null {
    const slug = slugify(label);
    if (this.nodes.has(slug)) return slug;
    return this.aliasIndex.get(slug) ?? null;
  }

  get(id: string): ConceptNode | null {
    return this.nodes.get(id) ?? null;
  }

  /** Create the concept if new; returns it either way. Does not count as an exposure. */
  ensureConcept(label: string, now: number, opts: { domain?: string; aliases?: string[] } = {}): ConceptNode {
    const existing = this.resolve(label);
    if (existing) {
      const node = this.nodes.get(existing)!;
      if (opts.domain && !node.domain) node.domain = opts.domain;
      if (opts.aliases) this.addAliases(node, opts.aliases);
      return node;
    }
    const id = slugify(label) || `c-${this.nodes.size}`;
    const node: ConceptNode = {
      id,
      label: label.trim(),
      aliases: [],
      domain: opts.domain,
      state: { firstSeenAt: now, lastSeenAt: now, exposures: 0, dwellMs: 0, asks: 0, struggles: 0, mastery: 0 },
      sources: [],
      misconceptions: [],
    };
    this.nodes.set(id, node);
    this.aliasIndex.set(id, id);
    if (opts.aliases) this.addAliases(node, opts.aliases);
    return node;
  }

  private addAliases(node: ConceptNode, aliases: string[]): void {
    for (const alias of aliases) {
      const slug = slugify(alias);
      if (!slug || slug === node.id || this.aliasIndex.has(slug)) continue;
      node.aliases.push(alias);
      this.aliasIndex.set(slug, node.id);
    }
  }

  /** The learner encountered a concept. The primary producer signal from the reactive loop. */
  recordExposure(label: string, now: number, opts: RecordExposureOpts = {}): ConceptNode {
    const node = this.ensureConcept(label, now, { domain: opts.domain, aliases: opts.aliases });
    node.state.exposures += 1;
    node.state.lastSeenAt = now;
    node.state.dwellMs += Math.max(0, opts.dwellMs ?? 0);
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.exposureGain);
    if (opts.source) this.pushSource(node, opts.source);
    return node;
  }

  /** The learner asked about a concept — engagement plus a whiff of uncertainty. */
  recordAsk(label: string, now: number, source?: ConceptSource): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.asks += 1;
    node.state.lastSeenAt = now;
    node.state.mastery = clamp01(node.state.mastery - node.state.mastery * MASTERY.askDecay);
    if (source) this.pushSource(node, source);
    return node;
  }

  /** A struggle event tied to a concept (wrong attempt, stall, detected misconception). */
  recordStruggle(label: string, now: number, source?: ConceptSource): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.struggles += 1;
    node.state.lastSeenAt = now;
    node.state.mastery = clamp01(node.state.mastery - node.state.mastery * MASTERY.struggleDecay);
    if (source) this.pushSource(node, source);
    return node;
  }

  /** A confirmed success on a concept (got it right / celebrated). */
  recordSuccess(label: string, now: number): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.lastSeenAt = now;
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.successGain);
    return node;
  }

  /**
   * A wrong belief surfaced on a concept. New → active; a previously resolved one resurfacing →
   * recurring (a stronger signal). Also counts as a struggle on the concept.
   */
  recordMisconception(conceptLabel: string, belief: string, now: number, opts: { evidence?: string; source?: ConceptSource } = {}): Misconception {
    const node = this.ensureConcept(conceptLabel, now);
    const id = slugify(belief) || `m-${node.misconceptions.length}`;
    let m = node.misconceptions.find((x) => x.id === id);
    if (!m) {
      m = { id, concept: node.id, belief: belief.trim(), status: "active", firstSeenAt: now, lastSeenAt: now, occurrences: 1, evidence: opts.evidence };
      node.misconceptions.push(m);
    } else {
      m.occurrences += 1;
      m.lastSeenAt = now;
      if (opts.evidence) m.evidence = opts.evidence;
    }
    m.status = deriveStatus(m);
    node.state.struggles += 1;
    node.state.lastSeenAt = now;
    node.state.mastery = clamp01(node.state.mastery - node.state.mastery * MASTERY.struggleDecay);
    if (opts.source) this.pushSource(node, opts.source);
    return m;
  }

  /**
   * Record how a misconception got fixed — the trace a future callback references
   * ("remember how you worked it out last time?"). No-op if the concept/belief is unknown.
   */
  resolveMisconception(conceptLabel: string, belief: string, now: number, resolution: { method: ResolutionMethod; rung?: number; note: string }): Misconception | null {
    const cid = this.resolve(conceptLabel);
    if (!cid) return null;
    const node = this.nodes.get(cid)!;
    const m = node.misconceptions.find((x) => x.id === slugify(belief));
    if (!m) return null;
    m.lastSeenAt = now;
    m.resolution = { at: now, method: resolution.method, rung: resolution.rung, note: resolution.note.trim() };
    m.status = deriveStatus(m);
    node.state.lastSeenAt = now;
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.successGain);
    return m;
  }

  /** Open misconceptions (active or recurring) across all concepts, most recent first — proactive targeting. */
  activeMisconceptions(limit = 10): Misconception[] {
    const out: Misconception[] = [];
    for (const n of this.nodes.values()) for (const m of n.misconceptions) if (m.status !== "resolved") out.push(m);
    return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, limit);
  }

  /**
   * A past misconception on this concept that carries a resolution we can call back to. Prefers
   * ones the learner fixed themselves (self-efficacy), then most recent. null if none — the caller
   * should stay silent rather than invent a memory.
   */
  misconceptionCallback(conceptLabel: string): Misconception | null {
    const cid = this.resolve(conceptLabel);
    if (!cid) return null;
    const node = this.nodes.get(cid);
    if (!node) return null;
    const withNote = node.misconceptions.filter((m) => m.resolution?.note);
    withNote.sort((a, b) => {
      const sa = a.resolution!.method === "self" ? 0 : 1;
      const sb = b.resolution!.method === "self" ? 0 : 1;
      return sa - sb || b.resolution!.at - a.resolution!.at;
    });
    return withNote[0] ?? null;
  }

  private pushSource(node: ConceptNode, source: ConceptSource): void {
    node.sources.push(source);
    if (node.sources.length > CAP.sourcesPerNode) node.sources.splice(0, node.sources.length - CAP.sourcesPerNode);
  }

  /** Link two concepts. Labels are resolved/created; the stronger weight wins on repeat. */
  link(fromLabel: string, toLabel: string, type: EdgeType, weight: number, now: number): void {
    const from = this.ensureConcept(fromLabel, now).id;
    const to = this.ensureConcept(toLabel, now).id;
    if (from === to) return;
    const key = `${type}:${from}->${to}`;
    const existing = this.edges.find((e) => e.type === type && e.from === from && e.to === to);
    if (existing) {
      existing.weight = Math.max(existing.weight, clamp01(weight));
      return;
    }
    this.edges.push({ from, to, type, weight: clamp01(weight) });
    this.edgeKeys.add(key);
  }

  /** Direct prerequisites of a concept (things that should be understood first). */
  prerequisitesOf(id: string): ConceptNode[] {
    return this.edges
      .filter((e) => e.type === "prerequisite" && e.to === id)
      .map((e) => this.nodes.get(e.from))
      .filter((n): n is ConceptNode => !!n);
  }

  /**
   * Prerequisites the learner hasn't held yet (mastery below threshold). The core proactive
   * signal: a page whose concepts rest on foundations this learner has never met.
   */
  unseenPrerequisites(id: string, threshold = MASTERY.unseenThreshold): ConceptNode[] {
    return this.prerequisitesOf(id).filter((n) => n.state.mastery < threshold);
  }

  /** Concepts related to a concept, strongest first. */
  related(id: string): ConceptNode[] {
    return this.edges
      .filter((e) => e.type === "related" && (e.from === id || e.to === id))
      .sort((a, b) => b.weight - a.weight)
      .map((e) => this.nodes.get(e.from === id ? e.to : e.from))
      .filter((n): n is ConceptNode => !!n);
  }

  /** Concepts seen within the window, most recent first — the grounding source for reactive answers. */
  recentExposures(withinMs: number, now: number, limit = 10): ConceptNode[] {
    const cutoff = now - withinMs;
    return [...this.nodes.values()]
      .filter((n) => n.state.lastSeenAt >= cutoff && n.state.exposures > 0)
      .sort((a, b) => b.state.lastSeenAt - a.state.lastSeenAt)
      .slice(0, limit);
  }

  /** Concepts the learner has struggled with, worst first — for proactive targeting and reporting. */
  struggling(limit = 10): ConceptNode[] {
    return [...this.nodes.values()]
      .filter((n) => n.state.struggles > 0)
      .sort((a, b) => b.state.struggles - a.state.struggles || a.state.mastery - b.state.mastery)
      .slice(0, limit);
  }

  /** Drop least-recently-seen nodes (and their edges) past the cap. Called before persisting. */
  prune(max: number = CAP.nodes): number {
    if (this.nodes.size <= max) return 0;
    const ordered = [...this.nodes.values()].sort((a, b) => a.state.lastSeenAt - b.state.lastSeenAt);
    const drop = ordered.slice(0, this.nodes.size - max);
    const dropped = new Set(drop.map((n) => n.id));
    for (const n of drop) {
      this.nodes.delete(n.id);
      for (const [alias, target] of this.aliasIndex) if (target === n.id) this.aliasIndex.delete(alias);
    }
    this.edges = this.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to));
    this.rebuildEdgeKeys();
    return dropped.size;
  }

  private rebuildEdgeKeys(): void {
    this.edgeKeys = new Set(this.edges.map((e) => `${e.type}:${e.from}->${e.to}`));
  }

  /**
   * Fold another graph into this one — used to flush a per-session RAM graph into the persisted
   * one. Counts sum, timestamps take the max, mastery takes the exposure-weighted average.
   */
  merge(other: KnowledgeGraph, now: number): void {
    for (const o of other.nodes.values()) {
      const mine = this.nodes.get(o.id);
      if (!mine) {
        this.nodes.set(o.id, structuredClone(o));
        this.aliasIndex.set(o.id, o.id);
        this.addAliases(this.nodes.get(o.id)!, o.aliases);
        continue;
      }
      const a = mine.state;
      const b = o.state;
      const wA = a.exposures + 1;
      const wB = b.exposures + 1;
      a.mastery = clamp01((a.mastery * wA + b.mastery * wB) / (wA + wB));
      a.exposures += b.exposures;
      a.dwellMs += b.dwellMs;
      a.asks += b.asks;
      a.struggles += b.struggles;
      a.firstSeenAt = Math.min(a.firstSeenAt, b.firstSeenAt);
      a.lastSeenAt = Math.max(a.lastSeenAt, b.lastSeenAt);
      for (const s of o.sources) this.pushSource(mine, s);
      this.addAliases(mine, o.aliases);
      this.mergeMisconceptions(mine, o);
    }
    for (const e of other.edges) this.link(e.from, e.to, e.type, e.weight, now);
  }

  private mergeMisconceptions(mine: ConceptNode, other: ConceptNode): void {
    for (const om of other.misconceptions) {
      const mm = mine.misconceptions.find((x) => x.id === om.id);
      if (!mm) {
        mine.misconceptions.push(structuredClone(om));
        continue;
      }
      mm.occurrences += om.occurrences;
      mm.firstSeenAt = Math.min(mm.firstSeenAt, om.firstSeenAt);
      mm.lastSeenAt = Math.max(mm.lastSeenAt, om.lastSeenAt);
      if (om.evidence) mm.evidence = om.evidence;
      if (om.resolution && (!mm.resolution || om.resolution.at > mm.resolution.at)) mm.resolution = structuredClone(om.resolution);
      mm.status = deriveStatus(mm);
    }
  }

  toJSON(): GraphSnapshot {
    return { version: 1, nodes: [...this.nodes.values()], edges: [...this.edges], updatedAt: Date.now() };
  }

  /** Rebuild from a persisted snapshot, tolerating a corrupt/stale blob (returns an empty graph). */
  static fromJSON(raw: unknown): KnowledgeGraph {
    const g = new KnowledgeGraph();
    const parsed = GraphSnapshotSchema.safeParse(raw);
    if (!parsed.success) return g;
    for (const raw of parsed.data.nodes) {
      const misconceptions = (raw.misconceptions ?? []).map((m) => ({ ...m, status: deriveStatus(m) }));
      const node: ConceptNode = { ...raw, misconceptions };
      g.nodes.set(node.id, node);
      g.aliasIndex.set(node.id, node.id);
      for (const alias of node.aliases) g.aliasIndex.set(slugify(alias), node.id);
    }
    g.edges = parsed.data.edges;
    g.rebuildEdgeKeys();
    return g;
  }
}
