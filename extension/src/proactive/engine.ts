import type { PageSummary, PendingOffer, InterventionInput } from "@shared/types";
import { validateIntervention, type InterventionDecision } from "@shared/schemas";
import { interveneMock, findAnswerInput } from "@shared/mock-agent";
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
const INTERACTIVE_SELECTOR = "button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], input, select, textarea, summary, label, [onclick], [tabindex]";

export interface EngineDeps {
  tracker: SignalTracker;
  session: Session;
  overlay: OverlayController;
  registry: ElementRegistry;
  watcher: PageWatcher;
  getPage: () => PageSummary | null;
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
    this.removeListeners.push(() => document.removeEventListener("pointerdown", onPointerDown, true), () => document.removeEventListener("keydown", onKey, true));
    this.tickTimer = window.setInterval(() => this.evaluate("tick"), 4000);
    this.deps.tracker.recordUrl(location.href, Date.now());
  }

  stop(): void {
    for (const off of this.removeListeners) off();
    this.removeListeners = [];
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    if (this.cueTimer) window.clearTimeout(this.cueTimer);
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
    if (problemChanged) {
      this.level = 0;
      this.hadTrouble = false;
    }
    const student = this.deps.session.student;
    if (newSuccesses.length && (this.hadTrouble || student.hintsForCurrentProblem > 0) && this.celebratedProblem !== this.deps.tracker.currentProblemKey) {
      this.celebratedProblem = this.deps.tracker.currentProblemKey;
      this.deps.session.updateStudent({ successes: student.successes + 1, hintsForCurrentProblem: 0, recentErrors: [] });
      this.deps.onCelebrate(student.hintsForCurrentProblem > 0 ? "Nice—you got it." : null);
      this.hadTrouble = false;
      this.level = 0;
      return;
    }
    if (newSuccesses.length) this.deps.session.updateStudent({ successes: student.successes + 1 });
    window.setTimeout(() => this.evaluate("page"), 250);
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
      const id = this.issueElementId();
      const el = id != null ? this.deps.registry.get(id) : null;
      const rect = el?.getBoundingClientRect();
      store.setState({ attention: level, lookAt: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null });
      if (this.cueTimer) window.clearTimeout(this.cueTimer);
      this.cueTimer = window.setTimeout(() => store.setState((st) => (st.attention === level ? { attention: 0, lookAt: st.pointer ? st.lookAt : null } : {})), level === 1 ? 3000 : 6000);
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
      if (level === 4 && store.getState().settings.ttsEnabled) await this.deps.speak(decision.message);
    } finally {
      this.requesting = false;
    }
  }

  private async requestIntervention(level: number): Promise<InterventionDecision> {
    const page = this.deps.getPage();
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
