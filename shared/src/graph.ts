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
  /** Graded attempts and how many were right — precision is correct / attempts. */
  attempts: number;
  correct: number;
  /** Attempts made with a hint already given on the problem. */
  hinted: number;
  /** First attempts after RECALL.gapMs away from the concept, and how many landed unaided — recall. */
  recallOpportunities: number;
  recallSuccesses: number;
  /** Last graded attempt; 0 = never practiced. */
  lastPracticedAt: number;
  /** Wrong working the learner fixed without help. */
  selfCorrections: number;
  /** Self-initiated engagement (their own questions, searches, accepted explorations) — the curiosity signal. */
  voluntary: number;
  /** Distinct calendar days the concept came up, and the last such day (epoch-day). */
  activeDays: number;
  lastActiveDay: number;
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
  /** Every resolution over time, oldest first, capped — provenance over repeated fixes. */
  resolutionHistory?: MisconceptionResolution[];
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

export interface OfferStats {
  shown: number;
  accepted: number;
  declined: number;
  lastAt: number;
}

export type ResourceKind = "video" | "lesson" | "article" | "practice" | "page";

/** A resource the rabbit took the learner to, and whether the concept landed afterwards. */
export interface ResourceRecord {
  concept: string;
  url: string;
  title: string;
  kind: ResourceKind;
  /** Why it was opened (the path suggestion kind, or "asked"). */
  reason: string;
  at: number;
  /** null until a graded attempt on the concept follows within RESOURCE_CREDIT_MS. */
  helped: boolean | null;
}

/** A multi-session learning plan ("learn about geology") and how far the learner has got. */
export interface LearningPlan {
  key: string;
  goal: string;
  steps: Array<{ title: string; concept?: string; query?: string; done: boolean }>;
  createdAt: number;
  updatedAt: number;
}

/** Learner-level memory that isn't about any one concept: how they take help, what worked. */
export interface LearnerProfile {
  /** Proactive offers by kind (hint, misconception, and each path kind). */
  offers: Record<string, OfferStats>;
  solves: { unaided: number; hinted: number };
  resources: ResourceRecord[];
  /** Recent path suggestions (kind:concept), so the same one isn't re-offered across tabs and days. */
  suggested: Array<{ key: string; at: number }>;
  plans: LearningPlan[];
}

export function emptyProfile(): LearnerProfile {
  return { offers: {}, solves: { unaided: 0, hinted: 0 }, resources: [], suggested: [], plans: [] };
}

export interface GraphSnapshot {
  version: 1;
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  /** Absent in snapshots written before the profile existed. */
  profile?: LearnerProfile;
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
  /** A correct attempt that needed a hint is weaker evidence than an unaided one. */
  hintedSuccessGain: 0.2,
  /** Fixing your own wrong step is real evidence of understanding. */
  selfCorrectionGain: 0.25,
} as const;

export const RECALL = {
  /** Time away from a concept before the next first attempt counts as a retrieval opportunity. */
  gapMs: 6 * 3_600_000,
  /** A resource gets credit (or blame) for the first graded attempt on its concept inside this window. */
  resourceCreditMs: 7 * 24 * 3_600_000,
} as const;

const CAP = {
  sourcesPerNode: 12,
  /** Hard ceiling on nodes to bound persisted size; LRU-evicted by lastSeenAt on prune(). */
  nodes: 2000,
  /** Resolutions kept per misconception (provenance for the rung bandit). */
  resolutionsPerMisconception: 5,
  resources: 40,
  suggested: 30,
  plans: 5,
} as const;

const DAY_MS = 24 * 3_600_000;

// --- Snapshot validation, hand-written to match validate.ts house style (no zod dependency).
// A corrupt or stale persisted blob must never crash a session, so parsing bails to null on a bad
// envelope and drops individual malformed nodes/edges rather than throwing.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finiteNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const SOURCE_KINDS = new Set<string>(["page", "video", "query", "selection", "hint", "answer"]);
const RESOLUTION_METHODS = new Set<string>(["self", "hint", "resource", "peer", "unknown"]);
const EDGE_TYPES = new Set<string>(["prerequisite", "related"]);

