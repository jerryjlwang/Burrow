import { describe, it, expect } from "vitest";
import { PlaybackTracker, TranscriptBuffer, WatchLog, decideSurface, nextWatchSpan, parseWatchNote, type VideoSignals, type WatchNote } from "./video";

const T0 = 1_700_000_000_000;

function lecture(buffer: TranscriptBuffer, untilS: number): void {
  for (let s = 0; s < untilS; s += 5) buffer.add({ start: s, end: s + 5, text: `so at second ${s} we move the term across and keep both sides balanced` });
}

const quiet: VideoSignals = { t: 0, paused: false, rate: 1, pausedMs: 0, slowedDown: false, summary: [], strength: 0 };
const note = (over: Partial<WatchNote> = {}): WatchNote => ({ start: 60, end: 120, gist: "Isolating x by undoing operations.", concepts: ["inverse operations"], assumes: ["negative numbers"], raise: null, at: T0, ...over });

describe("TranscriptBuffer", () => {
  it("keeps order whatever order sources deliver in, and ignores replays of the same line", () => {
    const b = new TranscriptBuffer();
    b.add({ start: 10, end: 14, text: "second" });
    b.add({ start: 2, end: 6, text: "first" });
    expect(b.add({ start: 10.2, end: 14, text: " second " })).toBe(false);
    expect(b.add({ start: NaN, end: 1, text: "junk" })).toBe(false);
    expect(b.size).toBe(2);
    expect(b.text(0, 20)).toBe("first second");
  });

  it("trims an over-budget window from the front so the latest words survive", () => {
    const b = new TranscriptBuffer();
    lecture(b, 300);
    const text = b.text(0, 300, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith("…")).toBe(true);
    expect(text).toContain("second 295");
  });
});

describe("PlaybackTracker", () => {
  it("is silent for ordinary watching, including one replay and scrubbing", () => {
    const p = new PlaybackTracker();
    p.play();
    p.seek(90, 70, T0); // one replay: ordinary
    p.seek(100, 99, T0 + 1000); // scrub
    p.seek(400, 30, T0 + 2000); // navigation
    const s = p.snapshot(T0 + 3000);
    expect(s.replayed?.times).toBe(1);
    expect(s.strength).toBeLessThan(0.3);
  });

  it("escalates when the same span is gone back over, and again when they stop to think on it", () => {
    const p = new PlaybackTracker();
    p.play();
    p.seek(95, 75, T0);
    p.seek(96, 78, T0 + 25_000);
    expect(p.snapshot(T0 + 26_000).strength).toBe(0.5);
    p.seek(97, 74, T0 + 50_000);
    const three = p.snapshot(T0 + 51_000);
    expect(three.replayed).toMatchObject({ start: 74, end: 97, times: 3 });
    expect(three.strength).toBe(0.7);
    p.pause(88, T0 + 60_000);
    const thinking = p.snapshot(T0 + 70_000);
    expect(thinking.strength).toBeCloseTo(0.9);
    expect(thinking.summary.join(" ")).toMatch(/went back over 1:14–1:37 3×.*paused 10s/);
  });

  it("treats a long pause as the student having left, and forgets old replays", () => {
    const p = new PlaybackTracker();
    p.play();
    p.seek(95, 75, T0);
    p.seek(96, 78, T0 + 1000);
    p.pause(80, T0 + 2000);
    expect(p.snapshot(T0 + 2000 + 6 * 60_000).strength).toBe(0);
    p.play();
    expect(p.snapshot(T0 + 10 * 60_000).replayed).toBeUndefined();
  });

  it("does not count replays of different parts of the video together", () => {
    const p = new PlaybackTracker();
    p.play();
    p.seek(60, 50, T0);
    p.seek(300, 290, T0 + 1000);
    expect(p.snapshot(T0 + 2000).replayed?.times).toBe(1);
  });
});

describe("parseWatchNote", () => {
  it("degrades malformed replies to nothing-to-raise, never to speech", () => {
    const span = { start: 0, end: 60 };
    expect(parseWatchNote(null, span, T0)).toBeNull();
    expect(parseWatchNote({ gist: "  " }, span, T0)).toBeNull();
    const n = parseWatchNote({ gist: "Defines a variable.", concepts: ["variable", 7], assumes: "x", raise: { kind: "made-up", message: "hey", salience: 1 } }, span, T0);
    expect(n).toMatchObject({ gist: "Defines a variable.", concepts: ["variable"], assumes: [], raise: null });
    const ok = parseWatchNote({ gist: "g", raise: { kind: "dense", message: "That went fast.", salience: 7, why: "three steps in ten seconds" } }, span, T0);
    expect(ok?.raise).toMatchObject({ kind: "dense", salience: 1 });
  });
});

