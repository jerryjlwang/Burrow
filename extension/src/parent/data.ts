// Storage contract for the parent view (docs/frontend/HANDOFF.md), the skill list, a relative time
// helper and the sample graph the page falls back to so a demo always has rooms to show.
import { KnowledgeGraph, emptyConceptState, emptyProfile, type ConceptNode, type GraphSnapshot, type LearnerConceptState, type LearningPlan, type Misconception, type StepCompletion } from "@shared/graph";
import { diagnose, preferredModality } from "@shared/diagnostics";

export const GRANTS_KEY = "burrow.grants";
export const JUMP_KEY = "burrow.jump";
export const GRAPH_KEY = "burrow.graph";

export type SkillId = "read_pages" | "use_voice" | "browse_links" | "remember" | "visit_parent";

export interface Grant {
  granted: boolean;
  at: number;
}
export type Grants = Partial<Record<SkillId, Grant>>;

export interface Jump {
  id: string;
  to: "parent" | "kid";
  stage: "requested" | "gone" | "arrived";
  at: number;
  summary?: string;
  graph?: GraphSnapshot;
}

export const SKILLS: { id: SkillId; title: string; blurb: string }[] = [
  { id: "read_pages", title: "Read the page", blurb: "He can see what is on the page your kid is looking at." },
  { id: "use_voice", title: "Listen and talk", blurb: "He can hear your kid through the microphone and answer out loud." },
  { id: "browse_links", title: "Click and open things", blurb: "He can follow links and open pages on his own." },
  { id: "remember", title: "Remember between days", blurb: "He keeps what he learned from one day to the next." },
  { id: "visit_parent", title: "Visit your laptop", blurb: "He can hop over to this page and tell you what he learned." },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** Enough of a check that rendering cannot throw on a stale or half-written record. */
export function isGraph(v: unknown): v is GraphSnapshot {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.nodes)) return false;
  return v.nodes.every((n: unknown) => isObj(n) && typeof n.label === "string" && isObj(n.state) && typeof n.state.mastery === "number" && Array.isArray(n.misconceptions));
}

export function isJump(v: unknown): v is Jump {
  return isObj(v) && (v.to === "parent" || v.to === "kid") && (v.stage === "requested" || v.stage === "gone" || v.stage === "arrived") && typeof v.at === "number";
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  const w = Math.round(d / 7);
  return w === 1 ? "a week ago" : `${w} weeks ago`;
}