function parseSource(v: unknown): ConceptSource | null {
  if (!isObj(v)) return null;
  const at = finiteNum(v.at);
  if (typeof v.url !== "string" || typeof v.title !== "string" || at === null || typeof v.kind !== "string" || !SOURCE_KINDS.has(v.kind)) return null;
  const s: ConceptSource = { url: v.url, title: v.title, at, kind: v.kind as SourceKind };
  if (typeof v.snippet === "string") s.snippet = v.snippet;
  return s;
}

function parseState(v: unknown): LearnerConceptState | null {
  if (!isObj(v)) return null;
  const firstSeenAt = finiteNum(v.firstSeenAt), lastSeenAt = finiteNum(v.lastSeenAt);
  const exposures = finiteNum(v.exposures), dwellMs = finiteNum(v.dwellMs);
  const asks = finiteNum(v.asks), struggles = finiteNum(v.struggles), mastery = finiteNum(v.mastery);
  if (firstSeenAt === null || lastSeenAt === null || exposures === null || dwellMs === null || asks === null || struggles === null || mastery === null) return null;
  // Practice/curiosity counters arrived later: a snapshot written before them reads as zeros.
  const n = (k: string) => Math.max(0, finiteNum(v[k]) ?? 0);
  return {
    firstSeenAt, lastSeenAt, exposures, dwellMs, asks, struggles, mastery,
    attempts: n("attempts"), correct: n("correct"), hinted: n("hinted"),
    recallOpportunities: n("recallOpportunities"), recallSuccesses: n("recallSuccesses"), lastPracticedAt: n("lastPracticedAt"),
    selfCorrections: n("selfCorrections"), voluntary: n("voluntary"), activeDays: n("activeDays"), lastActiveDay: n("lastActiveDay"),
  };
}

const RESOURCE_KINDS = new Set<string>(["video", "lesson", "article", "practice", "page"]);

/** Tolerant like the rest of the snapshot: drop malformed entries, never throw. */
function parseProfile(v: unknown): LearnerProfile {
  const p = emptyProfile();
  if (!isObj(v)) return p;
  if (isObj(v.offers)) {
    for (const [kind, raw] of Object.entries(v.offers)) {
      if (!isObj(raw)) continue;
      p.offers[kind] = { shown: finiteNum(raw.shown) ?? 0, accepted: finiteNum(raw.accepted) ?? 0, declined: finiteNum(raw.declined) ?? 0, lastAt: finiteNum(raw.lastAt) ?? 0 };
    }
  }
  if (isObj(v.solves)) p.solves = { unaided: finiteNum(v.solves.unaided) ?? 0, hinted: finiteNum(v.solves.hinted) ?? 0 };
  if (Array.isArray(v.resources)) {
    for (const r of v.resources) {
      const at = isObj(r) ? finiteNum(r.at) : null;
      if (!isObj(r) || at === null || typeof r.concept !== "string" || typeof r.url !== "string" || typeof r.kind !== "string" || !RESOURCE_KINDS.has(r.kind)) continue;
      p.resources.push({ concept: r.concept, url: r.url, title: typeof r.title === "string" ? r.title : r.url, kind: r.kind as ResourceKind, reason: typeof r.reason === "string" ? r.reason : "", at, helped: typeof r.helped === "boolean" ? r.helped : null });
    }
  }
  if (Array.isArray(v.suggested)) {
    for (const x of v.suggested) {
      const at = isObj(x) ? finiteNum(x.at) : null;
      if (isObj(x) && at !== null && typeof x.key === "string") p.suggested.push({ key: x.key, at });
    }
  }
  if (Array.isArray(v.plans)) {
    for (const raw of v.plans) {
      if (!isObj(raw) || typeof raw.key !== "string" || typeof raw.goal !== "string" || !Array.isArray(raw.steps)) continue;
      const steps = raw.steps
        .filter((st): st is Record<string, unknown> => isObj(st) && typeof st.title === "string")
        .map((st) => ({ title: st.title as string, concept: typeof st.concept === "string" ? st.concept : undefined, query: typeof st.query === "string" ? st.query : undefined, done: st.done === true }));
      if (steps.length) p.plans.push({ key: raw.key, goal: raw.goal, steps, createdAt: finiteNum(raw.createdAt) ?? 0, updatedAt: finiteNum(raw.updatedAt) ?? 0 });
    }
  }
  return p;
}

