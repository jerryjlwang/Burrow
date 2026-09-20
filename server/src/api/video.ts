import { pickChapterLexical, type Chapter } from "@shared/chapters";
import { RAISE_KINDS, heuristicNotes, parseWatchNote, stampedTranscript, type TranscriptSegment, type WatchNote } from "@shared/video";
import type { OpenAIProvider } from "../agent/openai";
import { log } from "../util/logger";

const logger = log("video");

export interface VideoAnalyzeRequest {
  url: string;
  title?: string;
  /** Captions the page itself exposes (native text tracks). When absent, the transcript service is asked. */
  segments?: TranscriptSegment[];
}

export interface VideoAnalysis {
  /** Cache key: the YouTube id, or the url for other players. */
  key: string;
  segments: TranscriptSegment[];
  notes: WatchNote[];
  transcript: "page" | "service" | "none";
  notesBy: "llm" | "heuristic" | "none";
}

const WATCH_PROMPT = `You are the silent attention of a learning companion that watches educational videos alongside a young student. You read the transcript ONCE, before the student gets there, and write PRIVATE notes. Nothing you write is shown as-is; most of it is never surfaced at all.

Split the transcript into teaching beats of roughly 45-120 seconds. start/end are seconds (the [m:ss] stamps converted), beats in order, covering the video without overlap. For each beat:
- gist: one sentence — what this stretch teaches.
- concepts: the curriculum ideas it covers, canonical names ("Inverse operations").
- assumes: ideas it relies on WITHOUT explaining them. [] if none.
- raise: null for almost every beat. A typical ten-minute video earns zero to two raises. Do not go looking for something to say: a beat that is merely fine, interesting or a bit quick gets null. When a beat truly warrants it:
  - kind "crucial": the single idea the rest of the video (or the subject) hangs on, which a student could let slide past. The companion may PAUSE the video at the end of this beat and say your message out loud, so the bar is: a good human tutor sitting beside the student would reach over and hit pause here.
  - kind "dense": several steps compressed into a few seconds. "prerequisite-gap": leans hard on an unexplained idea. "misconception-risk": phrasing that commonly plants a wrong belief. "check-understanding": a natural spot to ask the student to predict or explain.
  - message: what the companion would say, at most 35 words, in warm plain kid language, grounded in what was JUST said in the beat. For "crucial": state the idea itself in one fresh sentence and why it matters — do not say "this is important", do not ask permission, do not mention pausing. For the others: a short offer ("That went by fast — want it drawn out step by step?").
  - salience: 0..1, honestly calibrated. 0.85+ only for the one or two ideas everything else depends on.
  - why: one private sentence.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const WATCH_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          gist: { type: "string" },
          concepts: { type: "array", items: { type: "string" } },
          assumes: { type: "array", items: { type: "string" } },
          raise: nullable({
            type: "object",
            properties: { kind: { type: "string", enum: [...RAISE_KINDS] }, message: { type: "string" }, salience: { type: "number" }, why: { type: "string" } },
            required: ["kind", "message", "salience", "why"],
            additionalProperties: false,
          }),
        },
        required: ["start", "end", "gist", "concepts", "assumes", "raise"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes"],
  additionalProperties: false,
} as const;

/** Transcript chars per model pass (~10 minutes of speech); longer videos are read in parallel passes. */
const PASS_CHARS = 9000;
const MAX_PASSES = 6;
const MAX_PAGE_SEGMENTS = 6000;

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sanitize(segments: unknown): TranscriptSegment[] {
  if (!Array.isArray(segments)) return [];
  const out: TranscriptSegment[] = [];
  for (const s of segments.slice(0, MAX_PAGE_SEGMENTS)) {
    const seg = s as Partial<TranscriptSegment> | null;
    if (!seg || typeof seg.text !== "string" || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)) continue;
    const text = seg.text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (text) out.push({ start: Math.max(0, seg.start!), end: Math.max(seg.start!, seg.end!), text });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Third-party transcript service (Supadata). YouTube's own caption endpoints are attestation-gated
 * and return nothing to a server or an automated browser, so this never talks to YouTube.
 */
export async function fetchServiceTranscript(videoId: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<TranscriptSegment[]> {
  const res = await fetchImpl(`https://api.supadata.ai/v1/youtube/transcript?videoId=${encodeURIComponent(videoId)}&lang=en`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(20_000) });
  // 206: the video exists but has no transcript. Not an error, just nothing to read.
  if (res.status === 206 || res.status === 404) return [];
  if (!res.ok) throw new Error(`transcript service ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ text?: string; offset?: number; duration?: number }> | string };
  if (!Array.isArray(body.content)) return [];
  return sanitize(body.content.map((c) => ({ text: c.text, start: (c.offset ?? NaN) / 1000, end: ((c.offset ?? NaN) + (c.duration ?? 0)) / 1000 })));
}

export interface ChapterPickRequest {
  request: string;
  title?: string;
  chapters: Chapter[];
}

const CHAPTER_PROMPT = `A student watching a video asked to be taken to a part of it. You are given the video's chapter list. Reply with the index of the ONE chapter where what they asked for is covered. Judge by meaning, not shared words. If they did not ask for any particular part (they only want to see the list), or no chapter plausibly covers it, reply with null.`;
const CHAPTER_SCHEMA = { type: "object", properties: { index: { type: ["integer", "null"] } }, required: ["index"], additionalProperties: false };

export class VideoService {
  private cache = new Map<string, Promise<VideoAnalysis>>();

  constructor(private llm: OpenAIProvider | null, private transcriptApiKey: string, private fetchImpl: typeof fetch = fetch) {}

  get transcriptsEnabled(): boolean {
    return !!this.transcriptApiKey;
  }

  /** One analysis per video, shared by every tab and replay; a failed one is forgotten so it can be retried. */
  analyze(req: VideoAnalyzeRequest): Promise<VideoAnalysis> {
    const key = youtubeId(req.url) ?? req.url.split("#")[0];
    const hit = this.cache.get(key);
    if (hit) return hit;
    const run = this.run(key, req).catch((e) => {
      this.cache.delete(key);
      throw e;
    });
    this.cache.set(key, run);
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
    return run;
  }

  private async run(key: string, req: VideoAnalyzeRequest): Promise<VideoAnalysis> {
    let segments = sanitize(req.segments);
    let transcript: VideoAnalysis["transcript"] = segments.length ? "page" : "none";
    const id = youtubeId(req.url);
    if (!segments.length && id && this.transcriptApiKey) {
      segments = await fetchServiceTranscript(id, this.transcriptApiKey, this.fetchImpl);
      if (segments.length) transcript = "service";
    }
    if (!segments.length) {
      logger.info("no transcript", { key, service: this.transcriptsEnabled });
      return { key, segments: [], notes: [], transcript: "none", notesBy: "none" };
    }
    const started = Date.now();
    let notes: WatchNote[] = [];
    let notesBy: VideoAnalysis["notesBy"] = "heuristic";
    if (this.llm) {
      try {
        notes = await this.read(segments, req.title ?? "");
        notesBy = "llm";
      } catch (e) {
        logger.warn("watch pass failed; using heuristic notes", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (notesBy !== "llm") notes = heuristicNotes(segments, Date.now());
    logger.info("analyzed", { key, transcript, notesBy, segments: segments.length, notes: notes.length, raises: notes.filter((n) => n.raise).length, ms: Date.now() - started });
    return { key, segments, notes, transcript, notesBy };
  }

  /**
   * Which chapter the student is asking for, by index; null when none fits (or they named none).
   * The model reads meaning ("where he shows the mistake" → "The sign error"); word overlap stands
   * in when there is no model or the call fails, so the chapter path never stalls on it.
   */
  async pickChapter(req: ChapterPickRequest): Promise<{ index: number | null; by: "llm" | "lexical" }> {
    if (this.llm) {
      try {
        const user = `VIDEO: ${req.title || "(untitled)"}\nTHE STUDENT ASKED: "${req.request}"\n\nCHAPTERS:\n${req.chapters.map((c, i) => `${i}. [${c.stamp}] ${c.title}`).join("\n")}`;
        const raw = await this.llm.complete<{ index: number | null }>(CHAPTER_PROMPT, [{ type: "text", text: user }], "chapter_pick", CHAPTER_SCHEMA, 600, "low");
        const index = Number.isInteger(raw.index) && raw.index! >= 0 && raw.index! < req.chapters.length ? raw.index : null;
        logger.info("chapter picked", { index, of: req.chapters.length });
        return { index, by: "llm" };
      } catch (e) {
        logger.warn("chapter pick failed; matching on words", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { index: pickChapterLexical(req.request, req.chapters), by: "lexical" };
  }

  private async read(segments: TranscriptSegment[], title: string): Promise<WatchNote[]> {
    const passes: TranscriptSegment[][] = [[]];
    let chars = 0;
    for (const seg of segments) {
      if (chars > PASS_CHARS && passes.length < MAX_PASSES) {
        passes.push([]);
        chars = 0;
      }
      passes[passes.length - 1].push(seg);
      chars += seg.text.length;
    }
    const at = Date.now();
    const results = await Promise.all(
      passes.map(async (pass, i) => {
        const user = `VIDEO: ${title || "(untitled)"}\nPART ${i + 1} of ${passes.length}, covering ${Math.floor(pass[0].start)}s to ${Math.ceil(pass[pass.length - 1].end)}s.\n\nTRANSCRIPT:\n${stampedTranscript(pass)}`;
        const raw = await this.llm!.complete<{ notes: unknown[] }>(WATCH_PROMPT, [{ type: "text", text: user }], "watch_notes", WATCH_SCHEMA as unknown as Record<string, unknown>, 2500, "low");
        return (raw.notes ?? []).map((n) => parseWatchNote(n, at)).filter((n): n is WatchNote => n !== null);
      }),
    );
    const notes = results.flat().sort((a, b) => a.start - b.start);
    if (!notes.length) throw new Error("watch pass returned no usable notes");
    return notes;
  }
}
