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
    .replace(/^\(\d+\+?\)\s*/, "")
    .replace(/\s*[-–—|·]\s*(YouTube|Khan Academy|Vimeo|TED).*$/i, "")
    .trim()
    .slice(0, 80);
}

const FILLER = new Set("a an the and or but so of to in on at for with from by as is are was were be been do does did can could would should will why how what when where who which that this these those it its he she they them his her their i me my we you your just really still again wait explain mean means meant get got understand understood say said says tell show did didn don doesn t s not no video part bit here there now then about".split(" "));

/**
 * What to search for after a question about a video: the question's own content words, anchored
 * by the video's topic. "Why does the sign flip?" on "Solving two-step equations" looks for the
 * sign flip, not for the same lesson again. A question that only points ("wait, what did he just
 * do?") has nothing to search for, so the topic stands alone. Beside a question the topic is cut
 * to the title's longest segment: "Algebra Basics: Solving 2-Step Equations - Math Antics" would
 * otherwise turn the search into one for more of that channel.
 */
export function relatedQuery(question: string, title: string): string {
  const full = videoQuery(title);
  const wordCount = (s: string) => s.split(/\s+/).length;
  const topic = full.split(/\s+[-–—|·]\s+|:\s+/).reduce((best, part) => (wordCount(part) > wordCount(best) ? part : best)).trim();
  const words = question.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w));
  return words.length >= 2 ? `${words.join(" ")} ${topic}`.trim().slice(0, 120) : full;
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
