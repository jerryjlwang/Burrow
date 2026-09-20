import type { PageSummary, PendingOffer, InterventionInput } from "@shared/types";
import { validateIntervention } from "@shared/validate";
import type { InterventionDecision } from "@shared/actions";
import type { Misconception } from "@shared/graph";
import type { InkJudgement } from "@shared/ink";
import { composeMisconceptionNudge } from "@shared/nudge";
import { suggestNext, type PathSuggestion } from "@shared/path";
import { interveneMock, findAnswerInput } from "@shared/mock-agent";
import { detectProblem } from "@shared/hints";
import { judgeWorking } from "@shared/steps";
import { lineLocator } from "../actions/locate";
import { computeLevel, SignalTracker, THRESHOLDS, type ClickRecord } from "./signals";
import { store } from "../content/store";
import { sendToBackground } from "../shared/messages";
import { log } from "../shared/logger";
import type { Session } from "../agent/session";
import type { OverlayController } from "../actions/overlay";
import type { ElementRegistry } from "../page-understanding/registry";
import type { PageWatcher } from "../page-understanding/watcher";
import { HOST_ID } from "../page-understanding/extract";

const logger = log("proactive");
/** Ink verdicts below this confidence only earn a glance; at or above it the rabbit speaks. */
const INK_SPEAK_CONFIDENCE = 0.6;
/** The same tablet issue is not nudged twice inside this window. */
const INK_COOLDOWN_MS = 25_000;
const INTERACTIVE_SELECTOR = "button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], input, select, textarea, summary, label, [onclick], [tabindex]";

interface NudgeRecord {
  m: Misconception;
  /** The Socratic question asked — becomes the resolution note (the callback cue) if it works. */
  question: string;
  at: number;
  /** Page the nudge happened on, for success attribution. */
  pathname: string;
}

export interface EngineDeps {
  tracker: SignalTracker;
  session: Session;
  overlay: OverlayController;
  registry: ElementRegistry;
  watcher: PageWatcher;
  getPage: () => PageSummary | null;
  /** Re-extracts the page right now — input values change without DOM mutations, so snapshots go stale. */
  refreshPage: () => PageSummary;
  /** True while the agent loop runs, a confirmation is pending or the character is speaking. */
  isBusy: () => boolean;
  speak: (text: string) => Promise<void>;
  onOffer: (offer: PendingOffer) => void;
  onCelebrate: (say: string | null) => void;
}

/**
 * Proactive intervention engine. Watches cheap local signals, escalates through
 * intensity levels (look → "?" → bubble → speech) and asks the agent whether to
 * intervene only when thresholds are crossed. Respects cooldowns and declines.
 */
