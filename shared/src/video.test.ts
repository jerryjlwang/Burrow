import { describe, it, expect } from "vitest";
import { EMPTY_BUSY, PlaybackTracker, TranscriptBuffer, WatchLog, decideSurface, emptiestRegion, heuristicNotes, parseWatchNote, stampedTranscript, type VideoSignals, type WatchNote } from "./video";

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
    expect(parseWatchNote(null, T0)).toBeNull();
    expect(parseWatchNote({ ...span, gist: "  " }, T0)).toBeNull();
    expect(parseWatchNote({ start: 60, end: 60, gist: "no span" }, T0)).toBeNull();
    expect(parseWatchNote({ gist: "no times" }, T0)).toBeNull();
    const n = parseWatchNote({ ...span, gist: "Defines a variable.", concepts: ["variable", 7], assumes: "x", raise: { kind: "made-up", message: "hey", salience: 1 } }, T0);
    expect(n).toMatchObject({ start: 0, end: 60, gist: "Defines a variable.", concepts: ["variable"], assumes: [], raise: null });
    const ok = parseWatchNote({ ...span, gist: "g", raise: { kind: "crucial", message: "Whatever you do to one side, do to the other.", salience: 7, why: "everything after depends on it" } }, T0);
    expect(ok?.raise).toMatchObject({ kind: "crucial", salience: 1 });
  });
});

describe("decideSurface", () => {
  const base = { proactiveEnabled: true, cooling: false, learnerGap: false, allowPause: true, interruptsLeft: 2 };
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

  it("pauses the video only for a crucial idea, with permission, within budget", () => {
    const crucial = (salience: number) => note({ raise: { kind: "crucial", message: "Whatever you do to one side, you must do to the other.", salience, why: "" } });
    expect(decideSurface({ ...base, note: crucial(0.9), signals: quiet }).surface).toBe("interrupt");
    expect(decideSurface({ ...base, note: crucial(0.9), signals: { ...quiet, paused: true } }).surface).toBe("speak");
    expect(decideSurface({ ...base, allowPause: false, note: crucial(0.9), signals: quiet }).surface).toBe("bubble");
    expect(decideSurface({ ...base, interruptsLeft: 0, note: crucial(0.9), signals: quiet }).surface).toBe("bubble");
    expect(decideSurface({ ...base, cooling: true, note: crucial(0.9), signals: quiet }).surface).toBe("cue");
    // Merely "kind of important" does not earn a pause, and neither does any other kind of note.
    expect(decideSurface({ ...base, note: crucial(0.7), signals: quiet }).surface).toBe("silent");
    expect(decideSurface({ ...base, note: raise(1), signals: quiet }).surface).toBe("cue");
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
    const text = log.format(Infinity, 400);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain("Part 29");
    expect(text).not.toContain("Replaced.");
    expect(log.at(90)?.gist).toContain("Part 1");
  });

  it("only tells the agent about what the student has reached, and finds notes that just came due", () => {
    const log = new WatchLog();
    log.add(note({ start: 0, end: 60, gist: "Intro." }));
    log.add(note({ start: 60, end: 120, gist: "The balance rule.", raise: { kind: "crucial", message: "m", salience: 0.9, why: "" } }));
    log.add(note({ start: 120, end: 180, gist: "Spoilers." }));
    expect(log.format(100)).not.toContain("Spoilers");
    expect(log.due(118, 119.5)).toHaveLength(0);
    expect(log.due(119.5, 120.2).map((n) => n.gist)).toEqual(["The balance rule."]);
    expect(log.due(0, 60)).toHaveLength(0);
  });
});

