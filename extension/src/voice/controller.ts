import { store } from "../content/store";
import { sendToBackground, type ContentBroadcast, type VoiceState } from "../shared/messages";
import { log } from "../shared/logger";

const logger = log("voice");

export interface VoiceCallbacks {
  onFinalTranscript: (text: string) => void;
  onInterimTranscript?: (text: string) => void;
  /** Speech recognition thinks the turn has probably ended (it is not sure yet). */
  onProbableEndOfTurn?: (text: string) => void;
  /** It was wrong: the student kept talking. */
  onTurnResumed?: () => void;
  onSpeechStart?: () => void;
}

/**
 * Content-side voice controller. Audio capture and playback live in the extension's
 * offscreen document (so they survive navigations); this class mirrors state into the UI
 * and turns transcripts into conversation turns.
 */
export class VoiceController {
  private callbacks: VoiceCallbacks;
  private speeches = new Map<string, { resolve: () => void; text: string }>();
  private currentSpeechId: string | null = null;
  private lastTtsEndedAt = 0;
  /** Recent TTS texts, for discriminating the rabbit's own voice from the student's (echo gate). */
  private spokenRecently: { text: string; at: number }[] = [];
  /** Speech queue: the playing sentence finishes; at most ONE unstarted line waits (latest wins). */
  private nextUp: { text: string; resolve: () => void }[] = [];
  private pumping = false;
  /** Dedupe for STT finals the upstream occasionally re-sends. */
  private lastFinalNorm = "";
  private lastFinalAt = 0;
  private voiceErrorShown = false;
  private levelDecay: number | null = null;

  constructor(callbacks: VoiceCallbacks) {
    this.callbacks = callbacks;
  }

  get listening(): boolean {
    return store.getState().voice.mode === "listening";
  }

  get speaking(): boolean {
    return this.currentSpeechId !== null;
  }

  async refreshStatus(): Promise<void> {
    try {
      const state = await sendToBackground({ type: "voice.status" }, 3000);
      this.applyVoiceState(state);
    } catch {
      /* background not ready */
    }
  }

  async start(): Promise<boolean> {
    store.setState((s) => ({ voice: { ...s.voice, mode: "starting" }, status: "Starting microphone…" }));
    try {
      const r = await sendToBackground({ type: "voice.start" }, 15_000);
      this.applyVoiceState(r.state);
      if (!r.ok) logger.warn("voice start failed", { error: r.state.error, code: r.state.errorCode });
      return r.ok;
    } catch (e) {
      logger.error("voice start error", { error: String(e) });
      store.setState((s) => ({ voice: { ...s.voice, mode: "error", error: "Voice is having trouble connecting. You can still type to me.", errorCode: "server" }, status: "" }));
      return false;
    }
  }

  async stop(): Promise<void> {
    try {
      const r = await sendToBackground({ type: "voice.stop" }, 5000);
      this.applyVoiceState(r.state);
    } catch {
      store.setState((s) => ({ voice: { ...s.voice, mode: "off" }, status: "" }));
    }
  }

  async toggle(): Promise<void> {
    if (this.listening || store.getState().voice.mode === "starting") await this.stop();
    else await this.start();
  }

  /** Speaks text via Deepgram TTS (through the offscreen document). Resolves when playback ends or fails. */
  /**
   * Agent speech QUEUES, latest-wins: the in-flight sentence always finishes (audio lives in the
   * offscreen document, so it plays on across tab switches), but only the NEWEST unstarted line
   * waits behind it — stale narration of steps the screen has already moved past is dropped, so
   * speech never lags the action by more than one sentence. Only explicit interrupts (the
   * student's voice, a click on the rabbit, Escape, typed input) cut audio mid-sentence.
   */
  speak(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const replaced = this.nextUp.splice(0, this.nextUp.length, { text, resolve });
      for (const r of replaced) r.resolve();
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.nextUp.length) {
        const item = this.nextUp.shift()!;
        await this.speakNow(item.text).catch(() => undefined);
        item.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }

  private speakNow(text: string): Promise<void> {
    const s = store.getState();
    // No TTS without a configured voice backend or a reachable server: stay quiet, no error noise.
    if (!s.settings.ttsEnabled || !text.trim() || s.voice.deepgram === false || s.voice.serverOk === false) return Promise.resolve();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // The queue guarantees the previous utterance settled; this is only a stale-state guard.
    if (this.currentSpeechId) this.finishSpeech(this.currentSpeechId, "interrupted");
    this.currentSpeechId = id;
    this.spokenRecently = [...this.spokenRecently.slice(-2), { text, at: Date.now() }];
    return new Promise<void>((resolve) => {
      this.speeches.set(id, { resolve, text });
      sendToBackground({ type: "tts.speak", id, text }, 10_000)
        .then((r) => {
          if (!r.ok) this.finishSpeech(id, "error", r.error);
        })
        .catch((e) => this.finishSpeech(id, "error", String(e)));
      // Safety: never leave the character "speaking" forever.
      window.setTimeout(() => this.finishSpeech(id, "ended"), 60_000);
    });
  }