describe("nextWatchSpan", () => {
  it("waits for a minute of newly watched speech and never runs ahead of the student", () => {
    const b = new TranscriptBuffer();
    lecture(b, 600);
    const log = new WatchLog();
    expect(nextWatchSpan(b, log, { ...quiet, t: 40 })).toBeNull();
    expect(nextWatchSpan(b, log, { ...quiet, t: 65 })).toEqual({ start: 0, end: 65 });
    log.add(note({ start: 0, end: 65 }));
    expect(nextWatchSpan(b, log, { ...quiet, t: 100 })).toBeNull();
    expect(nextWatchSpan(b, log, { ...quiet, t: 130 })).toEqual({ start: 65, end: 130 });
  });

  it("jumps straight to a replayed span that isn't understood yet, once", () => {
    const b = new TranscriptBuffer();
    lecture(b, 600);
    const log = new WatchLog();
    log.add(note({ start: 0, end: 60 }));
    const signals = { ...quiet, t: 80, replayed: { start: 70, end: 95, times: 2, lastAt: T0 }, strength: 0.5 };
    expect(nextWatchSpan(b, log, signals)).toEqual({ start: 65, end: 100 });
    log.add(note({ start: 65, end: 100 }));
    expect(nextWatchSpan(b, log, signals)).toBeNull();
  });

  it("does nothing for a video with no words to read", () => {
    expect(nextWatchSpan(new TranscriptBuffer(), new WatchLog(), { ...quiet, t: 500 })).toBeNull();
  });
});

describe("decideSurface", () => {
  const base = { proactiveEnabled: true, cooling: false, learnerGap: false };
  const raise = (salience: number) => note({ raise: { kind: "dense", message: "That step went by fast — want it drawn out?", salience, why: "" } });
  const replayed = (times: number, paused = false): VideoSignals => ({ ...quiet, t: 90, paused, replayed: { start: 75, end: 97, times, lastAt: T0 }, strength: times >= 3 ? 0.7 : 0.5 });

  it("stays silent for a pass with nothing to raise — the expected outcome", () => {
    expect(decideSurface({ ...base, note: note(), signals: quiet }).surface).toBe("silent");
    expect(decideSurface({ ...base, note: null, signals: quiet }).surface).toBe("silent");
  });

  it("never interrupts on the model's opinion alone: holds it for a pause, and only if strong", () => {
    expect(decideSurface({ ...base, note: raise(0.6), signals: quiet })).toMatchObject({ surface: "silent", hold: false });
    expect(decideSurface({ ...base, note: raise(0.9), signals: quiet })).toMatchObject({ surface: "cue", hold: true });
    expect(decideSurface({ ...base, note: raise(0.9), signals: { ...quiet, paused: true } }).surface).toBe("bubble");
  });

  it("offers once behaviour corroborates, and only speaks when the video is paused", () => {
    expect(decideSurface({ ...base, note: raise(0.6), signals: replayed(2) }).surface).toBe("bubble");
    expect(decideSurface({ ...base, note: raise(0.8), signals: replayed(3) }).surface).toBe("bubble");
    expect(decideSurface({ ...base, note: raise(0.8), signals: replayed(3, true) }).surface).toBe("speak");
  });

  it("a replay of a different part of the video does not corroborate this note", () => {
    const elsewhere: VideoSignals = { ...quiet, t: 400, replayed: { start: 380, end: 400, times: 2, lastAt: T0 }, strength: 0.5 };
    expect(decideSurface({ ...base, note: raise(0.6), signals: elsewhere }).surface).toBe("silent");
  });

  it("a known gap in the learner graph corroborates a note without any replay", () => {
    expect(decideSurface({ ...base, learnerGap: true, note: raise(0.7), signals: quiet }).surface).toBe("cue");
    expect(decideSurface({ ...base, learnerGap: true, note: raise(0.9), signals: { ...quiet, paused: true } }).surface).toBe("bubble");
  });

  it("respects the off switch and cooldowns", () => {
    expect(decideSurface({ ...base, proactiveEnabled: false, note: raise(1), signals: replayed(3, true) }).surface).toBe("silent");
    expect(decideSurface({ ...base, cooling: true, note: raise(1), signals: replayed(3, true) }).surface).toBe("cue");
  });
});

describe("WatchLog", () => {
  it("formats the running understanding for the prompt, dropping the oldest notes first", () => {
    const log = new WatchLog();
    for (let i = 0; i < 30; i++) log.add(note({ start: i * 60, end: i * 60 + 60, gist: `Part ${i} explains one more rule for balancing equations.`, assumes: [] }));
    log.add(note({ start: 0, end: 60, gist: "Replaced.", assumes: [] }));
    expect(log.all).toHaveLength(30);
    const text = log.format(400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain("Part 29");
    expect(text).not.toContain("Replaced.");
    expect(log.at(90)?.gist).toContain("Part 1");
  });
});
