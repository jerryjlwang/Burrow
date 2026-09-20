/**
 * Offscreen document: owns the microphone (Deepgram Flux STT via our server) and
 * streaming TTS playback. Living here (instead of the page) means voice survives
 * navigations and the mic permission is granted once for the extension origin.
 */
import type { OffscreenCommand, OffscreenEvent } from "../shared/messages";
import { log } from "../shared/logger";

const logger = log("offscreen");
const TTS_SAMPLE_RATE = 24000;
// Frames arrive ~1.5x faster than realtime, so the schedule normally runs well ahead and a small
// lead is enough. After a genuine underrun, though, resuming 20ms out just invites the next one,
// so rebuild a real cushion in that case only — start-of-utterance latency is unaffected.
const APPEND_LEAD = 0.02;
const UNDERRUN_LEAD = 0.15;

function emit(event: OffscreenEvent): void {
  chrome.runtime.sendMessage({ type: "offscreen.event", event }).catch(() => undefined);
}

function wsUrl(serverUrl: string, path: string): string {
  return serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + path;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------- Microphone + STT ----------------
let micStream: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let worklet: AudioWorkletNode | null = null;
let sttWs: WebSocket | null = null;
let sttReconnects = 0;
let micActive = false;
let lastLevelEmit = 0;
let currentServerUrl = "";

/** A granted microphone opens in well under a second; longer means a prompt nobody can see. */
const MIC_GRANT_WAIT_MS = 6000;

async function startMic(serverUrl: string): Promise<{ ok: boolean; error?: string; code?: "permission" | "server" | "device" | "unknown" }> {
  currentServerUrl = serverUrl;
  if (micActive && sttWs?.readyState === WebSocket.OPEN) return { ok: true };
  emit({ type: "mic.state", state: "starting" });
  try {
    // This document can't show Chrome's permission prompt. When one would be needed — a mic allowed
    // with "Allow this time" covers only the tab that asked — the request can sit unanswered, so
    // waiting it out is reported as the permission problem it is, not as a connection failure.
    const request = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const stream = await Promise.race([request, new Promise<null>((r) => setTimeout(() => r(null), MIC_GRANT_WAIT_MS))]);
    if (!stream) {
      void request.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => undefined);
      throw new DOMException("no answer to the microphone request", "NotAllowedError");
    }
    micStream = stream;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const code = name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError" ? "permission" : name === "NotFoundError" || name === "NotReadableError" ? "device" : "unknown";
    const error = code === "permission" ? "Microphone access hasn't been granted yet." : code === "device" ? "I couldn't find a microphone." : `Microphone error: ${name || "unknown"}`;
    emit({ type: "mic.state", state: "error", error, code });
    return { ok: false, error, code };
  }
  try {
    micCtx = new AudioContext({ sampleRate: 16000 });
    await micCtx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
    const source = micCtx.createMediaStreamSource(micStream);
    worklet = new AudioWorkletNode(micCtx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    worklet.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type: "chunk"; buffer: ArrayBuffer } | { type: "level"; level: number };
      if (data.type === "chunk") {
        if (sttWs?.readyState === WebSocket.OPEN) sttWs.send(data.buffer);
      } else if (data.type === "level") {
        const now = Date.now();
        if (now - lastLevelEmit > 90) {
          lastLevelEmit = now;
          emit({ type: "mic.level", level: data.level });
        }
      }
    };
    source.connect(worklet);
    await micCtx.resume();
  } catch (e) {
    stopMic(false);
    const error = `Audio setup failed: ${e instanceof Error ? e.message : String(e)}`;
    emit({ type: "mic.state", state: "error", error, code: "unknown" });
    return { ok: false, error, code: "unknown" };
  }
  micActive = true;
  sttReconnects = 0;
  const ok = await connectStt(serverUrl);
  if (!ok) {
    stopMic(false);
    const error = "Voice is having trouble connecting. You can still type to me.";
    emit({ type: "mic.state", state: "error", error, code: "server" });
    return { ok: false, error, code: "server" };
  }
  emit({ type: "mic.state", state: "listening" });
  return { ok: true };
}

function connectStt(serverUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const ws = new WebSocket(wsUrl(serverUrl, "/ws/stt"));
      ws.binaryType = "arraybuffer";
      sttWs = ws;
      const timeout = setTimeout(() => {
        if (!settled) {
          ws.close();
          finish(false);
        }
      }, 8000);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          clearTimeout(timeout);
          finish(true);
        } else if (msg.type === "transcript") {
          handleTranscript(msg as unknown as { text: string; final: boolean; event: string; turnIndex: number });
        } else if (msg.type === "error") {
          logger.warn("stt error", { message: msg.message });
          if (!settled) {
            clearTimeout(timeout);
            finish(false);
          }
        }
      };
      ws.onerror = () => {
        if (!settled) {
          clearTimeout(timeout);
          finish(false);
        }
      };
      ws.onclose = () => {
        if (sttWs !== ws) return;
        sttWs = null;
        if (!settled) {
          clearTimeout(timeout);
          finish(false);
          return;
        }
        if (micActive) void reconnectStt();
      };
    } catch {
      finish(false);
    }
  });
}

