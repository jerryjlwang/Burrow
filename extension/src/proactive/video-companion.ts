import type { PendingOffer } from "@shared/types";
import { TranscriptBuffer, VIDEO_THRESHOLDS, WatchLog, decideSurface, fmtTime, parseVideoTime, type TranscriptSegment, type VideoContext, type VideoOp, type WatchNote } from "@shared/video";
import type { ActionResult } from "@shared/types";
import { VideoWatcher } from "../page-understanding/video";
import { THRESHOLDS } from "./signals";
import { store, type Bubble } from "../content/store";
import { sendToBackground } from "../shared/messages";
import { log } from "../shared/logger";
import type { Session } from "../agent/session";
import type { Settings } from "../shared/settings";

const logger = log("video");
/** Let them settle into the video before asking whether the rabbit may watch along. */
const CONSENT_AFTER_S = 20;

export interface VideoCompanionDeps {
  session: Session;
  /** True while the agent loop runs, a confirmation or offer is pending, or the rabbit is speaking. */
  isBusy: () => boolean;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  showBubble: (bubble: Bubble) => void;
  clearBubble: (id: string) => void;
  onOffer: (offer: PendingOffer) => void;
  /** Run the agent on the rabbit's own initiative (the student accepted "tell me more"). */
  explain: (goal: string) => void;
  updateSetting: (patch: Partial<Settings>) => Promise<void>;
}

/**
 * Watches a video alongside the student — almost entirely in silence. The work happens up front
 * and under the hood: the transcript is read once into private notes (server), what the student
 * watches feeds the learner graph, and replays are tracked locally. The student hears from the
 * rabbit only when {@link decideSurface} says a note has earned it; with their standing
 * permission that can mean pausing the video for the one idea everything else hangs on.
 */
export class VideoCompanion {
  readonly watcher: VideoWatcher;
  private buffer = new TranscriptBuffer();
  private log = new WatchLog();
  private hasTranscript = false;
  private key: string | null = null;
  private analysing: string | null = null;
  private analysed: string | null = null;
  /** Notes already acted on (by start time), so each is raised at most once per video. */
  private surfaced = new Set<number>();
  /** Notes already folded into the learner graph. */
  private absorbed = new Set<number>();
  /** Notes that earned attention but are waiting for the student to pause. */
  private held: WatchNote[] = [];
  private struggledSpans = new Set<number>();
  private interruptsUsed = 0;
  private lastInterruptAt = 0;
  private pausedByUs = false;
  private interruptBubbleId: string | null = null;
  private consentAsked = false;
  private cueTimer: number | null = null;

  constructor(private deps: VideoCompanionDeps) {
    this.watcher = new VideoWatcher({
      onVideo: (key) => this.handleVideo(key),
      onProgress: (from, to) => this.handleProgress(from, to),
      onBehaviour: () => this.handleBehaviour(),
    });
  }

  stop(): void {
    this.watcher.stop();
    if (this.cueTimer) window.clearTimeout(this.cueTimer);
  }

  /** What the agent is told when the student speaks while a video is up; null when there is none. */
  context(): VideoContext | null {
    if (!this.watcher.active) return null;
    // Watching along may be switched off, but a student who ASKS about the video still deserves a grounded answer (from their next question on).
    if (this.key) void this.analyse(this.key);
    const signals = this.watcher.signals(Date.now());
    return {
      t: signals.t,
      duration: this.watcher.duration,
      paused: signals.paused,
      heard: this.buffer.text(signals.t - 75, signals.t),
      // Snapped to five minutes so a windowed transcript (a very long video) stays the same text, and cacheable, between turns.
      transcript: this.buffer.stamped(Math.round(signals.t / 300) * 300),
      understanding: this.log.format(Infinity, 4000),
      behaviour: signals.summary,
      hasTranscript: this.hasTranscript,
    };
  }

  /** The agent working the player because the student asked it to. */
  control(op: VideoOp, arg: string | null): ActionResult {
    const w = this.watcher;
    if (!w.active) return { ok: false, message: "there is no video on this page to control", elementFound: true };
    if (op === "pause") w.pause();
    else if (op === "play") w.play();
    else if (op === "speed") w.setRate(Number(arg));
    else {
      const to = w.seek(parseVideoTime(arg ?? "", w.time) ?? NaN);
      if (to === null || Number.isNaN(to)) return { ok: false, message: `could not seek to "${arg}"`, elementFound: true };
      return { ok: true, message: `video is now at ${fmtTime(to)} of ${fmtTime(w.duration)}`, changed: true, elementFound: true };
    }
    return { ok: true, message: op === "speed" ? `video speed is now ${w.rate}` : `video ${op === "pause" ? "paused" : "playing"} at ${fmtTime(w.time)}`, changed: true, elementFound: true };
  }

  private get settings(): Settings {
    return store.getState().settings;
  }

