import type { AgentInput, AgentOutput, InterventionInput, InterventionOutput, ConversationTurn, StudentSessionState, ActionRecord, PendingOffer } from "@shared/types";
import type { ApplyContext, ConceptExtraction, ExtractionInput } from "@shared/concepts";
import type { GraphSnapshot, ResolutionMethod } from "@shared/graph";
import type { InkJudgement } from "@shared/ink";
import type { Settings } from "./settings";

/**
 * A graph mutation forwarded from a tab to the background, which owns the canonical persisted
 * learner graph. Tabs keep a hydrated in-RAM copy for sync reads; the background replays these
 * events through the same shared functions, so one writer persists and tabs can't clobber
 * each other.
 */
export type GraphEvent =
  | { kind: "extraction"; extraction: ConceptExtraction; ctx: ApplyContext; at: number }
  | { kind: "resolve"; concept: string; belief: string; at: number; resolution: { method: ResolutionMethod; rung?: number; note: string } };

export interface VoiceState {
  mode: "off" | "starting" | "listening" | "error";
  error?: string;
  errorCode?: "permission" | "server" | "device" | "unknown";
  ttsPlaying: boolean;
  /** null = unknown / not checked yet */
  serverOk: boolean | null;
  /** Whether the server has a Deepgram key (voice possible at all). */
  deepgram?: boolean;
}

export interface PendingLoop {
  utterance: string;
  goal: string;
  history: ActionRecord[];
  step: number;
  at: number;
  pendingOffer: PendingOffer | null;
  lastReferencedElementName: string | null;
}

export interface TabSession {
  conversation: ConversationTurn[];
  student: StudentSessionState;
  panelOpen: boolean;
  minimized: boolean;
  pendingLoop: PendingLoop | null;
  proactiveCooldownUntil: number;
  /** URL history for oscillation detection: [{url, at}] */
  urlTrail: { url: string; at: number }[];
  updatedAt: number;
}

/** What the tablet watcher is doing, for the popup. */
export interface TabletState {
  watching: boolean;
  windowId: number | null;
  contextTabId: number | null;
  frames: number;
  checks: number;
  lastCheckAt: number | null;
  lastVerdict: InkJudgement | null;
  error?: string;
}

export type OffscreenCommand =
  | { target: "offscreen"; type: "mic.start"; serverUrl: string }
  | { target: "offscreen"; type: "mic.stop" }
  | { target: "offscreen"; type: "tts.speak"; id: string; text: string; serverUrl: string }
  | { target: "offscreen"; type: "tts.stop" }
  | { target: "offscreen"; type: "ping" };

export type OffscreenEvent =
  | { type: "mic.state"; state: "starting" | "listening" | "stopped" | "error"; error?: string; code?: VoiceState["errorCode"] }
  | { type: "mic.level"; level: number }
  | { type: "transcript"; text: string; final: boolean; event: string; turnIndex: number }
  | { type: "tts.state"; id: string; state: "started" | "ended" | "error" | "interrupted"; error?: string }
  | { type: "tts.level"; level: number };

export type BgRequest =
  | { type: "agent.decide"; input: AgentInput }
  | { type: "agent.intervene"; input: InterventionInput }
  | { type: "server.health" }
  | { type: "tts.speak"; id: string; text: string }
  | { type: "tts.stop" }
  | { type: "voice.start" }
  | { type: "voice.stop" }
  | { type: "voice.status" }
  | { type: "tab.session.get" }
  | { type: "tab.session.set"; patch: Partial<TabSession> }
  | { type: "tab.session.clear" }
  | { type: "nav.navigate"; url: string }
  | { type: "nav.open"; url: string }
  | { type: "nav.switch"; tabId: number }
  | { type: "nav.back" }
  | { type: "lookup"; query: string }
  | { type: "screenshot" }
  | { type: "open.onboarding" }
  | { type: "open.demo" }
  | { type: "offscreen.event"; event: OffscreenEvent }
  | { type: "extract"; input: ExtractionInput }
  | { type: "graph.get" }
  | { type: "graph.event"; event: GraphEvent }
  | { type: "graph.clear" }
  | { type: "tablet.open" }
  | { type: "tablet.stop"; close?: boolean }
  | { type: "tablet.status" }
  | { type: "ping" };

export interface ServerHealth {
  ok: boolean;
  llm?: string;
  deepgram?: boolean;
  demoMode?: boolean;
  version?: string;
  error?: string;
}

export type BgResponseMap = {
  "agent.decide": AgentOutput;
  "agent.intervene": InterventionOutput;
  "server.health": ServerHealth;
  "tts.speak": { ok: boolean; error?: string };
  "tts.stop": { ok: boolean };
  "voice.start": { ok: boolean; state: VoiceState };
  "voice.stop": { ok: boolean; state: VoiceState };
  "voice.status": VoiceState;
  "tab.session.get": TabSession;
  "tab.session.set": { ok: boolean };
  "tab.session.clear": { ok: boolean };
  "nav.navigate": { ok: boolean };
  "nav.open": { ok: boolean };
  "nav.switch": { ok: boolean };
  "nav.back": { ok: boolean };
  lookup: { ok: boolean; results: string };
  screenshot: { ok: boolean; dataUrl?: string; error?: string };
  "open.onboarding": { ok: boolean };
  "open.demo": { ok: boolean };
  "offscreen.event": { ok: boolean };
  extract: ConceptExtraction;
  "graph.get": GraphSnapshot | null;
  "graph.event": { ok: boolean };
  "graph.clear": { ok: boolean };
  "tablet.open": TabletState;
  "tablet.stop": TabletState;
  "tablet.status": TabletState;
  ping: { ok: boolean; at: number };
};

export type ContentBroadcast =
  | { type: "voice.state"; state: VoiceState }
  | { type: "voice.transcript"; text: string; final: boolean; event: string; turnIndex: number }
  | { type: "voice.level"; level: number }
  | { type: "tts.state"; id: string; state: "started" | "ended" | "error" | "interrupted"; error?: string }
  | { type: "tts.level"; level: number }
  | { type: "command"; name: "toggle-companion" | "toggle-voice" }
  | { type: "ask.selection"; text: string; prompt: string }
  | { type: "settings.changed"; settings: Settings }
  | { type: "ink.judgement"; judgement: InkJudgement; reason: "ink" | "pause" };

export class BgUnavailableError extends Error {
  constructor(message = "background unavailable") {
    super(message);
    this.name = "BgUnavailableError";
  }
}

/** Typed request to the background service worker, with a timeout so a dead worker never hangs the UI. */
export function sendToBackground<T extends BgRequest["type"]>(msg: Extract<BgRequest, { type: T }>, timeoutMs = 45_000): Promise<BgResponseMap[T]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BgUnavailableError(`timeout waiting for ${msg.type}`));
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new BgUnavailableError(err.message));
          return;
        }
        if (response && typeof response === "object" && "__error" in response) {
          reject(new Error(String((response as { __error: string }).__error)));
          return;
        }
        resolve(response as BgResponseMap[T]);
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new BgUnavailableError(String(e)));
    }
  });
}

export function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
