/**
 * The related-video recommendation: after the rabbit answers a question about a video, it offers
 * ONE other video on the same topic as a small banner. These are the pure parts — deciding what
 * counts as a question, building the search query, and picking a result that isn't the video
 * already on screen.
 */

const QUESTION_START = /^(why|how|what|when|where|who|which|can|could|does|do|did|is|are|was|were|will|would|should|explain|wait)\b/i;

export function isVideoQuestion(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && (t.includes("?") || QUESTION_START.test(t));
}

/** "Photosynthesis for kids - YouTube" → "Photosynthesis for kids": site suffixes off, capped. */
export function videoQuery(title: string): string {
  return title
    .replace(/\s*[-–—|·]\s*(YouTube|Khan Academy|Vimeo|TED).*$/i, "")
    .trim()
    .slice(0, 80);
}

const RESULT_RE = /^\d+\.\s*(?:\[(\w+)\]\s*)?(.+?) — (https?:\/\/\S+)/;

function videoId(url: string): string | null {
  const m = url.match(/[?&]v=([\w-]{6,})/) ?? url.match(/youtu\.be\/([\w-]{6,})/);
  return m ? m[1] : null;
}

/** First result that is not the video already on screen; [video] results outrank the rest. */
export function pickRelated(results: string, currentUrl: string): { title: string; url: string } | null {
  const current = videoId(currentUrl);
  const fresh = results
    .split("\n")
    .map((line) => line.match(RESULT_RE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ kind: m[1] ?? "", title: m[2], url: m[3] }))
    .filter((r) => r.url !== currentUrl && (current === null || videoId(r.url) !== current));
  return fresh.find((r) => r.kind === "video") ?? fresh[0] ?? null;
}
