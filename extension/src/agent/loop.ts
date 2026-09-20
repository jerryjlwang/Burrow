import { validateDecision } from "@shared/validate";
import type { AgentDecision } from "@shared/actions";
import type { ActionRecord, ActionResult, AgentInput, AgentOutput, PageSummary, PathContext, PendingOffer } from "@shared/types";
import type { StepPlan } from "@shared/plan";
import type { VideoContext } from "@shared/video";
import { diagnose, formatDiagnostics } from "@shared/diagnostics";
import { resourceKindOf } from "@shared/events";
import { pickLookupResult } from "@shared/mock-agent";
import { detectProblem, problemKey } from "@shared/hints";
import { isAffirmative, isNegative, truncate } from "@shared/text";
import { executeAction, type ExecutorDeps } from "../actions/executor";
import { MAX_REGION_CHARS, quoteRegion, regionText } from "../actions/inspect";
import { classifyTask, isForbidden, requiresConfirmation } from "../actions/policy";
import { HOST_ID } from "../page-understanding/extract";
import { registeredIdAt } from "../actions/surface";
import { store } from "../content/store";
import { sendToBackground, BgUnavailableError, type PendingLoop } from "../shared/messages";
import { log } from "../shared/logger";
import type { Session } from "./session";
import { Speculator, speculationKey } from "./speculation";
import type { SignalTracker } from "../proactive/signals";

const logger = log("agent");
export const MAX_STEPS = 6;
/** Hard ceiling across navigations and new tabs, so a resumed chain can't run away. */
export const MAX_TOTAL_STEPS = 14;

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
  /** Presents a hard failure: confused character + error bubble. No dialogue, no speech. */
  onError?: (message: string) => void;
  /** Step plan for the problem on screen (if one is ready) and how far the student's working has got. */
  getPlan?: () => { plan: StepPlan | null; planStep: number | null };
  /** The drawing on screen as a numbered list, so the model can extend it or erase parts of it. */
  getBoard?: () => string | null;
  /** The video being watched, as the rabbit has followed it, and a way to grab the exact frame on screen. */
  getVideo?: () => { context: VideoContext; frame: () => string | null } | null;
  /** A learning hint was just given on the problem on screen. */
  onHint?: () => void;
}

export interface RunOptions {
  goal?: string;
  pendingOffer?: PendingOffer | null;
  resume?: PendingLoop | null;
  /** The path suggestion being carried out, so resources opened get credited to its concept. */
  path?: PathContext | null;
  source: "voice" | "text" | "proactive" | "resume";
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** The brain is unreachable or erroring: the rabbit visibly breaks instead of improvising. */
class BrainDown extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BrainDown";
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
  private pendingPlan: string | null = null;
  private pendingReadout: string | null = null;
  private speculator = new Speculator<AgentOutput>();
  /** The decide request whose spoken sentence may be voiced the moment it arrives. */
  private activeRequestId: string | null = null;
  /** Sentences that arrived for a request that isn't (yet) the active one — a head start still unclaimed. */
  private earlySays = new Map<string, string>();
  /** What has already been voiced ahead of its decision, so say() shows it without speaking it twice. */
  private spokenEarly: string | null = null;
  private requestSeq = 0;
  /** Last look_up's results, kept to title the resource that gets opened from them. */
  private lastLookup: string | null = null;
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
    this.activeRequestId = null;
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
    let path: PathContext | null = opts.path ?? opts.resume?.path ?? null;
    const learner = formatDiagnostics(diagnose(session.graph, Date.now()));
    if (opts.resume?.lastReferencedElementName) this.lastReferencedElementName = opts.resume.lastReferencedElementName;
    const taskType = classifyTask(utterance, store.getState().page);
    let firstStep = true;
    session.updateStudent({ currentGoal: goal });
    store.setState({ busy: true, characterState: "thinking", status: "Thinking…", debug: { ...store.getState().debug, goal, loopStep: step, lastTranscript: utterance } });
    logger.info("run", { utterance, source: opts.source, resume: !!opts.resume, taskType });