  stopSpeaking(): void {
    // Flush the queued line first so nothing starts up right after the stop.
    for (const r of this.nextUp.splice(0)) r.resolve();
    const id = this.currentSpeechId;
    if (!id) return;
    void sendToBackground({ type: "tts.stop" }, 3000).catch(() => undefined);
    this.finishSpeech(id, "interrupted");
  }

  /**
   * Is this transcript the rabbit hearing itself? Only meaningful while TTS plays (or within a
   * short tail after it ends). An empty start-of-turn during playback is treated as echo too —
   * real interruption asserts itself with words within a beat.
   */
  private isLikelyEcho(text: string): boolean {
    const playing = store.getState().voice.ttsPlaying || Date.now() - this.lastTtsEndedAt < 800;
    if (!playing) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const t = norm(text);
    if (!t) return true;
    const cutoff = Date.now() - 20_000;
    for (const s of this.spokenRecently) {
      if (s.at < cutoff) continue;
      const spoken = norm(s.text);
      if (spoken.includes(t)) return true;
      const tokens = t.split(" ");
      if (tokens.length >= 3 && tokens.filter((w) => spoken.includes(w)).length / tokens.length >= 0.8) return true;
    }
    return false;
  }

  private finishSpeech(id: string, state: "ended" | "error" | "interrupted", error?: string): void {
    const entry = this.speeches.get(id);
    if (!entry) return;
    this.speeches.delete(id);
    if (this.currentSpeechId === id) this.currentSpeechId = null;
    this.lastTtsEndedAt = Date.now();
    if (state === "error" && error && !this.voiceErrorShown) {
      this.voiceErrorShown = true;
      logger.warn("tts error", { error });
      store.setState({ status: "Voice is having trouble right now—I'll keep going in text." });
      window.setTimeout(() => store.setState((s) => (s.status.startsWith("Voice is having") ? { status: "" } : {})), 5000);
    }
    store.setState((s) => ({
      characterState: s.characterState === "speaking" ? (s.voice.mode === "listening" ? "listening" : "idle") : s.characterState,
      audioLevel: 0,
      voice: { ...s.voice, ttsPlaying: false },
    }));
    entry.resolve();
  }

  private applyVoiceState(state: VoiceState): void {
    store.setState((s) => ({
      voice: { ...s.voice, ...state },
      status: state.mode === "listening" ? "Listening…" : s.status === "Starting microphone…" || s.status === "Listening…" ? "" : s.status,
      characterState: state.mode === "listening" && (s.characterState === "idle" || s.characterState === "sleeping") ? "listening" : state.mode === "off" && s.characterState === "listening" ? "idle" : s.characterState,
    }));
  }

  /** Handles broadcasts from the background. Returns true if the message was consumed. */
  handleBroadcast(msg: ContentBroadcast): boolean {
    switch (msg.type) {
      case "voice.state":
        this.applyVoiceState(msg.state);
        return true;
      case "voice.level": {
        if (store.getState().voice.mode !== "listening" || this.currentSpeechId) return true;
        store.setState({ audioLevel: msg.level });
        return true;
      }
      case "voice.transcript": {
        const text = msg.text.trim();
        // Echo gate: while the rabbit speaks (or just finished), drop transcripts of its own voice
        // picked up through the speakers — otherwise it barge-ins on itself, the echo becomes a
        // "user" turn, and it loops saying the same thing forever. Genuinely different speech
        // ("stop", a redirect) passes through and still interrupts.
        if (this.isLikelyEcho(text)) return true;
        if (msg.event === "StartOfTurn" || (!msg.final && text && store.getState().interimTranscript === "")) this.callbacks.onSpeechStart?.();
        if (msg.final) {
          // The upstream sometimes re-sends the same final (session churn); each repeat would
          // spawn a fresh agent turn that cancels the last one mid-speech. One is enough.
          const normFinal = text.toLowerCase().replace(/\s+/g, " ").trim();
          if (normFinal && normFinal === this.lastFinalNorm && Date.now() - this.lastFinalAt < 5000) return true;
          this.lastFinalNorm = normFinal;
          this.lastFinalAt = Date.now();
          store.setState({ interimTranscript: "", debug: { ...store.getState().debug, lastTranscript: text } });
          if (text) this.callbacks.onFinalTranscript(text);
        } else {
          store.setState({ interimTranscript: text });
          this.callbacks.onInterimTranscript?.(text);
          if (msg.event === "EagerEndOfTurn" && text) this.callbacks.onProbableEndOfTurn?.(text);
          else if (msg.event === "TurnResumed") this.callbacks.onTurnResumed?.();
        }
        return true;
      }
      case "tts.state": {
        if (msg.state === "started") {
          if (this.currentSpeechId === msg.id) {
            store.setState((s) => ({ characterState: "speaking", voice: { ...s.voice, ttsPlaying: true } }));
          }
        } else {
          this.finishSpeech(msg.id, msg.state === "error" ? "error" : msg.state === "interrupted" ? "interrupted" : "ended", msg.error);
        }
        return true;
      }
      case "tts.level": {
        if (!this.currentSpeechId) return true;
        store.setState({ audioLevel: msg.level });
        if (this.levelDecay) window.clearTimeout(this.levelDecay);
        this.levelDecay = window.setTimeout(() => store.setState({ audioLevel: 0 }), 250);
        return true;
      }
      default:
        return false;
    }
  }
}