function parseResolution(v: unknown): MisconceptionResolution | null {
  if (!isObj(v)) return null;
  const at = finiteNum(v.at);
  if (at === null || typeof v.method !== "string" || !RESOLUTION_METHODS.has(v.method) || typeof v.note !== "string") return null;
  const r: MisconceptionResolution = { at, method: v.method as ResolutionMethod, note: v.note };
  const rung = finiteNum(v.rung);
  if (rung !== null) r.rung = rung;
  return r;
}

function parseMisconception(v: unknown): Misconception | null {
  if (!isObj(v)) return null;
  const firstSeenAt = finiteNum(v.firstSeenAt), lastSeenAt = finiteNum(v.lastSeenAt), occurrences = finiteNum(v.occurrences);
  if (typeof v.id !== "string" || typeof v.concept !== "string" || typeof v.belief !== "string" || firstSeenAt === null || lastSeenAt === null || occurrences === null) return null;
  const m: Misconception = { id: v.id, concept: v.concept, belief: v.belief, status: "active", firstSeenAt, lastSeenAt, occurrences };
  if (typeof v.evidence === "string") m.evidence = v.evidence;
  const resolution = parseResolution(v.resolution);
  if (resolution) m.resolution = resolution;
  if (Array.isArray(v.resolutionHistory)) {
    const history = v.resolutionHistory.map(parseResolution).filter((r): r is MisconceptionResolution => r !== null);
    if (history.length) m.resolutionHistory = history;
  }
  m.status = deriveStatus(m); // derive, never trust the stored status
  return m;
}

function parseNode(v: unknown): ConceptNode | null {
  if (!isObj(v)) return null;
  const state = parseState(v.state);
  if (typeof v.id !== "string" || typeof v.label !== "string" || !Array.isArray(v.aliases) || !state) return null;
  const node: ConceptNode = {
    id: v.id,
    label: v.label,
    aliases: v.aliases.filter((a): a is string => typeof a === "string"),
    state,
    sources: Array.isArray(v.sources) ? v.sources.map(parseSource).filter((s): s is ConceptSource => s !== null) : [],
    misconceptions: Array.isArray(v.misconceptions) ? v.misconceptions.map(parseMisconception).filter((m): m is Misconception => m !== null) : [],
  };
  if (typeof v.domain === "string") node.domain = v.domain;
  return node;
}

function parseEdge(v: unknown): ConceptEdge | null {
  if (!isObj(v)) return null;
  const weight = finiteNum(v.weight);
  if (typeof v.from !== "string" || typeof v.to !== "string" || typeof v.type !== "string" || !EDGE_TYPES.has(v.type) || weight === null) return null;
  return { from: v.from, to: v.to, type: v.type as EdgeType, weight };
}

/** Validate a persisted snapshot envelope; returns null for anything that isn't a v1 graph. */
function parseSnapshot(raw: unknown): GraphSnapshot | null {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
  return {
    version: 1,
    nodes: raw.nodes.map(parseNode).filter((n): n is ConceptNode => n !== null),
    edges: raw.edges.map(parseEdge).filter((e): e is ConceptEdge => e !== null),
    profile: parseProfile(raw.profile),
    updatedAt: finiteNum(raw.updatedAt) ?? 0,
  };
}

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

