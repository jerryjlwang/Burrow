import { validateDecision } from "@shared/validate";
import type { AgentDecision } from "@shared/actions";
import type { ActionRecord, AgentInput, AgentOutput, PageSummary, PendingOffer } from "@shared/types";
import { decideMock } from "@shared/mock-agent";
import { detectProblem, problemKey } from "@shared/hints";
import { isAffirmative, isNegative, truncate } from "@shared/text";
import { executeAction, type ExecutorDeps } from "../actions/executor";
import { classifyTask, isForbidden, requiresConfirmation } from "../actions/policy";
import { store } from "../content/store";
import { sendToBackground, BgUnavailableError, type PendingLoop } from "../shared/messages";
import { log } from "../shared/logger";
import type { Session } from "./session";
import type { SignalTracker } from "../proactive/signals";

const logger = log("agent");
export const MAX_STEPS = 6;

export interface LoopDeps {
  executor: ExecutorDeps;
  session: Session;
  signals: SignalTracker;
  observe: () => PageSummary;
  speak: (text: string, opts?: { interruptible?: boolean }) => Promise<void>;
  stopSpeaking: () => void;
  /** Shows a confirmation request; resolves true/false. */
  confirm: (message: string) => Promise<boolean>;
  /** Called when a decision references an element, so the UI knows what "it" means. */
  onReference?: (elementId: number, name: string) => void;
  onIdle?: () => void;
}

export interface RunOptions {
  goal?: string;
  pendingOffer?: PendingOffer | null;
  resume?: PendingLoop | null;
  source: "voice" | "text" | "proactive" | "resume";
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/**
 * Bounded observe → decide → (confirm) → execute → verify loop.
 * One loop runs at a time; a new user turn cancels the previous loop.
 */
export class AgentLoop {
  private deps: LoopDeps;
  private abort: AbortController | null = null;
  private lastReferencedElementId: number | null = null;
  private lastReferencedElementName: string | null = null;
  private pendingScreenshot: string | null = null;
  private pendingLookup: string | null = null;
  runCount = 0;

  constructor(deps: LoopDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.abort !== null && !this.abort.signal.aborted;
  }

  get referencedElementId(): number | null {
    return this.lastReferencedElementId;
  }

  cancel(): void {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    store.setState({ busy: false });
  }

