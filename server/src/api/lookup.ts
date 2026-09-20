import { resourceKindOf } from "@shared/events";
import { parseVideoTime } from "@shared/video";
import type { ResourceKind } from "@shared/graph";
import { log } from "../util/logger";

const logger = log("lookup");

/**
 * Vetted, cookie-free lookups for the agent's look_up action. This is deliberately NOT a general
 * HTTP capability: the extension never fetches with the student's session, and the server only
 * talks to endpoints we chose. Results come back as compact lines the model can cite, then act on
 * visibly (open_tab), so every consequence stays on-screen.
 */
export interface LookupResult {
  title: string;
  url: string;
  snippet?: string;
  /** Modality tag the agent (and resource-efficacy tracking) sees: video, lesson, article… */
  kind?: ResourceKind;
}

export interface LookupOptions {
  /** Modality to list first (what has worked for this learner, or the suggestion's default). */
  prefer?: string;
  /** Search YouTube for actual videos. Off in demo mode, which must not depend on (or open) YouTube: videos are then a search link. */
  videos?: boolean;
}

/** Trusted learning destinations with predictable search URLs — always offered alongside articles. */
const EDU_SEARCHES: Array<{ name: string; build: (q: string) => string }> = [
  { name: "Khan Academy search", build: (q) => `https://www.khanacademy.org/search?page_search_query=${encodeURIComponent(q)}` },
  { name: "YouTube search", build: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
];

export function formatResults(query: string, results: LookupResult[]): string {
  if (!results.length) return `No results for "${query}".`;
  return results
    .map((r, i) => `${i + 1}. ${r.kind ? `[${r.kind}] ` : ""}${r.title} — ${r.url}${r.snippet ? ` — ${r.snippet.slice(0, 140)}` : ""}`)
    .join("\n");
}

async function wikipediaSearch(query: string): Promise<LookupResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=4&search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "user-agent": "pip-learning-companion/0.1 (local dev)" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const [, titles, descriptions, urls] = (await res.json()) as [string, string[], string[], string[]];
  return titles.map((title, i) => ({ title: `${title} (Wikipedia)`, url: urls[i], snippet: descriptions[i] || undefined }));
}

/** Shorter than this is a Short or a teaser, not a lesson. */
const MIN_VIDEO_S = 60;
/** YouTube's search filter for "videos with captions": the rabbit can then follow along with whatever gets opened. */
const YT_VIDEOS_WITH_CAPTIONS = "EgQQASgB";

interface VideoRenderer {
  videoId?: string;
  title?: { runs?: Array<{ text?: string }> };
  lengthText?: { simpleText?: string };
  ownerText?: { runs?: Array<{ text?: string }> };
}

function videoRenderers(node: unknown, out: VideoRenderer[] = []): VideoRenderer[] {
  if (Array.isArray(node)) for (const child of node) videoRenderers(child, out);
  else if (node && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      if (key === "videoRenderer") out.push(child as VideoRenderer);
      else videoRenderers(child, out);
    }
  }
  return out;
}

/**
 * Real videos, read off YouTube's own results page: no key, no cookies of the student's, about
 * half a second (a search API measured 7–11s, too slow to sit inside the agent's chain). The
 * PREF cookie is YouTube's Restricted Mode — this is a child's browser. The page's embedded
 * `ytInitialData` is not a contract: when it moves, this throws and lookUp falls back to the
 * search link the agent clicks through.
 */
export async function youtubeSearch(query: string, fetchImpl: typeof fetch = fetch): Promise<LookupResult[]> {
  const params = new URLSearchParams({ search_query: query, sp: YT_VIDEOS_WITH_CAPTIONS });
  const res = await fetchImpl(`https://www.youtube.com/results?${params}`, {
    headers: { "accept-language": "en-US,en;q=0.9", cookie: "PREF=f2=8000000", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`youtube ${res.status}`);
  const data = (await res.text()).match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!data) throw new Error("youtube results page had no ytInitialData");
  return videoRenderers(JSON.parse(data))
    .map((v) => ({ id: v.videoId, title: v.title?.runs?.map((r) => r.text ?? "").join(""), channel: v.ownerText?.runs?.[0]?.text, length: v.lengthText?.simpleText }))
    // No length means a live stream or a premiere.
    .filter((v) => v.id && v.title && v.length && (parseVideoTime(v.length, 0) ?? 0) >= MIN_VIDEO_S)
    .slice(0, 3)
    .map((v) => ({ title: `${v.title} (YouTube · ${v.channel ?? "video"} · ${v.length})`, url: `https://www.youtube.com/watch?v=${v.id}` }));
}

/** Stable sort: the preferred modality first, everything else in its original order. */
export function rankResults(results: LookupResult[], prefer?: string): LookupResult[] {
  const tagged = results.map((r) => ({ ...r, kind: r.kind ?? resourceKindOf(r.url) }));
  if (!prefer) return tagged;
  return [...tagged.filter((r) => r.kind === prefer), ...tagged.filter((r) => r.kind !== prefer)];
}

export async function lookUp(query: string, opts: LookupOptions = {}): Promise<string> {
  const q = query.trim().slice(0, 200);
  const settle = (name: string, run: Promise<LookupResult[]>) =>
    run.catch((e): LookupResult[] => {
      logger.warn(`${name} lookup failed`, { error: e instanceof Error ? e.message : String(e) });
      return [];
    });
  const [articles, videos] = await Promise.all([settle("wikipedia", wikipediaSearch(q)), opts.videos ? settle("youtube", youtubeSearch(q)) : []]);
  const searches = EDU_SEARCHES.filter((edu) => !(videos.length && edu.name.startsWith("YouTube"))).map((edu) => ({ title: `${edu.name} for "${q}"`, url: edu.build(q) }));
  const results = rankResults([...videos, ...articles, ...searches], opts.prefer);
  logger.info("lookup", { query: q, prefer: opts.prefer, results: results.length });
  return formatResults(q, results);
}