export function emptyConceptState(now: number): LearnerConceptState {
  return {
    firstSeenAt: now, lastSeenAt: now, exposures: 0, dwellMs: 0, asks: 0, struggles: 0, mastery: 0,
    attempts: 0, correct: 0, hinted: 0, recallOpportunities: 0, recallSuccesses: 0, lastPracticedAt: 0,
    selfCorrections: 0, voluntary: 0, activeDays: 0, lastActiveDay: 0,
  };
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
  private learner: LearnerProfile = emptyProfile();

  get size(): number {
    return this.nodes.size;
  }

  get profile(): LearnerProfile {
    return this.learner;
  }

  all(): ConceptNode[] {
    return [...this.nodes.values()];
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
      state: emptyConceptState(now),
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

  /** Every encounter moves lastSeenAt and counts the calendar day once (return visits feed curiosity). */
  private touch(node: ConceptNode, now: number): void {
    node.state.lastSeenAt = Math.max(node.state.lastSeenAt, now);
    const day = Math.floor(now / DAY_MS);
    if (day !== node.state.lastActiveDay) {
      node.state.activeDays += 1;
      node.state.lastActiveDay = day;
    }
  }

  /** The learner encountered a concept. The primary producer signal from the reactive loop. */
  recordExposure(label: string, now: number, opts: RecordExposureOpts = {}): ConceptNode {
    const node = this.ensureConcept(label, now, { domain: opts.domain, aliases: opts.aliases });
    node.state.exposures += 1;
    this.touch(node, now);
    node.state.dwellMs += Math.max(0, opts.dwellMs ?? 0);
    // Their own search or selection is voluntary engagement; an assigned page is not.
    if (opts.source?.kind === "query" || opts.source?.kind === "selection") node.state.voluntary += 1;
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.exposureGain);
    if (opts.source) this.pushSource(node, opts.source);
    return node;
  }

  /** The learner asked about a concept — engagement plus a whiff of uncertainty. */
  recordAsk(label: string, now: number, source?: ConceptSource): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.asks += 1;
    this.touch(node, now);
    node.state.mastery = clamp01(node.state.mastery - node.state.mastery * MASTERY.askDecay);
    if (source) this.pushSource(node, source);
    return node;
  }

  /** A struggle event tied to a concept (wrong attempt, stall, detected misconception). */
  recordStruggle(label: string, now: number, source?: ConceptSource): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.struggles += 1;
    this.touch(node, now);
    node.state.mastery = clamp01(node.state.mastery - node.state.mastery * MASTERY.struggleDecay);
    if (source) this.pushSource(node, source);
    return node;
  }

  /** A confirmed success on a concept (got it right / celebrated). */
  recordSuccess(label: string, now: number): ConceptNode {
    const node = this.ensureConcept(label, now);
    this.touch(node, now);
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.successGain);
    return node;
  }

  /**
   * A graded attempt — the evidence precision and recall are built from. The first attempt after
   * RECALL.gapMs away is a retrieval opportunity, and only an unaided correct one counts as recalled.
   * Also settles the most recent resource opened for this concept: did it help?
   */
  recordAttempt(label: string, now: number, opts: { correct: boolean; hinted?: boolean }): ConceptNode {
    const node = this.ensureConcept(label, now);
    const st = node.state;
    const hinted = opts.hinted === true;
    st.attempts += 1;
    if (hinted) st.hinted += 1;
    if (st.lastPracticedAt > 0 && now - st.lastPracticedAt >= RECALL.gapMs) {
      st.recallOpportunities += 1;
      if (opts.correct && !hinted) st.recallSuccesses += 1;
    }
    if (opts.correct) {
      st.correct += 1;
      st.mastery = clamp01(st.mastery + (1 - st.mastery) * (hinted ? MASTERY.hintedSuccessGain : MASTERY.successGain));
      if (hinted) this.learner.solves.hinted += 1;
      else this.learner.solves.unaided += 1;
    } else {
      st.struggles += 1;
      st.mastery = clamp01(st.mastery - st.mastery * MASTERY.struggleDecay);
    }
    st.lastPracticedAt = now;
    this.touch(node, now);
    const resource = [...this.learner.resources].reverse().find((r) => r.concept === node.id && r.helped === null && r.at <= now && now - r.at <= RECALL.resourceCreditMs);
    if (resource) resource.helped = opts.correct;
    if (opts.correct) this.completePlanSteps(node.id, now);
    return node;
  }

  /** The learner fixed their own wrong step with no hint in between. */
  recordSelfCorrection(label: string, now: number): ConceptNode {
    const node = this.ensureConcept(label, now);
    node.state.selfCorrections += 1;
    node.state.mastery = clamp01(node.state.mastery + (1 - node.state.mastery) * MASTERY.selfCorrectionGain);
    this.touch(node, now);
    return node;
  }

  /** A proactive offer was shown or answered. `key` (kind:concept) dedupes path suggestions across tabs and days. */
  recordOffer(kind: string, outcome: "shown" | "accepted" | "declined" | "dismissed", now: number, key?: string): void {
    const stats = (this.learner.offers[kind] ??= { shown: 0, accepted: 0, declined: 0, lastAt: 0 });
    if (outcome === "shown") {
      stats.shown += 1;
      stats.lastAt = now;
      if (key) this.learner.suggested = [...this.learner.suggested.filter((x) => x.key !== key), { key, at: now }].slice(-CAP.suggested);
    } else if (outcome === "accepted") stats.accepted += 1;
    else if (outcome === "declined") stats.declined += 1;
  }

  /** When this path suggestion (kind:concept) was last offered, or 0. */
  lastSuggestedAt(key: string): number {
    return this.learner.suggested.find((x) => x.key === key)?.at ?? 0;
  }

  /** The rabbit took the learner to a resource for a concept. Accepting one is voluntary engagement. */
  recordResource(conceptLabel: string, now: number, resource: { url: string; title: string; kind: ResourceKind; reason: string }): ResourceRecord {
    const node = this.ensureConcept(conceptLabel, now);
    node.state.voluntary += 1;
    this.touch(node, now);
    const rec: ResourceRecord = { concept: node.id, url: resource.url, title: resource.title.slice(0, 120), kind: resource.kind, reason: resource.reason, at: now, helped: null };
    this.learner.resources = [...this.learner.resources, rec].slice(-CAP.resources);
    this.completePlanSteps(node.id, now);
    return rec;
  }

  /** Store (or replace, by key) a learning plan, keeping done-flags of steps that survive. */
  savePlan(plan: { key: string; goal: string; steps: Array<{ title: string; concept?: string; query?: string }> }, now: number): LearningPlan {
    const prior = this.learner.plans.find((p) => p.key === plan.key);
    const saved: LearningPlan = {
      key: plan.key,
      goal: plan.goal,
      steps: plan.steps.map((s) => ({ ...s, done: prior?.steps.find((x) => x.title === s.title)?.done ?? false })),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.learner.plans = [...this.learner.plans.filter((p) => p.key !== plan.key), saved].slice(-CAP.plans);
    return saved;
  }

  /** The most recently touched plan that still has an open step. */
  activePlan(): LearningPlan | null {
    return [...this.learner.plans].sort((a, b) => b.updatedAt - a.updatedAt).find((p) => p.steps.some((s) => !s.done)) ?? null;
  }

  private completePlanSteps(conceptId: string, now: number): void {
    for (const plan of this.learner.plans) {
      for (const step of plan.steps) {
        if (step.done || !step.concept || this.resolve(step.concept) !== conceptId) continue;
        step.done = true;
        plan.updatedAt = now;
      }
    }
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
    this.touch(node, now);
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
    m.resolutionHistory = [...(m.resolutionHistory ?? []), m.resolution].slice(-CAP.resolutionsPerMisconception);
    m.status = deriveStatus(m);
    this.touch(node, now);
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
      a.attempts += b.attempts;
      a.correct += b.correct;
      a.hinted += b.hinted;
      a.recallOpportunities += b.recallOpportunities;
      a.recallSuccesses += b.recallSuccesses;
      a.selfCorrections += b.selfCorrections;
      a.voluntary += b.voluntary;
      a.lastPracticedAt = Math.max(a.lastPracticedAt, b.lastPracticedAt);
      a.activeDays = a.lastActiveDay === b.lastActiveDay ? Math.max(a.activeDays, b.activeDays) : a.activeDays + b.activeDays;
      a.lastActiveDay = Math.max(a.lastActiveDay, b.lastActiveDay);
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
      // Union resolution histories by timestamp so provenance survives a merge.
      const byAt = new Map<number, MisconceptionResolution>();
      for (const r of [...(mm.resolutionHistory ?? []), ...(om.resolutionHistory ?? [])]) byAt.set(r.at, structuredClone(r));
      if (byAt.size) mm.resolutionHistory = [...byAt.values()].sort((a, b) => a.at - b.at).slice(-CAP.resolutionsPerMisconception);
      mm.status = deriveStatus(mm);
    }
  }

  toJSON(): GraphSnapshot {
    return { version: 1, nodes: [...this.nodes.values()], edges: [...this.edges], profile: this.learner, updatedAt: Date.now() };
  }

  /** Rebuild from a persisted snapshot, tolerating a corrupt/stale blob (returns an empty graph). */
  static fromJSON(raw: unknown): KnowledgeGraph {
    const g = new KnowledgeGraph();
    const snap = parseSnapshot(raw);
    if (!snap) return g;
    for (const node of snap.nodes) {
      g.nodes.set(node.id, node);
      g.aliasIndex.set(node.id, node.id);
      for (const alias of node.aliases) g.aliasIndex.set(slugify(alias), node.id);
    }
    g.edges = snap.edges;
    g.learner = snap.profile ?? emptyProfile();
    g.rebuildEdgeKeys();
    return g;
  }
}