  private get mayRaise(): boolean {
    return this.settings.proactiveEnabled && this.settings.videoCompanion === "on";
  }

  private handleVideo(key: string | null): void {
    this.buffer = new TranscriptBuffer();
    this.log = new WatchLog();
    this.hasTranscript = false;
    this.surfaced.clear();
    this.absorbed.clear();
    this.struggledSpans.clear();
    this.held = [];
    this.interruptsUsed = 0;
    this.pausedByUs = false;
    this.key = key;
    this.analysed = null;
    if (key && this.settings.videoCompanion !== "off") void this.analyse(key);
  }

  /** Read the whole video once, up front, so nothing has to be worked out while the student waits. */
  private async analyse(key: string): Promise<void> {
    if (this.analysing === key || this.analysed === key) return;
    this.analysing = key;
    try {
      const segments: TranscriptSegment[] = await this.watcher.nativeSegments();
      const result = await sendToBackground({ type: "video.analyze", request: { url: location.href, title: document.title, segments: segments.length ? segments : undefined } }, 90_000);
      if (this.analysing !== key) return;
      for (const seg of result.segments) this.buffer.add(seg);
      for (const note of result.notes) this.log.add(note);
      this.hasTranscript = result.segments.length > 0;
      this.analysed = key;
      logger.info("watching along", { transcript: result.transcript, notesBy: result.notesBy, notes: result.notes.length, raises: result.notes.filter((n) => n.raise).length });
    } catch (e) {
      logger.warn("video analysis unavailable", { error: String(e) });
    } finally {
      if (this.analysing === key) this.analysing = null;
    }
  }

  private handleProgress(from: number, to: number): void {
    if (to >= CONSENT_AFTER_S && this.hasTranscript) this.maybeAskConsent();
    for (const note of this.log.all) {
      if (note.end > from && note.end <= to) this.absorb(note);
    }
    for (const note of this.log.due(from, to)) this.consider(note);
  }

  private handleBehaviour(): void {
    const signals = this.watcher.signals(Date.now());
    // Their own press of play after our pause is an answer: carry on, quietly. (Judged on the
    // play event — pausing emits a trailing timeupdate that would otherwise look like progress.)
    if (this.pausedByUs && !signals.paused) {
      this.deps.stopSpeaking();
      this.endInterrupt(false);
    }
    if (signals.replayed && signals.replayed.times >= 2) {
      const note = this.log.at((signals.replayed.start + signals.replayed.end) / 2);
      if (signals.replayed.times >= 3 && note && !this.struggledSpans.has(note.start)) {
        this.struggledSpans.add(note.start);
        for (const concept of note.concepts.slice(0, 2)) this.deps.session.record({ kind: "struggle", concept, at: Date.now() });
      }
      // Going back over something is the student raising their hand; a span with no note of its own still gets a generic offer.
      this.consider(note ?? this.replayNote(signals.replayed.start, signals.replayed.end));
    }
    if (signals.paused && this.held.length) {
      const waiting = this.held;
      this.held = [];
      for (const note of waiting) this.consider(note);
    }
  }

  private replayNote(start: number, end: number): WatchNote {
    return { start, end, gist: "", concepts: [], assumes: [], raise: { kind: "dense", message: `Want me to go over that bit around ${fmtTime(start)}?`, salience: 0.5, why: "replayed" }, at: Date.now() };
  }

  /** Silent work: what they just watched becomes part of what we know about them. */
  private absorb(note: WatchNote): void {
    if (this.absorbed.has(note.start) || !note.concepts.length) return;
    this.absorbed.add(note.start);
    const concepts = note.concepts.map((label, i) => ({ label, salience: i === 0 ? 0.8 : 0.5 }));
    const edges = note.assumes.map((from) => ({ from, to: note.concepts[0], type: "prerequisite" as const, weight: 0.5 }));
    this.deps.session.record({ kind: "extraction", extraction: { concepts, edges, misconceptions: [] }, ctx: { url: location.href, title: document.title, kind: "page" }, at: Date.now() });
  }

  private learnerGap(note: WatchNote): boolean {
    const graph = this.deps.session.graph;
    return [...note.assumes, ...note.concepts].some((label) => {
      const id = graph.resolve(label);
      const node = id ? graph.get(id) : null;
      return !!node && (node.misconceptions.some((m) => m.status === "active") || (node.state.struggles > 0 && node.state.mastery < 0.4));
    });
  }

