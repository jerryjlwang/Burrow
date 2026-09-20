import { validateDecision, validateIntervention } from "@shared/schemas";
import type { AgentInput, AgentOutput, InterventionInput, InterventionOutput } from "@shared/types";
import type { AgentProvider } from "../agent/provider";
import { MockProvider } from "../agent/mock";
import { AnthropicProvider } from "../agent/anthropic";
import { OpenAIProvider } from "../agent/openai";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("agent");

export class AgentService {
  readonly primary: AgentProvider;
  readonly fallback = new MockProvider();

  constructor(cfg: Config) {
    if (cfg.llmProvider === "anthropic") {
      this.primary = new AnthropicProvider({ apiKey: cfg.llmApiKey || undefined, model: cfg.llmModel, effort: cfg.llmEffort === "minimal" ? "low" : cfg.llmEffort });
    } else if (cfg.llmProvider === "openai") {
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
          logger.info("decide", { provider: this.primary.name, action: v.decision.action, elementId: v.decision.elementId, ms: Date.now() - started, utterance: input.utterance.slice(0, 80) });
          return { decision: v.decision, provider: this.primary.name, degraded: false, latencyMs: Date.now() - started, taskType: v.decision.taskType };
        }
        logger.warn("primary decision still invalid; falling back", { error: v.error });
      } catch (e) {
        logger.warn("primary provider failed; falling back to mock", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const raw = await this.fallback.decide(input);
    const v = validateDecision(raw);
    const decision = v.ok
      ? v.decision
      : { action: "speak" as const, say: "I'm having trouble thinking right now. Try me again in a moment.", elementId: null, text: null, url: null, direction: null, amount: null, value: null, pendingAction: null, taskType: "chat" as const, reason: "fallback", done: true };
    logger.info("decide", { provider: "mock", action: decision.action, elementId: decision.elementId, ms: Date.now() - started, utterance: input.utterance.slice(0, 80) });
    return { decision, provider: this.primary === this.fallback ? "mock" : "mock-fallback", degraded: this.primary !== this.fallback, latencyMs: Date.now() - started, taskType: decision.taskType };
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
        logger.warn("primary intervention invalid; falling back", { error: v.error });
      } catch (e) {
        logger.warn("primary intervention failed; falling back", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    const raw = await this.fallback.intervene(input);
    const v = validateIntervention(raw);
    const decision = v.ok ? v.decision : { intervene: false, confidence: 0, type: "none" as const, message: null, elementId: null, reason: "invalid" };
    logger.info("intervene", { provider: "mock", intervene: decision.intervene, type: decision.type });
    return { decision, provider: this.primary === this.fallback ? "mock" : "mock-fallback", degraded: this.primary !== this.fallback };
  }
}
