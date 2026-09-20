import type { AgentDecision, InterventionDecision, TaskType } from "./actions";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A compact, semantic description of one interactable element on the page. */
export interface PageElement {
  id: number;
  role: string;
  name: string;
  tag: string;
  /** Extra visible text (for links/buttons whose name was derived from aria-label etc). */
  text?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  current?: boolean;
  expanded?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** Password / payment / auth-code style fields the companion must never fill. */
  sensitive?: boolean;
  inViewport: boolean;
  rect: Rect;
  /** Nearby label / section heading that gives the element meaning. */
  context?: string;
  /** Input type for textboxes (text, email, number…). */
  inputType?: string;
}

export interface PageSummary {
  url: string;
  title: string;
  headings: string[];
  textSummary: string;
  elements: PageElement[];
  errors: string[];
  successes: string[];
  dialogs: string[];
  forms: number;
  landmarks: string[];
  selection?: string;
  isPdf: boolean;
  hasQuizUi: boolean;
  scroll: { x: number; y: number; maxY: number };
  viewport: { width: number; height: number };
  capturedAt: number;
  /** Number of elements dropped because of the cap (so the agent knows the list is partial). */
  truncatedElements: number;
}

export interface ConversationTurn {
  role: "user" | "companion";
  text: string;
  at: number;
  /** Long-form text shown in the panel but not spoken. */
  detail?: string;
  kind?: "message" | "offer" | "confirmation" | "status" | "error";
}

export interface ActionResult {
  ok: boolean;
  message: string;
  changed?: boolean;
  urlChanged?: boolean;
  newErrors?: string[];
  elementFound?: boolean;
  valueAfter?: string;
}

export interface ActionRecord {
  step: number;
  decision: AgentDecision;
  result: ActionResult;
  at: number;
}

export interface StruggleSignals {
  repeatedClicks: number;
  validationErrors: number;
  incorrectAttempts: number;
  timeOnCurrentProblemMs: number;
  navigationOscillation: boolean;
  rapidClicks: number;
  deadEnd: boolean;
  failedUiAction: boolean;
  lastClickedName?: string;
  lastErrorText?: string;
  /** The step-judge found a wrong line in the student's written working. */
  wrongStep?: { step: number; category: string; ageMs: number };
  /** Human-readable list, e.g. "2 incorrect attempts on the same problem". */
  summary: string[];
  strength: number;
}

export interface StudentSessionState {
  currentGoal: string | null;
  currentConcept: string | null;
  hintsGiven: number;
  hintsForCurrentProblem: number;
  currentProblemKey: string | null;
  recentErrors: string[];
  recentQuestions: string[];
  helpPreference: "explain" | "show" | "unknown";
  proactiveCooldownUntil: number;
  declinedProactiveCount: number;
  lastDeclineAt: number;
  taskProgress: string | null;
  successes: number;
}

export interface PendingOffer {
  type: InterventionDecision["type"];
  message: string;
  elementId: number | null;
  at: number;
  /** Pre-composed loop goal for when the offer is accepted (e.g. misconception nudges). */
  goal?: string | null;
}

export interface AgentInput {
  /** The student's current utterance / typed request. */
  utterance: string;
  /** Goal for this loop; usually the utterance, or a synthesized goal after a proactive offer. */
  goal: string;
  conversation: ConversationTurn[];
  page: PageSummary;
  history: ActionRecord[];
  signals: StruggleSignals;
  student: StudentSessionState;
  pendingOffer: PendingOffer | null;
  /** Element id most recently pointed at / highlighted (what "it" refers to). */
  lastReferencedElementId: number | null;
  screenshot?: string | null;
  step: number;
  maxSteps: number;
  resumedAfterNavigation?: boolean;
  demoMode?: boolean;
  /** Set on a retry after the model produced an invalid action, so it can correct itself. */
  retryNote?: string;
  /** Other open tabs (filled by the background), so switch_tab has real targets. */
  openTabs?: { id: number; title: string; url: string; active: boolean }[];
  /** Results of the previous step's look_up, pre-formatted for the prompt. */
  lookupResults?: string | null;
}

export interface AgentOutput {
  decision: AgentDecision;
  provider: string;
  degraded: boolean;
  latencyMs: number;
  taskType?: TaskType | null;
}

export interface InterventionInput {
  page: PageSummary;
  signals: StruggleSignals;
  student: StudentSessionState;
  conversation: ConversationTurn[];
  level: number;
  demoMode?: boolean;
}

export interface InterventionOutput {
  decision: InterventionDecision;
  provider: string;
  degraded: boolean;
}

export function emptySignals(): StruggleSignals {
  return {
    repeatedClicks: 0,
    validationErrors: 0,
    incorrectAttempts: 0,
    timeOnCurrentProblemMs: 0,
    navigationOscillation: false,
    rapidClicks: 0,
    deadEnd: false,
    failedUiAction: false,
    summary: [],
    strength: 0,
  };
}

export function emptyStudentState(): StudentSessionState {
  return {
    currentGoal: null,
    currentConcept: null,
    hintsGiven: 0,
    hintsForCurrentProblem: 0,
    currentProblemKey: null,
    recentErrors: [],
    recentQuestions: [],
    helpPreference: "unknown",
    proactiveCooldownUntil: 0,
    declinedProactiveCount: 0,
    lastDeclineAt: 0,
    taskProgress: null,
    successes: 0,
  };
}