    const check = () => {
      if (signal.aborted) throw new Cancelled();
    };

    try {
      const maxStep = Math.min(step + MAX_STEPS, MAX_TOTAL_STEPS);
      for (; step < maxStep; step++) {
        check();
        const page = this.deps.observe();
        store.setState({ page, debug: { ...store.getState().debug, loopStep: step } });
        // Re-resolve "it" by name if ids were lost across a navigation.
        if (this.lastReferencedElementId !== null && !page.elements.some((e) => e.id === this.lastReferencedElementId)) {
          const byName = this.lastReferencedElementName ? page.elements.find((e) => e.name === this.lastReferencedElementName) : undefined;
          this.lastReferencedElementId = byName?.id ?? null;
        }
        const input = this.buildInput({ utterance, goal, conversation: session.recentTurns(10), page, history, pendingOffer, path, learner, step, maxStep, withFrame: firstStep && taskType !== "navigation" && taskType !== "administrative", resumed: !!opts.resume && step === (opts.resume?.step ?? 0) });
        // A plain spoken request may already be half-answered: the decision started when speech
        // recognition first thought the student was done (see speculate()).
        const head = firstStep && !opts.resume && !opts.goal && !pendingOffer && !path ? this.speculator.take(speculationKey(utterance, page.url)) : null;
        firstStep = false;
        this.pendingScreenshot = null;
        this.pendingLookup = null;
        this.pendingPlan = null;
        this.pendingReadout = null;

        const requestId = head?.tag || this.newRequestId();
        this.listenFor(requestId);
        // A head start that failed isn't worth keeping; ask properly.
        let output = head ? await head.promise.catch(() => null) : null;
        if (output && !output.degraded) logger.info("speculation hit", { headStartMs: head!.headStartMs });
        else {
          if (head) this.listenFor(this.newRequestId());
          output = await this.decide(input, signal, this.activeRequestId!);
        }
        this.activeRequestId = null;
        check();
        // This page lived long enough to get a decision: the handoff is consumed.
        if (opts.resume && step === opts.resume.step) await session.setPendingLoop(null);
        const decision = output.decision;
        store.setState({ debug: { ...store.getState().debug, lastDecision: decision, provider: output.provider, degraded: output.degraded, latencyMs: output.latencyMs } });
        logger.info("decision", { step, action: decision.action, elementId: decision.elementId, say: decision.say, provider: output.provider, latencyMs: output.latencyMs });

        // A point is judged by what it lands on, so coordinates can't route around the policy gates.
        const targetId = decision.elementId ?? (decision.x != null && decision.y != null ? registeredIdAt(this.deps.executor.registry, { x: decision.x, y: decision.y }) : null);
        const element = targetId != null ? page.elements.find((e) => e.id === targetId) ?? null : null;
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
        } else if (decision.say && decision.action !== "observe") {
          // Speak alongside the action (e.g. "Yep." while clicking, or the hint while pointing).
          this.say(decision.say);
        }

        if (decision.action === "observe") {
          let result: ActionResult = { ok: true, message: "observed" };
          if (decision.text === "screenshot") this.pendingScreenshot = await this.captureScreenshot();
          else if (decision.elementId != null || decision.quote) result = this.readRegion(decision);
          history.push({ step, decision, result, at: Date.now() });
          continue;
        }

        // look_up runs server-side (vetted endpoints, no user cookies); results feed the next step.
        if (decision.action === "look_up") {
          let result: { ok: boolean; message: string };
          try {
            this.pendingLookup = this.lastLookup = await this.deps.executor.lookup(decision.text!, path?.prefer);
            result = { ok: true, message: "results attached to your next step" };
          } catch (e) {
            result = { ok: false, message: `lookup failed: ${e instanceof Error ? e.message : String(e)}` };
          }
          history.push({ step, decision, result, at: Date.now() });
          continue;
        }

        // make_plan builds a learning plan server-side, stores it in the learner profile, and turns
        // its first step into this loop's path — so the very next steps go and open something.
        if (decision.action === "make_plan") {
          let result: { ok: boolean; message: string };
          try {
            const plan = await this.deps.executor.makePlan(decision.text!);
            if (!plan) throw new Error("no plan came back");
            session.record({ kind: "plan", plan: { key: plan.key, kind: "topic", goal: plan.goal, steps: plan.steps, provenance: { origin: "asked", planner: plan.source, utterance, url: page.url, title: page.title } }, at: Date.now() });
            const first = plan.steps[0];
            path = { kind: "plan", conceptLabel: first.concept ?? first.title, query: first.query ?? `${first.concept ?? first.title} for kids`, prefer: "lesson" };
            this.pendingPlan = plan.steps.map((st, i) => `${i + 1}. ${st.title}${st.query ? ` (look_up: "${st.query}")` : ""}`).join("\n");
            this.deps.executor.showPlan();
            result = { ok: true, message: `plan saved and showing on the plan map: ${plan.steps.length} steps; start step 1 now` };
          } catch (e) {
            result = { ok: false, message: `planning failed: ${e instanceof Error ? e.message : String(e)}` };
          }
          history.push({ step, decision, result, at: Date.now() });
          continue;
        }

        // open_tab moves the student to a new tab. A chain that isn't done continues THERE: the
        // background seeds the new tab's session with this loop, and its content script resumes it.
        if (decision.action === "open_tab") {
          const record: ActionRecord = { step, decision, result: { ok: true, message: "opened in a new tab; you are now on that tab" }, at: Date.now() };
          const resume = decision.done || step + 1 >= maxStep ? undefined : { utterance, goal, history: [...history.slice(-5), record], step: step + 1, at: Date.now(), pendingOffer: null, lastReferencedElementName: null, path };
          await this.deps.executor.openTab(decision.url!, resume);
          history.push(record);
          this.creditResource(path, decision.url!);
          break;
        }

        // --- Execute + verify ---
        // Persist resume state BEFORE actions that may unload the page (a click on a link
        // navigates faster than we could save afterwards). Cleared again if nothing navigated.
        const mayNavigate = decision.action === "click" || decision.action === "double_click" || decision.action === "press_key" || decision.action === "navigate" || decision.action === "go_back";
        if (mayNavigate) {
          await session.setPendingLoop({ utterance, goal, history: [...history.slice(-5), { step, decision, result: { ok: true, message: "action dispatched; page navigated" }, at: Date.now() }], step: step + 1, at: Date.now(), pendingOffer: null, lastReferencedElementName: this.lastReferencedElementName, path });
        }
        const result = await this.executeSafely(decision, page, signal);
        history.push({ step, decision, result, at: Date.now() });
        if (decision.action === "navigate" && result.ok) this.creditResource(path, decision.url!);
        store.setState({ debug: { ...store.getState().debug, lastResult: result } });
        logger.info("result", { action: decision.action, ok: result.ok, message: result.message, changed: result.changed, urlChanged: result.urlChanged });
        if (decision.action === "point_to" || decision.action === "highlight") {
          if (pendingOffer || decision.taskType === "learning" || decision.taskType === "assessment") this.noteHint(page);
        }
        if (result.urlChanged) {
          // The page is navigating; the next content script resumes with the state saved above.
          await session.setPendingLoop({ utterance, goal, history: history.slice(-6), step: step + 1, at: Date.now(), pendingOffer: null, lastReferencedElementName: this.lastReferencedElementName, path });
          break;
        }
        if (mayNavigate) await session.setPendingLoop(null);
        // Aiming by eye needs eyes: after acting on a raw point, show the model what happened.
        if ((decision.x != null || decision.toX != null) && !decision.done) this.pendingScreenshot = await this.captureScreenshot();
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
        // Failure looks like failure: the confused rabbit and an error bubble — never dialogue
        // improvised by anything that isn't the model.
        logger.error("loop failed", { error: String(e) });
        this.deps.onError?.(e instanceof BrainDown ? "I can't reach my brain right now. Give me a moment, then ask again." : "Something broke on my side. Try that again in a moment.");
      }
    } finally {
      if (this.abort === abort) {
        this.abort = null;
        store.setState({ busy: false, status: "" });
        this.deps.onIdle?.();
      }
    }
  }

  /** A resource opened for a path suggestion is remembered against its concept, so later attempts can say whether it helped. */
  private creditResource(path: PathContext | null, url: string): void {
    if (!path) return;
    const listed = this.lastLookup?.split("\n").find((line) => line.includes(url));
    const title = (listed && pickLookupResult(listed)?.title) || new URL(url).hostname;
    this.deps.session.record({ kind: "resource", concept: path.conceptLabel, url, title, resourceKind: resourceKindOf(url), reason: path.kind, at: Date.now() });
  }

  private noteHint(page: PageSummary): void {
    const { session } = this.deps;
    this.deps.onHint?.();
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
    const alreadyVoiced = this.spokenEarly === text;
    this.spokenEarly = null;
    if (!alreadyVoiced) void this.deps.speak(text);
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

  private buildInput(a: { utterance: string; goal: string; conversation: AgentInput["conversation"]; page: PageSummary; history: ActionRecord[]; pendingOffer: PendingOffer | null; path: PathContext | null; learner: string | null; step: number; maxStep: number; withFrame: boolean; resumed: boolean }): AgentInput {
    const video = this.deps.getVideo?.() ?? null;
    const frame = video && a.withFrame && !this.pendingScreenshot ? video.frame() : null;
    return {
      utterance: a.utterance,
      goal: a.goal,
      conversation: a.conversation,
      page: a.page,
      history: a.history.slice(-6),
      signals: this.deps.signals.snapshot(Date.now()),
      student: this.deps.session.student,
      pendingOffer: a.pendingOffer,
      lastReferencedElementId: this.lastReferencedElementId,
      // On a video the rabbit already has eyes: the frame rides along with the first step, so there is no "let me look" round trip.
      // An explicit observe:screenshot stays a viewport capture — its pixels are click coordinates, a video frame's are not.
      screenshot: this.pendingScreenshot ?? frame,
      screenshotIsVideoFrame: !this.pendingScreenshot && !!frame,
      video: video?.context ?? null,
      board: this.deps.getBoard?.() ?? null,
      lookupResults: this.pendingLookup,
      planResults: this.pendingPlan,
      readout: this.pendingReadout,
      path: a.path,
      ...this.deps.getPlan?.(),
      learner: a.learner,
      step: a.step,
      maxSteps: a.maxStep,
      resumedAfterNavigation: a.resumed,
    };
  }

  /**
   * Start deciding on what the student has *probably* just said, while speech recognition is
   * still making sure they've finished. run() claims the result if the final words match;
   * otherwise it is discarded unseen. This only computes — it never speaks, acts or records.
   */
  speculate(utterance: string): void {
    if (this.running || !utterance.trim()) return;
    const { session } = this.deps;
    const page = this.deps.observe();
    const taskType = classifyTask(utterance, page);
    const input = this.buildInput({
      utterance,
      goal: utterance,
      // run() sees the conversation with this turn already added; match it.
      conversation: [...session.recentTurns(9), { role: "user", text: utterance, at: Date.now() }],
      page,
      history: [],
      pendingOffer: null,
      path: null,
      learner: formatDiagnostics(diagnose(session.graph, Date.now())),
      step: 0,
      maxStep: MAX_STEPS,
      withFrame: taskType !== "navigation" && taskType !== "administrative",
      resumed: false,
    });
    logger.debug("speculating", { utterance });
    const requestId = this.newRequestId();
    this.speculator.start(speculationKey(utterance, page.url), () => this.decide(input, new AbortController().signal, requestId), requestId);
  }

  /** The student kept talking: whatever was guessed is about the wrong sentence. */
  dropSpeculation(): void {
    this.speculator.drop();
  }

  private newRequestId(): string {
    return `d${Date.now().toString(36)}-${++this.requestSeq}`;
  }

  /** From now on this request's sentence is voiced on arrival — or right away if it already came. */
  private listenFor(requestId: string): void {
    this.activeRequestId = requestId;
    this.spokenEarly = null;
    const waiting = this.earlySays.get(requestId);
    this.earlySays.clear();
    if (waiting) this.speakEarly(waiting);
  }

  /**
   * The server streamed a talk-only decision's sentence ahead of the decision. Voice it now if it
   * belongs to the request the loop is waiting on; a head start's sentence waits until the final
   * transcript confirms the student really said that. The turn itself is added by say() when the
   * full decision lands (that's where an explanation's panel text comes from).
   */
  handleEarlySay(requestId: string, say: string): void {
    if (requestId === this.activeRequestId) this.speakEarly(say);
    else if (this.speculator.pending) this.earlySays.set(requestId, say);
  }

  private speakEarly(say: string): void {
    if (this.spokenEarly !== null) return;
    this.spokenEarly = say;
    logger.info("speaking ahead of the decision", { say: say.slice(0, 60) });
    store.setState({ status: "" });
    void this.deps.speak(say);
  }

  private async decide(input: AgentInput, signal: AbortSignal, requestId?: string): Promise<AgentOutput> {
    const started = Date.now();
    try {
      const out = await sendToBackground({ type: "agent.decide", input, requestId }, 40_000);
      if (signal.aborted) throw new Cancelled();
      if (out.provider === "error") throw new BrainDown(out.decision.reason || "provider error");
      const v = validateDecision(out.decision);
      if (!v.ok) {
        logger.warn("server returned an invalid decision", { error: v.error });
        throw new BrainDown(v.error);
      }
      return { ...out, decision: v.decision };
    } catch (e) {
      if (e instanceof Cancelled || e instanceof BrainDown) throw e;
      const reason = e instanceof BgUnavailableError ? "background unavailable" : String(e);
      // One immediate retry rides out a service-worker restart or a request that died mid-flight.
      logger.warn("decide failed; retrying once", { reason });
      try {
        const out = await sendToBackground({ type: "agent.decide", input }, 40_000);
        if (signal.aborted) throw new Cancelled();
        if (out.provider !== "error") {
          const v = validateDecision(out.decision);
          if (v.ok) return { ...out, decision: v.decision };
        }
      } catch (e2) {
        if (e2 instanceof Cancelled) throw e2;
        logger.warn("decide retry failed too", { error: String(e2) });
      }
      // Nothing but the OpenAI client ever answers in a live session: break visibly instead.
      throw new BrainDown(reason);
    }
  }

  /** observe with a target reads that region in full; the text rides to the next decide as REGION TEXT. */
  private readRegion(decision: AgentDecision): ActionResult {
    const scope = decision.elementId != null ? this.deps.executor.registry.get(decision.elementId) : null;
    if (decision.elementId != null && !scope) return { ok: false, message: "That element isn't on the page anymore—let me look again.", elementFound: false };
    const el = decision.quote ? quoteRegion(scope ?? document.body, decision.quote, HOST_ID) ?? (scope ? quoteRegion(document.body, decision.quote, HOST_ID) : null) : scope;
    if (!el) return { ok: false, message: `nothing on the page contains "${decision.quote!.slice(0, 60)}"`, elementFound: false };
    const text = regionText(el);
    if (!text) return { ok: false, message: "that region has no readable text — it may need revealing first (click 'more' / expand it)", elementFound: true };
    const label = decision.quote ? `region containing "${decision.quote.slice(0, 60)}"` : `element [${decision.elementId}]`;
    this.pendingReadout = `${label}:\n${text.slice(0, MAX_REGION_CHARS)}`;
    return { ok: true, message: `read ${Math.min(text.length, MAX_REGION_CHARS)} chars; the full text is attached to your next step`, elementFound: true };
  }

  private async captureScreenshot(): Promise<string | null> {
    try {
      const r = await sendToBackground({ type: "screenshot", viewport: { width: window.innerWidth, height: window.innerHeight } }, 5000);
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
