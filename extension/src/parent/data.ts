// Storage contract for the parent view (docs/frontend/HANDOFF.md), the skill list, a relative time
// helper and the sample graph the page falls back to so a demo always has rooms to show.
import type { ConceptNode, GraphSnapshot, Misconception } from "@shared/graph";

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

export function sampleGraph(now = Date.now()): GraphSnapshot {
  const H = 3_600_000;
  const D = 24 * H;
  const node = (id: string, label: string, domain: string, mastery: number, exposures: number, asks: number, struggles: number, firstSeenAt: number, lastSeenAt: number, misconceptions: Misconception[] = []): ConceptNode => ({
    id,
    label,
    aliases: [],
    domain,
    state: { firstSeenAt, lastSeenAt, exposures, dwellMs: exposures * 90_000, asks, struggles, mastery },
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
      ]),
      node("castle-walls", "Castle walls", "castles", 0.71, 3, 0, 0, now - 5 * D, now - D),
      node("halves-and-quarters", "Halves and quarters", "fractions", 0.64, 3, 1, 0, now - 3 * D, now - D),
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
      ]),
    ],
    edges: [
      { from: "halves-and-quarters", to: "comparing-fractions", type: "prerequisite", weight: 0.8 },
      { from: "moats", to: "castle-walls", type: "related", weight: 0.6 },
      { from: "siege-towers", to: "moats", type: "related", weight: 0.5 },
    ],
  };
}