async function reconnectStt(): Promise<void> {
  if (!micActive) return;
  if (sttReconnects >= 3) {
    stopMic(false);
    emit({ type: "mic.state", state: "error", error: "Voice is having trouble connecting. You can still type to me.", code: "server" });
    return;
  }
  sttReconnects++;
  await new Promise((r) => setTimeout(r, 400 * sttReconnects));
  if (!micActive) return;
  const ok = await connectStt(currentServerUrl);
  if (ok) {
    sttReconnects = 0;
    emit({ type: "mic.state", state: "listening" });
  }
}

function stopMic(announce = true): void {
  micActive = false;
  try {
    worklet?.port.close();
    worklet?.disconnect();
  } catch {
    /* ignore */
  }
  worklet = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void micCtx?.close().catch(() => undefined);
  micCtx = null;
  const ws = sttWs;
  sttWs = null;
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  if (announce) emit({ type: "mic.state", state: "stopped" });
}

// ---------------- Transcripts + barge-in ----------------
let lastSpokenText = "";
let lastSpokenAt = 0;

function looksLikeEcho(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  const spoken = normalize(lastSpokenText);
  if (!spoken) return false;
  const recentlySpoken = Date.now() - lastSpokenAt < 8000 || currentTts !== null;
  if (!recentlySpoken) return false;
  const words = t.split(" ");
  // A lone word while audio is actually playing is almost always our own voice coming back
  // through the speakers. The multi-word heuristics below can't judge a single token, and
  // letting it through lets Bunny barge in on itself mid-sentence.
  if (words.length === 1) return currentTts !== null && spoken.includes(t);
  if (words.length >= 2 && spoken.includes(t)) return true;
  if (words.length >= 4) {
    // Most of the words appear in the spoken text in order → echo.
    let idx = 0;
    let hits = 0;
    for (const w of words) {
      const found = spoken.indexOf(w, idx);
      if (found >= 0) {
        hits++;
        idx = found + w.length;
      }
    }
    return hits / words.length > 0.8;
  }
  return false;
}

function handleTranscript(msg: { text: string; final: boolean; event: string; turnIndex: number }): void {
  const text = (msg.text ?? "").trim();
  if (currentTts || Date.now() - lastSpokenAt < 1500) {
    if (looksLikeEcho(text)) {
      logger.debug("dropping echo transcript", { text });
      return;
    }
    // Two words (or one confirmed final) before we cut Bunny off: a single interim token is far
    // more often speaker bleed than a real interruption.
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (currentTts && (wordCount >= 2 || (msg.final && wordCount >= 1)) && (msg.event === "StartOfTurn" || msg.event === "Update" || msg.event === "EagerEndOfTurn" || msg.final)) {
      logger.info("barge-in: interrupting speech");
      stopTts("interrupted");
    }
  }
  if (!text && !msg.final) return;
  emit({ type: "transcript", text, final: msg.final, event: msg.event, turnIndex: msg.turnIndex });
}

// ---------------- TTS playback ----------------
let ttsWs: WebSocket | null = null;
let ttsConnecting: Promise<WebSocket | null> | null = null;
let playCtx: AudioContext | null = null;
let activeStreamId: string | null = null;
interface ActiveTts {
  id: string;
  nextTime: number;
  sources: AudioBufferSourceNode[];
  started: boolean;
  timers: number[];
  endTimer: number | null;
}
let currentTts: ActiveTts | null = null;

function ensurePlayCtx(): AudioContext {
  // Deliberately NOT pinned to TTS_SAMPLE_RATE. Forcing a non-native rate here while the mic
  // context (16kHz) and the echo canceller are live makes Chrome resample playback through the
  // AEC render path, which warbles and breaks up. The buffers below carry their own 24kHz rate,
  // and Web Audio resamples them cleanly into whatever the output device actually runs at.
  if (!playCtx) playCtx = new AudioContext();
  if (playCtx.state === "suspended") void playCtx.resume();
  return playCtx;
}

function connectTts(serverUrl: string): Promise<WebSocket | null> {
  if (ttsWs && ttsWs.readyState === WebSocket.OPEN) return Promise.resolve(ttsWs);
  if (ttsConnecting) return ttsConnecting;
  ttsConnecting = new Promise((resolve) => {
    let done = false;
    const finish = (ws: WebSocket | null) => {
      if (done) return;
      done = true;
      ttsConnecting = null;
      resolve(ws);
    };
    try {
      const ws = new WebSocket(wsUrl(serverUrl, "/ws/tts"));
      ws.binaryType = "arraybuffer";
      const timeout = setTimeout(() => {
        ws.close();
        finish(null);
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timeout);
        ttsWs = ws;
        finish(ws);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        finish(null);
      };
      ws.onclose = () => {
        if (ttsWs === ws) ttsWs = null;
        if (currentTts) finishTts("error", "voice connection closed");
        finish(null);
      };
      ws.onmessage = (ev) => onTtsMessage(ev);
    } catch {
      finish(null);
    }
  });
  return ttsConnecting;
}

