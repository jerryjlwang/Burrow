import { validateDecision, validateIntervention } from "@shared/validate";
import { DECISION_DEFAULTS, type AgentDecision } from "@shared/actions";
import type { AgentInput, AgentOutput, InterventionInput, InterventionOutput } from "@shared/types";
import { detectProblem, hintFor } from "@shared/hints";
import { finalAnswersFor, leakedAnswer } from "@shared/ladder";
import type { AgentProvider } from "../agent/provider";
import { MockProvider } from "../agent/mock";
import { OpenAIProvider } from "../agent/openai";
import type { Config } from "../config";
import type { StepService } from "./steps";
import { log } from "../util/logger";

const logger = log("agent");

/** Whether a decision was made with the video in view: position, transcript, and the frame. */
const videoLog = (input: AgentInput) => (input.video ? { videoAt: Math.round(input.video.t), transcript: input.video.hasTranscript, frame: !!input.screenshot } : {});

export class AgentService {
  readonly primary: AgentProvider;
  readonly fallback = new MockProvider();

  constructor(cfg: Config, private steps?: StepService) {
    if (cfg.llmProvider === "openai") {
      this.primary = new OpenAIProvider({ apiKey: cfg.llmApiKey, model: cfg.llmModel, effort: cfg.llmEffort });
    } else {
      this.primary = this.fallback;
    }
  }

  get providerName(): string {
    return this.primary.name;
  }

  async decide(input: AgentInput): Promise<AgentOutput> {
    const started = Date.now();
    if (this.primary !== this.fallback) {
      try {
        let raw = await this.primary.decide(input);
        let v = validateDecision(raw);
        if (!v.ok) {
          // One corrective retry: models occasionally omit an elementId or misuse a field.
          logger.warn("primary decision invalid; retrying once", { error: v.error });
          raw = await this.primary.decide({ ...input, retryNote: v.error });
          v = validateDecision(raw);
        }
        if (v.ok) {
          const decision = await this.enforceNoLeak(v.decision, input);
          logger.info("decide", { provider: this.primary.name, action: decision.action, elementId: decision.elementId, ms: Date.now() - started, utterance: input.utterance.slice(0, 80), ...videoLog(input) });
          return { decision, provider: this.primary.name, degraded: false, latencyMs: Date.now() - started, taskType: decision.taskType };
        }
        logger.warn("primary decision still invalid; answering honestly", { error: v.error });
        return this.honestFailure(started, "invalid decisions");
      } catch (e) {
        // One more try against the REAL brain before giving up — most failures are one slow call.
        logger.warn("primary provider failed; retrying once", { error: e instanceof Error ? e.message : String(e) });
        try {
          const raw = await this.primary.decide(input);
          const v = validateDecision(raw);
          if (v.ok) {
            const decision = await this.enforceNoLeak(v.decision, input);
            return { decision, provider: this.primary.name, degraded: false, latencyMs: Date.now() - started, taskType: decision.taskType };
          }
        } catch (e2) {
          logger.warn("primary retry failed too", { error: e2 instanceof Error ? e2.message : String(e2) });
        }
        // Live sessions NEVER silently switch to the regex agent: it answers with a different,
        // literal-minded brain and the student can't tell. Fail honestly instead.
        return this.honestFailure(started, "provider unavailable");
      }
    }
    const raw = await this.fallback.decide(input);
    const v = validateDecision(raw);
    const decision = v.ok
      ? v.decision
      : { ...DECISION_DEFAULTS, action: "speak" as const, say: "I'm having trouble thinking right now. Try me again in a moment.", taskType: "chat" as const, reason: "fallback", done: true };
    logger.info("decide", { provider: "mock", action: decision.action, elementId: decision.elementId, ms: Date.now() - started, utterance: input.utterance.slice(0, 80), ...videoLog(input) });
    return { decision, provider: "mock", degraded: false, latencyMs: Date.now() - started, taskType: decision.taskType };
  }

  /**
   * Failure is presented as failure: provider "error" tells the client to show the confused
   * rabbit with an error bubble. The decision is a silent no-op so no client can mistake it
   * for dialogue — nothing but the OpenAI client ever speaks in a live session.
   */
  private honestFailure(started: number, reason: string): AgentOutput {
    const decision = {
      ...DECISION_DEFAULTS,
      action: "finish" as const,
      taskType: "chat" as const, reason, done: true,
    };
    return { decision, provider: "error", degraded: true, latencyMs: Date.now() - started, taskType: "chat" };
  }

  /**
   * The leak-check pass: reject any hint that states the final answer. One corrective retry at
   * the same rung; if the model leaks again, swap in the deterministic safe hint. Only enforced
   * where the answer is computable (detected problems) — the ladder prompt covers the rest.
   */
  private async enforceNoLeak(decision: AgentDecision, input: AgentInput): Promise<AgentDecision> {
    const problem = detectProblem(input.page);
    // Locally solvable shapes first; otherwise whatever the step planner derived for this problem.
    const local = finalAnswersFor(problem);
    const answers = local.length ? local : this.steps?.answersFor(input.plan?.key) ?? [];
    if (!answers.length) return decision;
    const textOf = (d: AgentDecision) => `${d.say ?? ""}\n${d.text ?? ""}`;
    const first = leakedAnswer(textOf(decision), answers, { utterance: input.utterance });
    if (!first.leaked) return decision;
    logger.warn("hint leaked the final answer; retrying once", { matched: first.matched });
    try {
      const raw = await this.primary.decide({ ...input, retryNote: `your reply stated or confirmed the final answer (${first.matched}) — give the same level of hint again WITHOUT revealing or confirming the final answer in any form` });
      const v = validateDecision(raw);
      if (v.ok && !leakedAnswer(textOf(v.decision), answers, { utterance: input.utterance }).leaked) return v.decision;
    } catch (e) {
      logger.warn("leak retry failed", { error: e instanceof Error ? e.message : String(e) });
    }
    // Backstop: keep the action but replace the words with the deterministic safe hint.
    const safe = hintFor(problem, input.student.hintsForCurrentProblem, input.student);
    logger.warn("leak retry still leaked; substituting deterministic hint");
    return { ...decision, say: safe, text: decision.text ? safe : null };
  }

  async intervene(input: InterventionInput): Promise<InterventionOutput> {
    if (this.primary !== this.fallback) {
      try {
        const raw = await this.primary.intervene(input);
        const v = validateIntervention(raw);
        if (v.ok) {
          logger.info("intervene", { provider: this.primary.name, intervene: v.decision.intervene, type: v.decision.type });
          return { decision: v.decision, provider: this.primary.name, degraded: false };
        }
        logger.warn("primary intervention invalid; staying quiet", { error: v.error });
        return { decision: { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "invalid" }, provider: "error", degraded: true };
      } catch (e) {
        // A proactive offer nobody asked for is the one thing that can fail silently.
        logger.warn("primary intervention failed; staying quiet", { error: e instanceof Error ? e.message : String(e) });
        return { decision: { intervene: false, confidence: 0, type: "none", message: null, elementId: null, reason: "unavailable" }, provider: "error", degraded: true };
      }
    }
    const raw = await this.fallback.intervene(input);
    const v = validateIntervention(raw);
    const decision = v.ok ? v.decision : { intervene: false, confidence: 0, type: "none" as const, message: null, elementId: null, reason: "invalid" };
    logger.info("intervene", { provider: "mock", intervene: decision.intervene, type: decision.type });
    return { decision, provider: "mock", degraded: false };
  }
}