export interface LearningNote {
  title: string;
  body: string;
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;
const list = (labels: string[]): string => (labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`);

/** The learner diagnostics, in sentences a parent can use. Notes without evidence are left out. */
export function learningNotes(snapshot: GraphSnapshot, kid: string, now = Date.now()): LearningNote[] {
  const d = diagnose(KnowledgeGraph.fromJSON(snapshot), now);
  const notes: LearningNote[] = [];
  if (d.precision.value !== null) {
    notes.push({ title: "Getting it right", body: `When ${kid} commits to an answer it is right ${percent(d.precision.value)} of the time (${d.precision.n} answers so far).` });
  }
  if (d.recall.value !== null) {
    notes.push({ title: "Remembering it later", body: `When a topic comes back after time away, ${kid} recalls it without help ${percent(d.recall.value)} of the time (${d.recall.n} ${d.recall.n === 1 ? "check" : "checks"}).` });
  }
  if (d.fading.length) {
    notes.push({ title: "Gets it, then loses it", body: `${list(d.fading.slice(0, 3).map((c) => c.label))}: right in the moment, gone a few days later. Short revisits help more than longer sessions.` });
  }
  if (d.dueForReview.length) {
    notes.push({ title: "Fading", body: `${list(d.dueForReview.slice(0, 3).map((c) => c.label))} ${d.dueForReview.length === 1 ? "has" : "have"} not come up for a while. The rabbit will ask for a quick check.` });
  }
  if (d.interests.length) {
    notes.push({ title: "Curious about", body: `${kid} keeps asking about and coming back to ${list(d.interests.slice(0, 3).map((c) => c.label))} without being told to.` });
  }
  if (d.help.independence.value !== null) {
    const fixes = d.help.selfCorrections ? ` and caught ${d.help.selfCorrections === 1 ? "one mistake" : `${d.help.selfCorrections} mistakes`} alone` : "";
    notes.push({ title: "Working alone", body: `${kid} solves ${percent(d.help.independence.value)} of problems without a hint${fixes}.` });
  }
  const modality = preferredModality(d);
  if (modality) notes.push({ title: "What helps", body: `After a ${modality}, ${kid} usually gets the next question on that topic right, so the rabbit reaches for ${modality}s first.` });
  return notes;
}

/** How a step got done, in a parent's words. */
export function completionLine(c: StepCompletion, now = Date.now()): string {
  const how = c.by === "resource" ? `opened ${c.title ? `"${c.title}"` : "a lesson"}` : c.by === "attempt" ? "answered a question on it correctly" : "got there in written working";
  return `${how}, ${ago(c.at, now)}`;
}

/** Where a plan came from, in a parent's words. */
export function provenanceLine(plan: LearningPlan, kid: string, now = Date.now()): string {
  const pv = plan.provenance;
  const when = ago(plan.createdAt, now);
  if (pv?.origin === "asked") return `${kid} asked ${when}${pv.utterance ? `: "${pv.utterance}"` : ""}`;
  if (pv?.origin === "page") return `From ${pv.title ? `"${pv.title}"` : "a page"}, ${when}`;
  return `Started ${when}`;
}

export function sampleGraph(now = Date.now()): GraphSnapshot {
  const H = 3_600_000;
  const D = 24 * H;
  const node = (id: string, label: string, domain: string, mastery: number, exposures: number, asks: number, struggles: number, firstSeenAt: number, lastSeenAt: number, misconceptions: Misconception[] = [], practice: Partial<LearnerConceptState> = {}): ConceptNode => ({
    id,
    label,
    aliases: [],
    domain,
    state: { ...emptyConceptState(firstSeenAt), lastSeenAt, exposures, dwellMs: exposures * 90_000, asks, struggles, mastery, ...practice },
    sources: [],
    misconceptions,
  });
  return {
    version: 1,
    updatedAt: now - 2 * H,
    nodes: [
      node("moats", "Moats", "castles", 0.86, 4, 1, 1, now - 5 * D, now - 2 * H, [
        {
          id: "moats-were-always-full-of-water",
          concept: "moats",
          belief: "moats were always full of water",
          status: "resolved",
          firstSeenAt: now - 5 * D,
          lastSeenAt: now - 4 * D,
          occurrences: 1,
          evidence: "Asked why a dry moat would stop anyone.",
          resolution: { at: now - 4 * D, method: "self", note: "remembered the dry moat picture and worked out that a deep ditch is enough to stop tunnels and towers." },
        },
      ], { attempts: 5, correct: 4, recallOpportunities: 2, recallSuccesses: 2, lastPracticedAt: now - 2 * H, voluntary: 3, activeDays: 4 }),
      node("castle-walls", "Castle walls", "castles", 0.71, 3, 0, 0, now - 5 * D, now - D),
      node("halves-and-quarters", "Halves and quarters", "fractions", 0.64, 3, 1, 0, now - 3 * D, now - D, [], { attempts: 4, correct: 3, lastPracticedAt: now - D }),
      node("siege-towers", "Siege towers", "castles", 0.52, 2, 1, 0, now - 4 * D, now - 3 * D),
      node("comparing-fractions", "Comparing fractions", "fractions", 0.22, 2, 2, 2, now - 6 * D, now - 6 * D, [
        {
          id: "a-bigger-bottom-number-means-a-bigger-fraction",
          concept: "comparing-fractions",
          belief: "a bigger bottom number means a bigger fraction",
          status: "active",
          firstSeenAt: now - 6 * D,
          lastSeenAt: now - 6 * D,
          occurrences: 2,
          evidence: "Said one fifth is bigger than one third because five is more than three.",
        },
      ], { attempts: 4, correct: 1, hinted: 2, recallOpportunities: 1, recallSuccesses: 0, lastPracticedAt: now - 6 * D }),
    ],
    profile: {
      ...emptyProfile(),
      plans: [
        {
          key: "topic:castles",
          kind: "topic",
          goal: "castles",
          createdAt: now - 5 * D,
          updatedAt: now - D,
          provenance: { origin: "asked", planner: "llm", utterance: "I want to learn about castles", title: "Castles - Kiddle encyclopedia" },
          steps: [
            { title: "Why castles were built where they were", concept: "Castle walls", done: true, completion: { at: now - 5 * D, by: "resource", title: "Castles for kids (video)" } },
            { title: "How a moat keeps attackers out", concept: "Moats", done: true, completion: { at: now - D, by: "attempt" } },
            { title: "How attackers tried to get in anyway", concept: "Siege towers", done: false },
            { title: "What life was like inside the walls", concept: "Castle life", done: false },
          ],
          history: [
            { at: now - 5 * D, type: "created", detail: "I want to learn about castles" },
            { at: now - 5 * D, type: "step_done", step: 1, detail: "Castles for kids (video)" },
            { at: now - D, type: "step_done", step: 2, detail: "attempt" },
          ],
        },
        {
          key: "page:homework:which-is-bigger",
          kind: "problem",
          goal: "Decide which of two fractions is bigger",
          createdAt: now - 6 * D,
          updatedAt: now - 6 * D,
          provenance: { origin: "page", planner: "llm", title: "Fractions homework, question 4" },
          steps: [
            { title: "Give both fractions the same bottom number", concept: "Comparing fractions", done: true, completion: { at: now - 6 * D, by: "working", title: "Fractions homework, question 4" } },
            { title: "Compare the top numbers", concept: "Comparing fractions", done: false },
          ],
          history: [
            { at: now - 6 * D, type: "created", detail: "Fractions homework, question 4" },
            { at: now - 6 * D, type: "step_done", step: 1, detail: "working" },
            { at: now - 6 * D, type: "wrong_step", step: 3 },
          ],
        },
      ],
    },
    edges: [
      { from: "halves-and-quarters", to: "comparing-fractions", type: "prerequisite", weight: 0.8 },
      { from: "moats", to: "castle-walls", type: "related", weight: 0.6 },
      { from: "siege-towers", to: "moats", type: "related", weight: 0.5 },
    ],
  };
}
