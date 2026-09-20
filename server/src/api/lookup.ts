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
}

/** Trusted learning destinations with predictable search URLs — always offered alongside articles. */
const EDU_SEARCHES: Array<{ name: string; build: (q: string) => string }> = [
  { name: "Khan Academy search", build: (q) => `https://www.khanacademy.org/search?page_search_query=${encodeURIComponent(q)}` },
  { name: "YouTube search", build: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
];

export function formatResults(query: string, results: LookupResult[]): string {
  if (!results.length) return `No results for "${query}".`;
  return results
    .map((r, i) => `${i + 1}. ${r.title} — ${r.url}${r.snippet ? ` — ${r.snippet.slice(0, 140)}` : ""}`)
    .join("\n");
}

async function wikipediaSearch(query: string): Promise<LookupResult[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=4&search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "user-agent": "pip-learning-companion/0.1 (local dev)" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const [, titles, descriptions, urls] = (await res.json()) as [string, string[], string[], string[]];
  return titles.map((title, i) => ({ title: `${title} (Wikipedia)`, url: urls[i], snippet: descriptions[i] || undefined }));
}

export async function lookUp(query: string): Promise<string> {
  const q = query.trim().slice(0, 200);
  const results: LookupResult[] = [];
  try {
    results.push(...(await wikipediaSearch(q)));
  } catch (e) {
    logger.warn("wikipedia lookup failed", { error: e instanceof Error ? e.message : String(e) });
  }
  for (const edu of EDU_SEARCHES) results.push({ title: `${edu.name} for "${q}"`, url: edu.build(q) });
  logger.info("lookup", { query: q, results: results.length });
  return formatResults(q, results);
}