  async run(utterance: string, opts: RunOptions): Promise<void> {
    this.cancel();
    const abort = new AbortController();
    this.abort = abort;
    const signal = abort.signal;
    this.runCount++;
    const { session } = this.deps;
    const goal = opts.goal ?? opts.resume?.goal ?? utterance;
    const history: ActionRecord[] = opts.resume?.history ? [...opts.resume.history] : [];
    let step = opts.resume?.step ?? 0;
    const pendingOffer = opts.pendingOffer ?? opts.resume?.pendingOffer ?? null;
    if (opts.resume?.lastReferencedElementName) this.lastReferencedElementName = opts.resume.lastReferencedElementName;
    const taskType = classifyTask(utterance, store.getState().page);
    session.updateStudent({ currentGoal: goal });
    store.setState({ busy: true, characterState: "thinking", status: "Thinking…", debug: { ...store.getState().debug, goal, loopStep: step, lastTranscript: utterance } });
    logger.info("run", { utterance, source: opts.source, resume: !!opts.resume, taskType });

    const check = () => {
      if (signal.aborted) throw new Cancelled();
    };

    try {
      const maxStep = step + MAX_STEPS;
      for (; step < maxStep; step++) {
        check();
        const page = this.deps.observe();
        store.setState({ page, debug: { ...store.getState().debug, loopStep: step } });
        // Re-resolve "it" by name if ids were lost across a navigation.
        if (this.lastReferencedElementId !== null && !page.elements.some((e) => e.id === this.lastReferencedElementId)) {
          const byName = this.lastReferencedElementName ? page.elements.find((e) => e.name === this.lastReferencedElementName) : undefined;
          this.lastReferencedElementId = byName?.id ?? null;
        }
        const input: AgentInput = {
          utterance,
          goal,
          conversation: session.recentTurns(10),
          page,
          history: history.slice(-6),
          signals: this.deps.signals.snapshot(Date.now()),
          student: session.student,
          pendingOffer,
          lastReferencedElementId: this.lastReferencedElementId,
          screenshot: this.pendingScreenshot,
          lookupResults: this.pendingLookup,
          step,
          maxSteps: maxStep,
          resumedAfterNavigation: !!opts.resume && step === (opts.resume?.step ?? 0),
        };
        this.pendingScreenshot = null;
        this.pendingLookup = null;

        const output = await this.decide(input, signal);
        check();
        const decision = output.decision;
        store.setState({ debug: { ...store.getState().debug, lastDecision: decision, provider: output.provider, degraded: output.degraded, latencyMs: output.latencyMs }, offline: output.provider === "local-mock" });
        logger.info("decision", { step, action: decision.action, elementId: decision.elementId, say: decision.say, provider: output.provider, latencyMs: output.latencyMs });

        const element = decision.elementId != null ? page.elements.find((e) => e.id === decision.elementId) ?? null : null;
        if (element) {
          this.lastReferencedElementId = element.id;
          this.lastReferencedElementName = element.name;
          this.deps.onReference?.(element.id, element.name);
        }

        // --- Pure conversational actions ---
        if (decision.action === "speak" || decision.action === "finish" || decision.action === "explain" || decision.action === "ask_user") {
          const say = decision.say ?? (decision.action === "ask_user" ? decision.text : null);
          if (say) this.say(say, decision.action === "explain" ? decision.text ?? undefined : undefined);
          if (decision.action === "explain" && !say && decision.text) this.say(truncate(decision.text, 240), decision.text);
          if (decision.taskType === "learning" || decision.taskType === "assessment" || pendingOffer) this.noteHint(page);
          break;
        }

        // --- Confirmation requested by the model itself ---
        if (decision.action === "ask_confirmation") {
          const pending = { ...decision.pendingAction!, say: null, direction: null, amount: null, pendingAction: null, taskType: decision.taskType, reason: decision.reason, done: true } as AgentDecision;
          const message = decision.say ?? decision.text ?? "Want me to go ahead?";
          const yes = await this.askConfirmation(message, signal);
          if (!yes) {
            this.say("Okay, I won't.");
            break;
          }
          const result = await this.executeSafely(pending, page, signal);
          history.push({ step, decision: pending, result, at: Date.now() });
          if (!result.ok) this.say(result.message);
          else if (!result.urlChanged) this.say("Done.");
          break;
        }

        // --- Policy gates ---
        const forbidden = isForbidden(decision, { element, page, utterance });
        if (forbidden.forbidden) {
          logger.warn("forbidden action blocked", { action: decision.action, reason: forbidden.reason });
          if (element) await this.deps.executor.overlay.pointAt(element.id, { durationMs: 6000 });
          this.say(forbidden.message ?? "I can't do that one—please handle it yourself.");
          break;
        }
        const policy = requiresConfirmation(decision, { element, page, utterance });
        if (policy.required) {
          if (element) await this.deps.executor.overlay.pointAt(element.id, { durationMs: 30000 });
          const yes = await this.askConfirmation(policy.message ?? "Want me to go ahead?", signal);
          if (!yes) {
            this.say("Okay, I'll leave it. It's right here when you're ready.");
            break;
          }
        } else if (decision.say) {
          // Speak alongside the action (e.g. "Yep." while clicking, or the hint while pointing).
          this.say(decision.say);
        }

        if (decision.action === "observe") {
          if (decision.text === "screenshot") this.pendingScreenshot = await this.captureScreenshot();
          history.push({ step, decision, result: { ok: true, message: "observed" }, at: Date.now() });
          continue;
        }

        // look_up runs server-side (vetted endpoints, no user cookies); results feed the next step.
        if (decision.action === "look_up") {
          let result: { ok: boolean; message: string };
          try {
            this.pendingLookup = await this.deps.executor.lookup(decision.text!);
            result = { ok: true, message: "results attached to your next step" };
          } catch (e) {
            result = { ok: false, message: `lookup failed: ${e instanceof Error ? e.message : String(e)}` };
          }
          history.push({ step, decision, result, at: Date.now() });
          continue;
        }

        // --- Execute + verify ---
        // Persist resume state BEFORE actions that may unload the page (a click on a link
        // navigates faster than we could save afterwards). Cleared again if nothing navigated.
        const mayNavigate = decision.action === "click" || decision.action === "navigate" || decision.action === "go_back";
        if (mayNavigate) {
          await session.setPendingLoop({ utterance, goal, history: [...history.slice(-5), { step, decision, result: { ok: true, message: "action dispatched; page navigated" }, at: Date.now() }], step: step + 1, at: Date.now(), pendingOffer: null, lastReferencedElementName: this.lastReferencedElementName });
        }
        const result = await this.executeSafely(decision, page, signal);
        history.push({ step, decision, result, at: Date.now() });
        store.setState({ debug: { ...store.getState().debug, lastResult: result } });
        logger.info("result", { action: decision.action, ok: result.ok, message: result.message, changed: result.changed, urlChanged: result.urlChanged });
        if (decision.action === "point_to" || decision.action === "highlight") {
          if (pendingOffer || decision.taskType === "learning" || decision.taskType === "assessment") this.noteHint(page);
        }
        if (result.urlChanged) {
          // The page is navigating; the next content script resumes with the state saved above.
          await session.setPendingLoop({ utterance, goal, history: history.slice(-6), step: step + 1, at: Date.now(), pendingOffer: null, lastReferencedElementName: this.lastReferencedElementName });
          break;
        }
        if (mayNavigate) await session.setPendingLoop(null);
        if (!result.ok && !result.elementFound) {
          // Element vanished: re-observe on the next iteration (the model sees the failure in history).
          continue;
        }
        if (decision.done) {
          if (!result.ok) this.say(result.message);
          break;
        }
        if (step + 1 >= maxStep) {
          this.say("I've done what I can for now—want me to keep going?");
        }
      }
      if (opts.resume) await session.setPendingLoop(null);
    } catch (e) {
      if (e instanceof Cancelled) {
        logger.debug("loop cancelled");
      } else {
        logger.error("loop failed", { error: String(e) });
        store.setState({ characterState: "error" });
        this.say("Hmm, something went wrong on my side. Try me again in a moment.");
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        store.setState({ busy: false, status: "" });
        this.deps.onIdle?.();
      }
    }
  }