  private consider(note: WatchNote): void {
    if (this.surfaced.has(note.start) || !this.mayRaise) return;
    const now = Date.now();
    const signals = this.watcher.signals(now);
    const verdict = decideSurface({
      note,
      signals,
      proactiveEnabled: true,
      cooling: now < this.deps.session.proactiveCooldownUntil,
      learnerGap: this.learnerGap(note),
      allowPause: true,
      interruptsLeft: now - this.lastInterruptAt < VIDEO_THRESHOLDS.interruptGapMs ? 0 : VIDEO_THRESHOLDS.interruptsPerVideo - this.interruptsUsed,
    });
    logger.debug("considered", { at: fmtTime(note.end), kind: note.raise?.kind, surface: verdict.surface, hold: verdict.hold, reason: verdict.reason });
    if (verdict.hold && !this.held.includes(note)) this.held.push(note);
    if (verdict.surface === "silent" || !note.raise) return;
    if (verdict.surface === "cue") return this.cue();
    // Anything louder than a glance waits its turn; a held note is retried at the next pause.
    if (this.deps.isBusy()) {
      if (!this.held.includes(note)) this.held.push(note);
      return;
    }
    this.surfaced.add(note.start);
    this.held = this.held.filter((n) => n !== note);
    this.deps.session.setCooldown(now + THRESHOLDS.cooldownMs);
    // Raised once; the same replays must not raise it again.
    this.watcher.tracker.clearAfterHelp();
    this.deps.session.record({ kind: "offer", offer: `video:${note.raise.kind}`, outcome: "shown", at: now });
    if (verdict.surface === "interrupt" || (verdict.surface === "speak" && note.raise.kind === "crucial")) return this.interrupt(note, verdict.surface === "interrupt");
    this.offer(note, verdict.surface === "speak");
  }

  private cue(): void {
    const rect = this.watcher.rect;
    store.setState({ attention: 1, lookAt: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null });
    if (this.cueTimer) window.clearTimeout(this.cueTimer);
    this.cueTimer = window.setTimeout(() => store.setState((s) => (s.attention === 1 ? { attention: 0, lookAt: null } : {})), 3000);
  }

  private explainGoal(note: WatchNote): string {
    return `The student is watching a video and wants the part from ${fmtTime(note.start)} to ${fmtTime(note.end)} explained${note.gist ? ` ("${note.gist}")` : ""}. Use the VIDEO section: explain that stretch in a small, clear way in your own words, and sketch the steps if it is maths. Do not recap the whole video.`;
  }

  private offer(note: WatchNote, aloud: boolean): void {
    const message = note.raise!.message;
    this.deps.onOffer({ type: "explain", message, elementId: null, at: Date.now(), goal: this.explainGoal(note) });
    if (aloud && this.settings.ttsEnabled) void this.deps.speak(message);
  }

  /** The loudest thing the rabbit does: stop the video and say the one idea that matters. */
  private interrupt(note: WatchNote, pause: boolean): void {
    const message = note.raise!.message;
    if (pause) {
      this.watcher.pause();
      this.pausedByUs = true;
      this.interruptsUsed++;
      this.lastInterruptAt = Date.now();
    }
    logger.info("interrupt", { at: fmtTime(note.end), paused: pause, message });
    this.deps.session.addTurn({ role: "companion", text: message, at: Date.now(), kind: "offer" });
    const id = `video-interrupt-${note.start}`;
    this.interruptBubbleId = id;
    this.deps.showBubble({
      id,
      text: message,
      kind: "offer",
      actions: [
        { label: pause ? "Got it — keep watching" : "Got it", value: "accept", primary: true },
        { label: "Tell me more", value: "open" },
      ],
      onAction: (value) => {
        this.deps.stopSpeaking();
        if (value === "open") {
          this.pausedByUs = false;
          this.watcher.tracker.clearAfterHelp();
          this.deps.explain(this.explainGoal(note));
        } else this.endInterrupt(value === "accept");
      },
    });
    if (this.settings.ttsEnabled) void this.deps.speak(message);
  }

  private endInterrupt(resume: boolean): void {
    const ours = this.pausedByUs;
    this.pausedByUs = false;
    if (this.interruptBubbleId) this.deps.clearBubble(this.interruptBubbleId);
    this.interruptBubbleId = null;
    if (resume && ours) this.watcher.play();
  }

  /** Standing permission, asked once: after this the rabbit never asks before watching along again. */
  private maybeAskConsent(): void {
    if (this.consentAsked || this.settings.videoCompanion !== "ask" || !this.settings.proactiveEnabled || this.deps.isBusy()) return;
    this.consentAsked = true;
    const id = "video-consent";
    this.deps.showBubble({
      id,
      text: "Want me to watch along? I'll stay quiet — unless something really matters, then I might pause it for a second.",
      kind: "offer",
      actions: [
        { label: "Sure", value: "accept", primary: true },
        { label: "No thanks", value: "decline" },
      ],
      expiresAt: Date.now() + 25_000,
      onAction: (value) => {
        this.deps.clearBubble(id);
        if (value === "accept" || value === "decline") void this.deps.updateSetting({ videoCompanion: value === "accept" ? "on" : "off" });
      },
    });
  }
}
