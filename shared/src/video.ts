/**
 * Watching a video alongside the student. Three pieces, all pure (no DOM, no model):
 *  - what was said ({@link TranscriptBuffer}; fed by whichever source a page offers — native text
 *    tracks, a player's rendered captions, tab-audio STT),
 *  - what the student did ({@link PlaybackTracker} → {@link VideoSignals}),
 *  - what the rabbit privately made of it ({@link WatchLog} of {@link WatchNote}s).
 * Thinking and speaking are separate: every watcher pass ends in a note, and {@link decideSurface}
 * decides whether any of it reaches the student. Silence is the default outcome, not a failure.
 */

export interface TranscriptSegment {
  /** Seconds into the video. */
  start: number;
  end: number;
  text: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Ordered transcript. Re-adding a line (replays re-emit captions) is a no-op. */
export class TranscriptBuffer {
  private segs: TranscriptSegment[] = [];
  private keys = new Set<string>();

  add(seg: TranscriptSegment): boolean {
    const text = clean(seg.text);
    if (!text || !Number.isFinite(seg.start)) return false;
    // Half-second buckets: the same caption re-observed after a seek lands a few ms apart.
    const key = `${Math.round(seg.start * 2)}|${text}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    const s = { start: seg.start, end: Math.max(seg.end, seg.start), text };
    let lo = 0;
    let hi = this.segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segs[mid].start <= s.start) lo = mid + 1;
      else hi = mid;
    }
    this.segs.splice(lo, 0, s);
    return true;
  }

  get size(): number {
    return this.segs.length;
  }

  window(from: number, to: number): TranscriptSegment[] {
    return this.segs.filter((s) => s.end >= from && s.start <= to);
  }

  /** Plain text of a span, trimmed from the FRONT when over budget — the latest words matter most. */
  text(from: number, to: number, maxChars = 1800): string {
    const full = this.window(from, to).map((s) => s.text).join(" ");
    return full.length <= maxChars ? full : `…${full.slice(full.length - maxChars + 1)}`;
  }
}

export const VIDEO_THRESHOLDS = {
  /** Backward seeks shorter than this are scrubbing; longer than max are navigation. Neither is "say that again". */
  replayMinS: 3,
  replayMaxS: 120,
  replayWindowMs: 180_000,
  /** A pause this long inside a replayed span reads as working it out, not as a bathroom break… */
  thinkingPauseMs: 8_000,
  /** …and past this the student has simply left. */
  awayMs: 300_000,
  watchSpanS: 60,
  watchMinChars: 240,
};

export interface VideoSignals {
  t: number;
  paused: boolean;
  rate: number;
  /** The span gone back over most — the strongest confusion signal a video gives. */
  replayed?: { start: number; end: number; times: number; lastAt: number };
  pausedMs: number;
  /** Dropped the playback rate below where they started. */
  slowedDown: boolean;
  summary: string[];
  strength: number;
}

interface Seek {
  from: number;
  to: number;
  at: number;
}

/** Cheap local read of how the student is watching. Fed by the video element's own events. */
export class PlaybackTracker {
  private t = 0;
  private paused = true;
  private pausedAt = 0;
  private rate = 1;
  private baseRate: number | null = null;
  private seeks: Seek[] = [];

  time(t: number): void {
    this.t = t;
  }

  play(rate = 1): void {
    this.paused = false;
    this.pausedAt = 0;
    this.baseRate ??= rate;
    this.rate = rate;
  }

  pause(t: number, now: number): void {
    this.t = t;
    this.paused = true;
    this.pausedAt = now;
  }

  rateChange(rate: number): void {
    this.baseRate ??= this.rate;
    this.rate = rate;
  }

  seek(from: number, to: number, now: number): void {
    this.t = to;
    const back = from - to;
    if (back >= VIDEO_THRESHOLDS.replayMinS && back <= VIDEO_THRESHOLDS.replayMaxS) this.seeks.push({ from, to, at: now });
    if (this.seeks.length > 30) this.seeks.splice(0, this.seeks.length - 30);
  }

  /** A new video in the same player (SPA navigation). */
  reset(): void {
    this.t = 0;
    this.seeks = [];
    this.baseRate = null;
    this.pausedAt = 0;
  }

  /** Offer accepted or the span explained: the same replays shouldn't re-fire. */
  clearAfterHelp(): void {
    this.seeks = [];
  }

  snapshot(now: number): VideoSignals {
    const recent = this.seeks.filter((s) => now - s.at <= VIDEO_THRESHOLDS.replayWindowMs);
    // The most-replayed span: the seek overlapped by the most other seeks, widened to cover them.
    let replayed: VideoSignals["replayed"];
    for (const s of recent) {
      const overlapping = recent.filter((o) => o.to < s.from && o.from > s.to);
      if (overlapping.length > (replayed?.times ?? 0)) {
        replayed = { start: Math.min(...overlapping.map((o) => o.to)), end: Math.max(...overlapping.map((o) => o.from)), times: overlapping.length, lastAt: Math.max(...overlapping.map((o) => o.at)) };
      }
    }
    const pausedMs = this.paused && this.pausedAt ? now - this.pausedAt : 0;
    const away = pausedMs >= VIDEO_THRESHOLDS.awayMs;
    const inReplayed = replayed !== undefined && this.t >= replayed.start - 2 && this.t <= replayed.end + 5;
    const thinking = !away && pausedMs >= VIDEO_THRESHOLDS.thinkingPauseMs && inReplayed;
    const slowedDown = this.baseRate !== null && this.rate < this.baseRate && this.rate < 1;

    const summary: string[] = [];
    if (replayed) summary.push(`went back over ${fmtTime(replayed.start)}–${fmtTime(replayed.end)} ${replayed.times}×`);
    if (thinking) summary.push(`paused ${Math.round(pausedMs / 1000)}s on the part they replayed`);
    if (slowedDown) summary.push(`slowed playback to ${this.rate}×`);

    // One replay is ordinary; two earns a glance; three is asking for help without saying so.
    const strength = away ? 0 : Math.min(1, (replayed ? (replayed.times >= 3 ? 0.7 : replayed.times === 2 ? 0.5 : 0.2) : 0) + (thinking ? 0.2 : 0) + (slowedDown ? 0.15 : 0));
    return { t: this.t, paused: this.paused, rate: this.rate, replayed, pausedMs, slowedDown, summary, strength };
  }
}

export function fmtTime(s: number): string {
  const n = Math.max(0, Math.floor(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

export const RAISE_KINDS = ["prerequisite-gap", "dense", "misconception-risk", "check-understanding"] as const;
export type RaiseKind = (typeof RAISE_KINDS)[number];

/** What one silent watcher pass concluded about a span. Never shown or spoken as-is. */
export interface WatchNote {
  start: number;
  end: number;
  /** One sentence: what this stretch taught. */
  gist: string;
  concepts: string[];
  /** Ideas the video took for granted here. */
  assumes: string[];
  /** Something that might be worth the student's attention. null is the expected value. */
  raise: { kind: RaiseKind; message: string; salience: number; why: string } | null;
  at: number;
}

/** Validate a watcher model reply. Anything malformed degrades to "nothing to raise", never to speech. */
export function parseWatchNote(raw: unknown, span: { start: number; end: number }, at: number): WatchNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const gist = typeof r.gist === "string" ? clean(r.gist).slice(0, 240) : "";
  if (!gist) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(clean).filter(Boolean).slice(0, 6) : []);
  let raise: WatchNote["raise"] = null;
  const rr = r.raise as Record<string, unknown> | null | undefined;
  if (rr && typeof rr === "object" && typeof rr.message === "string" && clean(rr.message) && RAISE_KINDS.includes(rr.kind as RaiseKind)) {
    const salience = typeof rr.salience === "number" && Number.isFinite(rr.salience) ? Math.min(1, Math.max(0, rr.salience)) : 0;
    raise = { kind: rr.kind as RaiseKind, message: clean(rr.message).slice(0, 160), salience, why: typeof rr.why === "string" ? clean(rr.why).slice(0, 200) : "" };
  }
  return { start: span.start, end: span.end, gist, concepts: list(r.concepts), assumes: list(r.assumes), raise, at };
}

/** The rabbit's private running understanding of the video. */
export class WatchLog {
  private notes: WatchNote[] = [];

  add(note: WatchNote): void {
    this.notes = this.notes.filter((n) => !(n.start === note.start && n.end === note.end));
    this.notes.push(note);
    this.notes.sort((a, b) => a.start - b.start);
  }

  get all(): readonly WatchNote[] {
    return this.notes;
  }

  get coveredUntil(): number {
    return this.notes.reduce((m, n) => Math.max(m, n.end), 0);
  }

  at(t: number): WatchNote | null {
    return this.notes.find((n) => t >= n.start && t <= n.end) ?? null;
  }

  /** For the agent prompt: what the video has covered so far, so an answer never starts from a cold frame. */
  format(maxChars = 900): string {
    const lines = this.notes.map((n) => `[${fmtTime(n.start)}] ${n.gist}${n.assumes.length ? ` (assumes: ${n.assumes.join(", ")})` : ""}`);
    while (lines.length > 1 && lines.join("\n").length > maxChars) lines.shift();
    return lines.join("\n").slice(0, maxChars);
  }
}

/**
 * The next span worth a silent watcher pass, or null. Runs on newly WATCHED transcript only —
 * never ahead of the student — and straight away when they replay something not yet understood.
 */
export function nextWatchSpan(buffer: TranscriptBuffer, log: WatchLog, signals: VideoSignals): { start: number; end: number } | null {
  if (signals.replayed && signals.replayed.times >= 2 && !log.at((signals.replayed.start + signals.replayed.end) / 2)) {
    const span = { start: Math.max(0, signals.replayed.start - 5), end: signals.replayed.end + 5 };
    return buffer.text(span.start, span.end).length >= 40 ? span : null;
  }
  const start = log.coveredUntil;
  if (signals.t - start < VIDEO_THRESHOLDS.watchSpanS) return null;
  const span = { start, end: signals.t };
  return buffer.text(span.start, span.end, 100_000).length >= VIDEO_THRESHOLDS.watchMinChars ? span : null;
}

export type Surface = "silent" | "cue" | "bubble" | "speak";

export interface SurfaceInput {
  note: WatchNote | null;
  signals: VideoSignals;
  proactiveEnabled: boolean;
  /** Inside a proactive cooldown, or the student recently said "I'm good". */
  cooling: boolean;
  /** The note's concepts/assumptions hit something the learner graph marks shaky or unseen. */
  learnerGap: boolean;
}

/**
 * Whether a private note reaches the student, and how loudly. The model's opinion alone never
 * earns an interruption: it needs corroboration from what the student DID (replays) or what we
 * KNOW about them (a graph gap). Uncorroborated notes are held for the next pause, and nothing
 * is ever spoken over a playing video.
 */
export function decideSurface(x: SurfaceInput): { surface: Surface; hold: boolean; reason: string } {
  if (!x.proactiveEnabled) return { surface: "silent", hold: false, reason: "proactive off" };
  const salience = x.note?.raise?.salience ?? 0;
  const observed = !!x.signals.replayed && x.signals.replayed.times >= 2 && (!x.note || (x.signals.replayed.start <= x.note.end && x.signals.replayed.end >= x.note.start));
  const score = Math.min(1, salience * 0.5 + x.signals.strength * 0.6 + (x.learnerGap ? 0.15 : 0));
  if (score < 0.3) return { surface: "silent", hold: false, reason: "nothing worth raising" };
  if (x.cooling) return { surface: "cue", hold: false, reason: "cooling down: glance only" };
  if (!observed) {
    // The model's view, or a prior from the graph — not trouble anyone has seen. A graph gap lowers
    // the bar, but either way it waits for a natural break instead of cutting into the lesson.
    const strong = salience >= (x.learnerGap ? 0.5 : 0.75);
    if (!strong) return { surface: "silent", hold: false, reason: "unobserved and mild" };
    if (x.signals.paused) return { surface: "bubble", hold: false, reason: "strong note at a pause" };
    return { surface: "cue", hold: true, reason: "unobserved: held for a pause" };
  }
  if (score < 0.5) return { surface: "cue", hold: false, reason: "corroborated but mild" };
  if (x.signals.paused && score >= 0.7) return { surface: "speak", hold: false, reason: "corroborated, strong, and the video is paused" };
  return { surface: "bubble", hold: false, reason: "corroborated" };
}
