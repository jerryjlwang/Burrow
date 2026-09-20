import { resourceKindOf } from "@shared/events";
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
  /** With a key, YouTube results are actual videos; without one, a search link the agent clicks through. */
  youtubeApiKey?: string;
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

/** Embeddable, strict-safe-search videos only — this is a child's browser. */
async function youtubeSearch(query: string, apiKey: string): Promise<LookupResult[]> {
  const params = new URLSearchParams({ part: "snippet", type: "video", maxResults: "3", safeSearch: "strict", videoEmbeddable: "true", relevanceLanguage: "en", q: query, key: apiKey });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`youtube ${res.status}`);
  const body = (await res.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }> };
  return (body.items ?? [])
    .filter((it) => it.id?.videoId && it.snippet?.title)
    .map((it) => ({ title: `${it.snippet!.title} (YouTube · ${it.snippet!.channelTitle ?? "video"})`, url: `https://www.youtube.com/watch?v=${it.id!.videoId}` }));
}

/** Stable sort: the preferred modality first, everything else in its original order. */
export function rankResults(results: LookupResult[], prefer?: string): LookupResult[] {
  const tagged = results.map((r) => ({ ...r, kind: r.kind ?? resourceKindOf(r.url) }));
  if (!prefer) return tagged;
  return [...tagged.filter((r) => r.kind === prefer), ...tagged.filter((r) => r.kind !== prefer)];
}

export async function lookUp(query: string, opts: LookupOptions = {}): Promise<string> {
  const q = query.trim().slice(0, 200);
  const settle = async (name: string, run: Promise<LookupResult[]>): Promise<LookupResult[]> => {
    try {
      return await run;
    } catch (e) {
      logger.warn(`${name} lookup failed`, { error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  };
  const [articles, videos] = await Promise.all([
    settle("wikipedia", wikipediaSearch(q)),
    opts.youtubeApiKey ? settle("youtube", youtubeSearch(q, opts.youtubeApiKey)) : Promise.resolve([]),
  ]);
  const searches = EDU_SEARCHES.filter((edu) => !(videos.length && edu.name.startsWith("YouTube"))).map((edu) => ({ title: `${edu.name} for "${q}"`, url: edu.build(q) }));
  const results = rankResults([...videos, ...articles, ...searches], opts.prefer);
  logger.info("lookup", { query: q, prefer: opts.prefer, results: results.length });
  return formatResults(q, results);
}