describe("heuristicNotes", () => {
  it("covers the transcript in spans and raises only what the speaker flags themselves", () => {
    const b: Array<{ start: number; end: number; text: string }> = [];
    for (let s = 0; s < 300; s += 10) b.push({ start: s, end: s + 10, text: s === 130 ? "Remember this: whatever you do to one side, do to the other." : `We carry on with example ${s}.` });
    const notes = heuristicNotes(b, T0);
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(notes[0].start).toBe(0);
    expect(notes[notes.length - 1].end).toBe(300);
    const raised = notes.filter((n) => n.raise);
    expect(raised).toHaveLength(1);
    expect(raised[0].raise).toMatchObject({ kind: "crucial", salience: 0.85 });
    expect(raised[0].raise?.message).toContain("whatever you do to one side");
    expect(raised[0].start).toBeLessThanOrEqual(130);
    // The span ends on the flagged sentence, so that is where a pause would land.
    expect(raised[0].end).toBe(140);
  });
});

describe("stampedTranscript", () => {
  it("groups captions into timestamped lines a model can cite", () => {
    const segs = [0, 5, 10, 15, 20, 70].map((s) => ({ start: s, end: s + 5, text: `line ${s}` }));
    expect(stampedTranscript(segs)).toBe("[0:00] line 0 line 5 line 10\n[0:15] line 15 line 20\n[1:10] line 70");
  });
});

describe("emptiestRegion", () => {
  const COLS = 48;
  const ROWS = 27;
  /** A frame that is flat paper everywhere except a block of busy "content". */
  const frame = (content: { x0: number; x1: number; y0: number; y1: number }) => {
    const luma = new Uint8ClampedArray(COLS * ROWS).fill(230);
    for (let y = content.y0; y < content.y1; y++) for (let x = content.x0; x < content.x1; x++) luma[y * COLS + x] = (x + y) % 2 ? 20 : 240;
    return luma;
  };

  it("puts the drawing on the empty side of the frame, never over the lesson or the controls", () => {
    const contentLeft = emptiestRegion(frame({ x0: 0, x1: 24, y0: 0, y1: ROWS }), COLS, ROWS)!;
    expect(contentLeft.x).toBeGreaterThanOrEqual(0.5);
    expect(contentLeft.busy).toBeLessThan(1);
    const contentRight = emptiestRegion(frame({ x0: 24, x1: COLS, y0: 0, y1: ROWS }), COLS, ROWS)!;
    expect(contentRight.x + contentRight.w).toBeLessThanOrEqual(0.5);
    for (const r of [contentLeft, contentRight]) expect(r.y + r.h).toBeLessThanOrEqual(0.85);
  });

  it("prefers a smaller blank area over a bigger one that clips the lesson's own writing", () => {
    // Writing fills the left 60%: the blank right side is narrower than the biggest candidate, and must still win.
    const r = emptiestRegion(frame({ x0: 0, x1: 29, y0: 0, y1: ROWS }), COLS, ROWS)!;
    expect(r.busy).toBeLessThanOrEqual(EMPTY_BUSY);
    expect(r.x * COLS).toBeGreaterThanOrEqual(29);
  });

  it("says so when only slivers are blank, so the board can lay a scrim under the drawing", () => {
    // A slide with a band of writing across the middle: blank strips above and below, neither tall enough to draw in.
    const slide = emptiestRegion(frame({ x0: 4, x1: 44, y0: 9, y1: 17 }), COLS, ROWS)!;
    expect(slide.h).toBeGreaterThanOrEqual(0.4);
    expect(slide.busy).toBeGreaterThan(EMPTY_BUSY);
  });

  it("takes the biggest canvas a blank frame allows, and reports when nothing is empty", () => {
    const blank = emptiestRegion(new Uint8ClampedArray(COLS * ROWS).fill(40), COLS, ROWS)!;
    expect(blank.w).toBeGreaterThan(0.55);
    expect(blank.h).toBeGreaterThan(0.7);
    const noisy = emptiestRegion(frame({ x0: 0, x1: COLS, y0: 0, y1: ROWS }), COLS, ROWS)!;
    expect(noisy.busy).toBeGreaterThan(EMPTY_BUSY);
    expect(emptiestRegion(new Uint8ClampedArray(4), 2, 2)).toBeNull();
  });
});
