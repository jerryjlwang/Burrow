import { useSyncExternalStore } from "react";
import type { ConversationTurn, PageSummary, StruggleSignals, Rect, ActionResult } from "@shared/types";
import type { SketchItem } from "@shared/sketch";
import type { AgentDecision } from "@shared/actions";
import { emptySignals } from "@shared/types";
import type { VoiceState } from "../shared/messages";
import { DEFAULT_SETTINGS, type Settings } from "../shared/settings";
import type { LogEntry } from "../shared/logger";

export type CharacterState = "idle" | "listening" | "thinking" | "speaking" | "pointing" | "acting" | "celebrating" | "confused" | "sleeping" | "error";

export interface HighlightBox {
  id: number;
  rect: Rect;
  kind: "highlight" | "point" | "acting";
  spotlight: boolean;
  label?: string;
  expiresAt: number;
}

export interface BubbleAction {
  label: string;
  value: "accept" | "decline" | "dismiss" | "open";
  primary?: boolean;
}

export interface Bubble {
  id: string;
  text: string;
  kind: "offer" | "confirmation" | "info" | "error" | "reply";
  actions?: BubbleAction[];
  expiresAt?: number;
  /** Handles this bubble's buttons itself instead of the offer/confirmation flows. */
  onAction?: (value: BubbleAction["value"]) => void;
}

/** One plan as the plan map draws it: the problem on screen, or a learning plan from long-term memory. */
export interface PlanRoute {
  key: string;
  kind: "problem" | "topic";
  goal: string;
  steps: Array<{ title: string; state: "done" | "current" | "todo" }>;
}

export interface PlanView {
  routes: PlanRoute[];
}

/** A worked example the rabbit "draws out" on its chalkboard: text lines and freeform strokes. */
export interface SketchBoard {
  id: string;
  title?: string;
  items: SketchItem[];
}

export interface DebugInfo {
  lastDecision: AgentDecision | null;
  lastResult: ActionResult | null;
  provider: string | null;
  degraded: boolean;
  goal: string | null;
  lastTranscript: string | null;
  loopStep: number;
  latencyMs: number | null;
  proactiveLevel: number;
}

export interface UIState {
  settings: Settings;
  characterState: CharacterState;
  /** 0 none, 1 look toward issue, 2 "?" attention cue */
  attention: 0 | 1 | 2;
  lookAt: { x: number; y: number } | null;
  audioLevel: number;
  panelOpen: boolean;
  minimized: boolean;
  hidden: boolean;
  conversation: ConversationTurn[];
  interimTranscript: string;
  voice: VoiceState;
  bubble: Bubble | null;
  board: SketchBoard | null;
  /** The plan map, when open. Shares the chalkboard's corner, so opening one closes the other. */
  planView: PlanView | null;
  highlights: HighlightBox[];
  pointer: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  busy: boolean;
  status: string;
  page: PageSummary | null;
  signals: StruggleSignals;
  debug: DebugInfo;
  logs: LogEntry[];
  unread: number;
  reducedMotion: boolean;
}

export const initialState: UIState = {
  settings: DEFAULT_SETTINGS,
  characterState: "idle",
  attention: 0,
  lookAt: null,
  audioLevel: 0,
  panelOpen: false,
  minimized: false,
  hidden: false,
  conversation: [],
  interimTranscript: "",
  voice: { mode: "off", ttsPlaying: false, serverOk: null },
  bubble: null,
  board: null,
  planView: null,
  highlights: [],
  pointer: null,
  busy: false,
  status: "",
  page: null,
  signals: emptySignals(),
  debug: { lastDecision: null, lastResult: null, provider: null, degraded: false, goal: null, lastTranscript: null, loopStep: 0, latencyMs: null, proactiveLevel: 0 },
  logs: [],
  unread: 0,
  reducedMotion: false,
};

type Listener = () => void;

export class Store {
  private state: UIState;
  private listeners = new Set<Listener>();

  constructor(state: UIState = initialState) {
    this.state = state;
  }

  getState = (): UIState => this.state;

  setState = (patch: Partial<UIState> | ((s: UIState) => Partial<UIState>)): void => {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const k of Object.keys(p) as (keyof UIState)[]) {
      if (this.state[k] !== p[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  addTurn(turn: ConversationTurn): void {
    this.setState((s) => ({ conversation: [...s.conversation.slice(-60), turn], unread: s.panelOpen ? 0 : turn.role === "companion" ? s.unread + 1 : s.unread }));
  }
}

export const store = new Store();

export function useStore<T>(selector: (s: UIState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}
