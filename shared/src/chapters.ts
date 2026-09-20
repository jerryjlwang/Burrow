/**
 * A video's chapter list, as video sites publish it: lines of the description that start with a
 * timestamp ("2:42 - What are neurons?"). These are the pure parts of the fixed chapter path —
 * recognising a request for it, reading the list out of description text, and a model-free pick.
 */
import { parseVideoTime } from "./video";

export interface Chapter {
  /** Seconds into the video. */
  t: number;
  /** The timestamp as written ("2:42"), which is also the text of its link on the page. */
  stamp: string;
  title: string;
  /** The line exactly as the page shows it, which is what gets pointed at. */
  line: string;
}

const CHAPTER_LINE = /^\s*[([]?(\d{1,2}:\d{2}(?::\d{2})?)[)\]]?\s*[-–—:|·]?\s*(\S.*)$/;

/** Timestamped lines in ascending order. Fewer than two is a stray timestamp, not a chapter list. */
export function parseChapters(text: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(CHAPTER_LINE);
    const t = m ? parseVideoTime(m[1], 0) : null;
    if (!m || t === null) continue;
    // A list runs forward in time; a timestamp that goes backwards belongs to something else (a comment, a second list).
    if (chapters.length && t <= chapters[chapters.length - 1].t) continue;
    chapters.push({ t, stamp: m[1], title: m[2].trim().slice(0, 160), line: line.trim().slice(0, 200) });
  }
  return chapters.length >= 2 ? chapters : [];
}

/** "find the chapter on…", "look at the chapter list for…", "which timestamp covers…", "check the description for…". */
export function isChapterRequest(utterance: string): boolean {
  return /\b(chapters?|chapter list|timestamps?|time stamps?)\b|\b(in|from|check|look at|search|open) the description\b/i.test(utterance);
}

const FILLER = new Set("a an the and or of to in on at for with from by is are was be do does can could would will you me my i we he she it its this that there where which what when who find look looking search check open show take skip jump go get list chapter chapters timestamp timestamps stamp stamps time description video part section bit about covers cover covering talks talk talking explains explain explaining some certain please bunny want need one most appropriate right".split(" "));

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !FILLER.has(w));
/** Crude stem so "dividing" meets "divide" and "layers" meets "layer". */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");

/**
 * The chapter whose title shares the most content words with the request; null when nothing
 * overlaps. Used when no model is available, and as the fallback when the model call fails.
 */
export function pickChapterLexical(request: string, chapters: Chapter[]): number | null {
  const wanted = new Set(words(request).map(stem));
  if (!wanted.size) return null;
  let best = -1;
  let bestScore = 0;
  chapters.forEach((ch, i) => {
    const score = words(ch.title).map(stem).filter((w) => wanted.has(w)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best === -1 ? null : best;
}