export class ProactiveEngine {
  private deps: EngineDeps;
  private level: 0 | 1 | 2 | 3 | 4 = 0;
  private offerActive = false;
  private tickTimer: number | null = null;
  private cueTimer: number | null = null;
  private removeListeners: Array<() => void> = [];
  private hadTrouble = false;
  private celebratedProblem: string | null = null;
  private requesting = false;
  /** Misconception ids already nudged this page-session, so one belief nudges at most once. */
  private nudgedMisconceptions = new Set<string>();
  /** Path suggestions already offered this page-session (kind:concept), so each fires once. */
  private suggestedPaths = new Set<string>();
  /** Most salient concepts of the current page, freshest extraction first. */
  private currentConceptIds: string[] = [];
  private lastJudgementWrongStep: number | null = null;
  private suggestTimer: number | null = null;
  /** The nudge currently on screen / most recently answered, for success attribution. */
  private activeNudge: NudgeRecord | null = null;
  private lastNudge: (NudgeRecord & { outcome: "accepted" | "declined" | "dismissed" }) | null = null;
  /** The element holding the student's written working, for step-judge cues. */
  private workingEl: (HTMLTextAreaElement | HTMLInputElement) | null = null;
  private judgeTimer: number | null = null;
  /** Tablet watcher: the issue last nudged and when it may repeat, whether the ink was off, and the work already cheered. */
  private inkKey: string | null = null;
  private inkCooldownUntil = 0;
  private inkOff = false;
  private inkSolved: string | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  start(): void {
    const onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
    document.addEventListener("pointerdown", onPointerDown, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.target as Element)?.closest?.("input, textarea, [contenteditable]")) this.deps.tracker.recordKeySubmit(Date.now());
    };
    document.addEventListener("keydown", onKey, true);
    // Step-judge: watch the student's written working and judge it locally (no model, no latency).
    const onInput = (e: Event) => this.handleWorkingInput(e);
    document.addEventListener("input", onInput, true);
    this.removeListeners.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => document.removeEventListener("keydown", onKey, true),
      () => document.removeEventListener("input", onInput, true),
    );
    this.tickTimer = window.setInterval(() => this.evaluate("tick"), 4000);
    this.deps.tracker.recordUrl(location.href, Date.now());
  }

  stop(): void {
    for (const off of this.removeListeners) off();
    this.removeListeners = [];
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    if (this.cueTimer) window.clearTimeout(this.cueTimer);
    if (this.judgeTimer) window.clearTimeout(this.judgeTimer);
    if (this.suggestTimer) window.clearTimeout(this.suggestTimer);
  }

  /** Debounced local step-judging of whatever multi-line working the student is typing. */
  private handleWorkingInput(e: Event): void {
    const target = e.target as Element | null;
    if (!target || target.closest?.(`#${HOST_ID}`)) return;
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) return;
    this.workingEl = target;
    if (this.judgeTimer) window.clearTimeout(this.judgeTimer);
    this.judgeTimer = window.setTimeout(() => this.judgeNow(), 350);
  }

  private judgeNow(): void {
    const page = this.deps.getPage();
    const value = String(this.workingEl?.value ?? "");
    if (!page || !value.includes("=")) return;
    const judgement = judgeWorking(detectProblem(page), value);
    if (!judgement.judged) return;
    this.deps.tracker.recordWorkingJudgement(judgement, Date.now());
    logger.debug("working judged", { firstWrongStep: judgement.firstWrongStep, solved: judgement.solved });
    this.lastJudgementWrongStep = judgement.firstWrongStep;
    this.applyConfusionCue();
    this.evaluate("working");
  }

  /**
   * The live "that doesn't look right" face: while the judge flags a line, hold the confused cue
   * and keep the gaze on that line (it moves as they type); drop it the moment the working checks
   * out. Runs on every judgement (350ms after each pause in typing) — pure local, no model.
   */
  private applyConfusionCue(): void {
    if (this.offerActive) return;
    const wrong = this.lastJudgementWrongStep;
    if (wrong !== null && this.workingEl) {
      const rect = lineLocator(this.workingEl, wrong)?.() ?? this.workingEl.getBoundingClientRect();
      if (this.cueTimer) window.clearTimeout(this.cueTimer);
      store.setState({ attention: 2, lookAt: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } });
    } else if (wrong === null && store.getState().attention === 2 && !this.deps.isBusy()) {
      store.setState({ attention: 0, lookAt: null });
    }
  }

  private handlePointerDown(e: PointerEvent): void {
    const target = e.target as Element | null;
    if (!target || target.closest?.(`#${HOST_ID}`)) return;
    let el = target.closest?.(INTERACTIVE_SELECTOR) ?? null;
    if (!el) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      el = under?.closest?.(INTERACTIVE_SELECTOR) ?? null;
    }
    if (!el) return;
    const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
    const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.tagName).trim().slice(0, 60);
    const rec = this.deps.tracker.recordClick({ at: Date.now(), key: String(this.deps.registry.idFor(el)), name, disabled });
    const mutations = this.deps.watcher.mutationCount;
    const url = location.href;
    window.setTimeout(() => {
      const changed = this.deps.watcher.mutationCount !== mutations || location.href !== url;
      this.deps.tracker.resolveClick(rec, changed);
      if (!changed) this.evaluate("click");
    }, 1200);
  }

  /** Called by the controller with every fresh page model. */
  onPageChange(page: PageSummary, reason: string): void {
    const now = Date.now();
    if (reason === "url") this.deps.tracker.recordUrl(page.url, now);
    const { newSuccesses, problemChanged } = this.deps.tracker.recordPage(page, now);
    if (newSuccesses.length) this.maybeResolveNudged(now);
    if (problemChanged) {
      this.level = 0;
      this.hadTrouble = false;
    }
    const student = this.deps.session.student;
    if (newSuccesses.length && (this.hadTrouble || student.hintsForCurrentProblem > 0) && this.celebratedProblem !== this.deps.tracker.currentProblemKey) {
      this.celebratedProblem = this.deps.tracker.currentProblemKey;
      this.deps.session.updateStudent({ successes: student.successes + 1, hintsForCurrentProblem: 0, recentErrors: [] });
      this.deps.onCelebrate(student.hintsForCurrentProblem > 0 ? "Nice—you got it." : null);
      // A success is the cheapest moment to steer: suggest the next move once the cheer lands.
      // Second attempt covers the case where the celebration is still being spoken at the first.
      if (this.suggestTimer) window.clearTimeout(this.suggestTimer);
      const suggest = () => this.offerPathSuggestion(["revisit", "advance"], { ignoreCooldown: true });
      this.suggestTimer = window.setTimeout(() => {
        suggest();
        this.suggestTimer = window.setTimeout(suggest, 3000);
      }, 2600);
      this.hadTrouble = false;
      this.level = 0;
      return;
    }
    if (newSuccesses.length) this.deps.session.updateStudent({ successes: student.successes + 1 });
    window.setTimeout(() => this.evaluate("page"), 250);
  }

  /**
   * A misconception just surfaced in the knowledge graph (from a page/query extraction). Skip the
   * cheap-signal escalation — the detection itself is the evidence — and lead with a Socratic
   * question as the bubble. Respects the same budget as other offers: cooldowns, busy, one active
   * offer at a time, and at most one nudge per belief per page-session.
   */
  onMisconception(m: Misconception): void {
    const s = store.getState();
    const now = Date.now();
    if (!s.settings.proactiveEnabled) return;
    if (this.nudgedMisconceptions.has(m.id)) return;
    if (now < this.deps.session.proactiveCooldownUntil) return;
    if (this.offerActive || this.deps.isBusy() || (s.panelOpen && s.busy)) return;
    this.nudgedMisconceptions.add(m.id);
    const nudge = composeMisconceptionNudge(m);
    logger.info("misconception nudge", { concept: m.concept, status: m.status, belief: m.belief.slice(0, 80) });
    this.activeNudge = { m, question: nudge.message, at: now, pathname: location.pathname };
    this.offerActive = true;
    store.setState({ attention: 2 });
    this.deps.session.setCooldown(now + THRESHOLDS.cooldownMs);
    this.deps.onOffer({ type: "nudge", message: nudge.message, elementId: null, at: now, goal: nudge.goal });
    const st = store.getState();
    if (st.settings.ttsEnabled && st.voice.mode === "listening") void this.deps.speak(nudge.message);
  }

  /**
   * A success just appeared after a misconception nudge: close the loop by recording HOW it got
   * resolved, so a future recurrence can call back to it ("remember what cracked it?").
   * Attribution is a heuristic — same page, within 10 minutes; an LLM judge that checks the
   * learner actually demonstrated the corrected idea replaces this later.
   */
  private maybeResolveNudged(now: number): void {
    const n = this.activeNudge ? { ...this.activeNudge, outcome: "shown" as const } : this.lastNudge;
    if (!n) return;
    if (now - n.at > 10 * 60_000 || location.pathname !== n.pathname) return;
    // Engaged nudge → the hint did it (rung 1). Shown-but-not-engaged or declined → they did it themselves.
    const method = n.outcome === "accepted" ? "hint" : "self";
    const resolution = { method, rung: method === "hint" ? 1 : undefined, note: n.question } as const;
    const resolved = this.deps.session.graph.resolveMisconception(n.m.concept, n.m.belief, now, resolution);
    if (resolved) {
      logger.info("misconception resolved", { concept: n.m.concept, method, occurrences: resolved.occurrences });
      // Mirror to the background's canonical persisted graph — this is what future sessions recall.
      void sendToBackground({ type: "graph.event", event: { kind: "resolve", concept: n.m.concept, belief: n.m.belief, at: now, resolution } }, 5000).catch(() => undefined);
    }
    this.activeNudge = null;
    this.lastNudge = null;
  }

  /**
   * Fresh extraction landed for this page: remember its top concepts and, on arrival, check the
   * one suggestion that's worth an interruption — an unseen prerequisite of what they're reading.
   */
  onConceptsExtracted(conceptIds: string[]): void {
    this.currentConceptIds = conceptIds;
    this.offerPathSuggestion(["prerequisite"], { ignoreCooldown: false });
  }

  /** Offer the graph's best next move, respecting the same budget as every other offer. */
  private offerPathSuggestion(kinds: PathSuggestion["kind"][], opts: { ignoreCooldown: boolean }): void {
    const s = store.getState();
    const now = Date.now();
    if (!s.settings.proactiveEnabled) return;
    if (this.offerActive || this.deps.isBusy() || (s.panelOpen && s.busy)) return;
    if (!opts.ignoreCooldown && now < this.deps.session.proactiveCooldownUntil) return;
    const suggestion = suggestNext(this.deps.session.graph, { currentConceptIds: this.currentConceptIds, kinds });
    if (!suggestion) return;
    const key = `${suggestion.kind}:${suggestion.conceptId}`;
    if (this.suggestedPaths.has(key)) return;
    this.suggestedPaths.add(key);
    logger.info("path suggestion", { kind: suggestion.kind, concept: suggestion.conceptId, reason: suggestion.reason });
    this.offerActive = true;
    store.setState({ attention: 2 });
    this.deps.session.setCooldown(now + THRESHOLDS.cooldownMs);
    this.deps.onOffer({ type: "nudge", message: suggestion.message, elementId: null, at: now, goal: suggestion.goal });
    const st = store.getState();
    if (st.settings.ttsEnabled && st.voice.mode === "listening") void this.deps.speak(suggestion.message);
  }

  /**
   * A verdict from the tablet watcher (the background judged a fresh frame of the kid's ink).
   * Ink gets no glance-first ladder: a confident "off" speaks right away, because the kid is
   * looking at the tablet, not at us. The same issue never repeats inside the cooldown, a shaky
   * verdict only earns a glance, and a solved page earns one celebration.
   */
  onInkJudgement(j: InkJudgement): void {
    const s = store.getState();
    const now = Date.now();
    if (!s.settings.proactiveEnabled) return;
    if (j.status === "off" && j.nudge) {
      const key = `${j.line ?? 0}:${j.issue.toLowerCase().slice(0, 60)}`;
      if (j.confidence < INK_SPEAK_CONFIDENCE) {
        if (!this.offerActive && s.attention === 0) {
          store.setState({ attention: 1 });
          if (this.cueTimer) window.clearTimeout(this.cueTimer);
          this.cueTimer = window.setTimeout(() => store.setState((st) => (st.attention === 1 ? { attention: 0 } : {})), 3000);
        }
        return;
      }
      if (this.offerActive || this.deps.isBusy()) return;
      if (key === this.inkKey && now < this.inkCooldownUntil) return;
      this.inkKey = key;
      this.inkCooldownUntil = now + INK_COOLDOWN_MS;
      this.inkOff = true;
      logger.info("ink nudge", { line: j.line, issue: j.issue, confidence: j.confidence });
      this.offerActive = true;
      store.setState({ attention: 2 });
      this.deps.onOffer({ type: "hint", message: j.nudge, elementId: null, at: now, goal: `Help me with my work on the tablet: ${j.issue || j.nudge}` });
      if (s.settings.ttsEnabled) void this.deps.speak(j.nudge);
      return;
    }
    if (j.status !== "ok") return;
    if (this.inkOff) {
      this.inkOff = false;
      this.inkKey = null;
    }
    if (j.solved) {
      const key = j.lines.join("|");
      if (key !== this.inkSolved && !this.deps.isBusy()) {
        this.inkSolved = key;
        this.deps.onCelebrate("Nice, that's it.");
      }
    }
  }

  evaluate(trigger: string): void {
    const s = store.getState();
    const now = Date.now();
    const signals = this.deps.tracker.snapshot(now);
    const student = this.deps.session.student;
    const level = computeLevel(signals, {
      proactiveEnabled: s.settings.proactiveEnabled,
      cooldownUntil: this.deps.session.proactiveCooldownUntil,
      declinedCount: student.declinedProactiveCount,
      lastDeclineAt: student.lastDeclineAt,
      now,
    });
    if (signals.strength >= 0.45) this.hadTrouble = true;
    if (signals.lastErrorText && !student.recentErrors.includes(signals.lastErrorText)) {
      this.deps.session.updateStudent({ recentErrors: [...student.recentErrors.slice(-4), signals.lastErrorText] });
    }
    store.setState({ signals, debug: { ...s.debug, proactiveLevel: level } });
    // Keep the confused gaze pinned while the working stays wrong (cue timers may have cleared it).
    if (signals.wrongStep && !this.offerActive && store.getState().attention !== 2) this.applyConfusionCue();
    if (level === 0) {
      this.level = 0;
      return;
    }
    if (this.offerActive || this.deps.isBusy() || s.panelOpen && s.busy) return;
    if (level <= this.level && !(level >= 3 && trigger === "click" && signals.failedUiAction)) return;
    logger.info("escalate", { from: this.level, to: level, trigger, summary: signals.summary });
    this.level = level;
    void this.act(level, signals.summary);
  }

  private issueElementId(): number | null {
    const page = this.deps.getPage();
    if (!page) return null;
    const answer = findAnswerInput(page);
    return answer?.id ?? null;
  }

  private async act(level: 1 | 2 | 3 | 4, summary: string[]): Promise<void> {
    if (level <= 2) {
      // A wrong working step glances at the exact line; otherwise at the answer input.
      const wrongStep = store.getState().signals.wrongStep;
      let rect = wrongStep && this.workingEl ? lineLocator(this.workingEl, wrongStep.step)?.() ?? this.workingEl.getBoundingClientRect() : undefined;
      if (!rect) {
        const id = this.issueElementId();
        rect = (id != null ? this.deps.registry.get(id) : null)?.getBoundingClientRect();
      }
      const cue = level as 1 | 2;
      store.setState({ attention: cue, lookAt: rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null });
      if (this.cueTimer) window.clearTimeout(this.cueTimer);
      this.cueTimer = window.setTimeout(() => store.setState((st) => (st.attention === cue ? { attention: 0, lookAt: st.pointer ? st.lookAt : null } : {})), cue === 1 ? 3000 : 6000);
      return;
    }
    if (this.requesting) return;
    this.requesting = true;
    try {
      const decision = await this.requestIntervention(level);
      if (!decision.intervene || !decision.message) {
        logger.info("agent declined to intervene", { reason: decision.reason });
        this.deps.session.setCooldown(Date.now() + 20_000);
        return;
      }
      if (this.deps.isBusy()) return;
      this.offerActive = true;
      const offer: PendingOffer = { type: decision.type, message: decision.message, elementId: decision.elementId, at: Date.now() };
      store.setState({ attention: 2 });
      if (decision.elementId != null) {
        const el = this.deps.registry.get(decision.elementId);
        const rect = el?.getBoundingClientRect();
        if (rect) store.setState({ lookAt: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } });
        this.deps.overlay.highlight(decision.elementId, { durationMs: 10_000 });
      }
      this.deps.session.setCooldown(Date.now() + THRESHOLDS.cooldownMs);
      this.deps.onOffer(offer);
      const st = store.getState();
      // Level 4 speaks; level 3 also speaks when the student is already in a voice conversation.
      if (st.settings.ttsEnabled && (level === 4 || st.voice.mode === "listening")) await this.deps.speak(decision.message);
    } finally {
      this.requesting = false;
    }
  }

  private async requestIntervention(level: number): Promise<InterventionDecision> {
    // Fresh extraction: the cached page predates whatever typing triggered this escalation.
    const page = this.deps.refreshPage() ?? this.deps.getPage();
    const input: InterventionInput = {
      page: page ?? ({} as PageSummary),
      signals: this.deps.tracker.snapshot(Date.now()),
      student: this.deps.session.student,
      conversation: this.deps.session.recentTurns(6),
      level,
    };
    if (!page) return { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "no page" };
    try {
      const out = await sendToBackground({ type: "agent.intervene", input }, 15_000);
      const v = validateIntervention(out.decision);
      if (v.ok) return v.decision;
      logger.warn("invalid intervention from server; using local", { error: v.error });
    } catch (e) {
      logger.warn("intervention request failed; using local", { error: String(e) });
    }
    return interveneMock(input);
  }

  offerResolved(outcome: "accepted" | "declined" | "dismissed"): void {
    if (this.activeNudge) {
      // Keep the nudge for success attribution even after the bubble is answered/dismissed.
      this.lastNudge = { ...this.activeNudge, outcome };
      this.activeNudge = null;
    }
    this.offerActive = false;
    store.setState({ attention: 0 });
    const student = this.deps.session.student;
    const now = Date.now();
    if (outcome === "declined") {
      this.deps.session.updateStudent({ declinedProactiveCount: student.declinedProactiveCount + 1, lastDeclineAt: now });
      this.deps.session.setCooldown(now + THRESHOLDS.declineCooldownMs);
      this.level = 0;
    } else if (outcome === "dismissed") {
      this.deps.session.setCooldown(now + THRESHOLDS.dismissCooldownMs);
      this.level = 0;
    } else {
      this.deps.tracker.clearAfterHelp();
      this.deps.session.updateStudent({ helpPreference: student.helpPreference === "unknown" ? "show" : student.helpPreference });
      this.level = 0;
    }
  }
}