  private noteHint(page: PageSummary): void {
    const { session } = this.deps;
    const key = problemKey(detectProblem(page), page);
    const same = session.student.currentProblemKey === key;
    session.updateStudent({
      currentProblemKey: key,
      hintsGiven: session.student.hintsGiven + 1,
      hintsForCurrentProblem: same ? session.student.hintsForCurrentProblem + 1 : 1,
      currentConcept: detectProblem(page).kind === "linear-equation" ? "solving linear equations" : session.student.currentConcept,
    });
  }

  private say(text: string, detail?: string): void {
    this.deps.session.addTurn({ role: "companion", text, at: Date.now(), detail });
    void this.deps.speak(text);
  }

  private async askConfirmation(message: string, signal: AbortSignal): Promise<boolean> {
    this.deps.session.addTurn({ role: "companion", text: message, at: Date.now(), kind: "confirmation" });
    void this.deps.speak(message);
    const answer = await Promise.race([
      this.deps.confirm(message),
      new Promise<boolean>((_, rej) => signal.addEventListener("abort", () => rej(new Cancelled()), { once: true })),
    ]);
    logger.info("confirmation", { message, answer });
    return answer;
  }

  private async executeSafely(decision: AgentDecision, page: PageSummary, signal: AbortSignal) {
    store.setState({ characterState: "acting", status: "On it…" });
    if (signal.aborted) throw new Cancelled();
    const result = await executeAction(decision, this.deps.executor);
    if (!signal.aborted) store.setState({ characterState: store.getState().voice.ttsPlaying ? "speaking" : "idle", status: "" });
    if (decision.action === "click" && result.ok && !result.changed) this.deps.signals.markLastClickUnchanged();
    return result;
  }

  private async decide(input: AgentInput, signal: AbortSignal): Promise<AgentOutput> {
    const started = Date.now();
    try {
      const out = await sendToBackground({ type: "agent.decide", input }, 40_000);
      if (signal.aborted) throw new Cancelled();
      const v = validateDecision(out.decision);
      if (!v.ok) {
        logger.warn("server returned an invalid decision; using local fallback", { error: v.error });
        return { decision: this.localDecision(input), provider: "local-mock", degraded: true, latencyMs: Date.now() - started };
      }
      return { ...out, decision: v.decision };
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      const reason = e instanceof BgUnavailableError ? "background unavailable" : String(e);
      logger.warn("decide failed; using local fallback", { reason });
      return { decision: this.localDecision(input), provider: "local-mock", degraded: true, latencyMs: Date.now() - started };
    }
  }

  private localDecision(input: AgentInput): AgentDecision {
    const v = validateDecision(decideMock(input));
    if (v.ok) return v.decision;
    return { action: "speak", say: "I'm having trouble thinking right now. Try me again in a moment.", elementId: null, text: null, url: null, direction: null, amount: null, value: null, quote: null, line: null, tabId: null, pendingAction: null, taskType: "chat", reason: "fallback", done: true };
  }

  private async captureScreenshot(): Promise<string | null> {
    try {
      const r = await sendToBackground({ type: "screenshot" }, 5000);
      return r.ok ? r.dataUrl ?? null : null;
    } catch {
      return null;
    }
  }

  /** Quick local answer for yes/no when a confirmation or offer is pending (avoids a model round-trip). */
  static interpretYesNo(text: string): "yes" | "no" | null {
    if (isAffirmative(text)) return "yes";
    if (isNegative(text)) return "no";
    return null;
  }
}