function onTtsMessage(ev: MessageEvent): void {
  if (typeof ev.data === "string") {
    let msg: { type: string; id?: string; message?: string };
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "start") activeStreamId = msg.id ?? null;
    else if (msg.type === "done" && currentTts && msg.id === currentTts.id) scheduleEnd();
    else if (msg.type === "cancelled" && currentTts && msg.id === currentTts.id) finishTts("interrupted");
    else if (msg.type === "error") {
      if (currentTts && (!msg.id || msg.id === currentTts.id)) finishTts("error", msg.message);
    }
    return;
  }
  if (!(ev.data instanceof ArrayBuffer) || !currentTts || activeStreamId !== currentTts.id) return;
  playChunk(ev.data);
}

function playChunk(buffer: ArrayBuffer): void {
  const tts = currentTts;
  if (!tts || buffer.byteLength < 2) return;
  const ctx = ensurePlayCtx();
  const int16 = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  const audio = ctx.createBuffer(1, int16.length, TTS_SAMPLE_RATE);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  const behind = tts.nextTime > 0 && tts.nextTime < ctx.currentTime;
  const startAt = Math.max(ctx.currentTime + (behind ? UNDERRUN_LEAD : APPEND_LEAD), tts.nextTime);
  source.start(startAt);
  tts.nextTime = startAt + audio.duration;
  tts.sources.push(source);
  source.onended = () => {
    const i = tts.sources.indexOf(source);
    if (i >= 0) tts.sources.splice(i, 1);
  };
  if (!tts.started) {
    tts.started = true;
    const delay = Math.max(0, (startAt - ctx.currentTime) * 1000);
    tts.timers.push(window.setTimeout(() => emit({ type: "tts.state", id: tts.id, state: "started" }), delay));
  }
  // Level metering: 100ms windows scheduled at their playback time.
  const win = Math.round(TTS_SAMPLE_RATE * 0.1);
  for (let off = 0; off < int16.length; off += win) {
    let sum = 0;
    const end = Math.min(int16.length, off + win);
    for (let i = off; i < end; i++) {
      const v = int16[i] / 0x8000;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / Math.max(1, end - off)) * 3.5);
    const at = startAt + off / TTS_SAMPLE_RATE;
    tts.timers.push(window.setTimeout(() => currentTts === tts && emit({ type: "tts.level", level }), Math.max(0, (at - ctx.currentTime) * 1000)));
  }
}

function scheduleEnd(): void {
  const tts = currentTts;
  if (!tts) return;
  const ctx = ensurePlayCtx();
  const remaining = Math.max(0, (tts.nextTime - ctx.currentTime) * 1000) + 60;
  if (tts.endTimer) window.clearTimeout(tts.endTimer);
  tts.endTimer = window.setTimeout(() => currentTts === tts && finishTts("ended"), remaining);
}

function finishTts(state: "ended" | "interrupted" | "error", error?: string): void {
  const tts = currentTts;
  if (!tts) return;
  currentTts = null;
  for (const s of tts.sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  for (const t of tts.timers) window.clearTimeout(t);
  if (tts.endTimer) window.clearTimeout(tts.endTimer);
  lastSpokenAt = Date.now();
  emit({ type: "tts.state", id: tts.id, state, error });
}

async function speak(id: string, text: string, serverUrl: string): Promise<{ ok: boolean; error?: string }> {
  if (currentTts) stopTts("interrupted");
  const ws = await connectTts(serverUrl);
  if (!ws) return { ok: false, error: "Voice is having trouble connecting." };
  ensurePlayCtx();
  lastSpokenText = text;
  lastSpokenAt = Date.now();
  currentTts = { id, nextTime: 0, sources: [], started: false, timers: [], endTimer: null };
  activeStreamId = null;
  ws.send(JSON.stringify({ type: "speak", id, text }));
  // If nothing arrives for a while, fail gracefully so the UI never sticks in "speaking".
  const tts = currentTts;
  tts.timers.push(
    window.setTimeout(() => {
      if (currentTts === tts && !tts.started) finishTts("error", "no audio received");
    }, 15_000),
  );
  return { ok: true };
}

function stopTts(reason: "interrupted" | "ended" = "interrupted"): void {
  const tts = currentTts;
  if (!tts) return;
  if (ttsWs?.readyState === WebSocket.OPEN) ttsWs.send(JSON.stringify({ type: "cancel", id: tts.id }));
  finishTts(reason);
}

// ---------------- Command handling ----------------
async function handle(cmd: OffscreenCommand): Promise<unknown> {
  switch (cmd.type) {
    case "ping":
      return { ok: true, mic: micActive, tts: !!currentTts };
    case "mic.start":
      return startMic(cmd.serverUrl);
    case "mic.stop":
      stopMic(true);
      return { ok: true };
    case "tts.speak":
      return speak(cmd.id, cmd.text, cmd.serverUrl);
    case "tts.stop":
      stopTts("interrupted");
      return { ok: true };
    default:
      return { ok: false, error: "unknown command" };
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || (msg as { target?: string }).target !== "offscreen") return;
  handle(msg as OffscreenCommand).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

logger.info("offscreen audio ready");
