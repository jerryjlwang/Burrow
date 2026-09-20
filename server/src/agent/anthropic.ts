import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AgentDecisionSchema, InterventionDecisionSchema, type AgentDecision, type InterventionDecision } from "@shared/schemas";
import type { AgentInput, InterventionInput } from "@shared/types";
import type { AgentProvider } from "./provider";
import { SYSTEM_PROMPT, INTERVENTION_PROMPT, formatDecisionContext, formatInterventionContext } from "./prompt";
import { log } from "../util/logger";

const logger = log("agent");

export interface AnthropicProviderOptions {
  apiKey?: string;
  model: string;
  effort: "low" | "medium" | "high";
}

/**
 * Claude-backed provider using structured outputs, so the model can only ever return
 * a schema-valid action. Server-side refusal fallbacks are enabled by default.
 */
export class AnthropicProvider implements AgentProvider {
  readonly name: string;
  private client: Anthropic;
  private opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    this.opts = opts;
    this.name = `anthropic:${opts.model}`;
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), timeout: 35_000, maxRetries: 1 });
  }

  /** Server-side refusal fallbacks are on by default; if the API rejects the beta, retry once without it. */
  private useFallbacks = true;

  private async parse<T>(params: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "model">, format: ReturnType<typeof zodOutputFormat<z.ZodType<T>>>): Promise<T> {
    const base = { model: this.opts.model, ...params, output_config: { ...(params.output_config ?? {}), format } };
    const withFallbacks = { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };
    let response: Awaited<ReturnType<typeof this.client.beta.messages.parse<Anthropic.Beta.MessageCreateParamsNonStreaming & { output_config: { format: typeof format } }>>>;
    try {
      response = await this.client.beta.messages.parse(this.useFallbacks ? withFallbacks : base);
    } catch (e) {
      if (this.useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        logger.warn("API rejected server-side fallbacks; continuing without them", { error: e.message });
        this.useFallbacks = false;
        response = await this.client.beta.messages.parse(base);
      } else throw e;
    }
    if (response.stop_reason === "refusal") throw new Error(`model refused (${response.stop_details?.category ?? "unknown"})`);
    if (!response.parsed_output) throw new Error("model output did not match the schema");
    logger.debug("usage", { input: response.usage.input_tokens, cached: response.usage.cache_read_input_tokens, output: response.usage.output_tokens });
    return response.parsed_output as T;
  }

  async decide(input: AgentInput): Promise<AgentDecision> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (input.screenshot) {
      const m = input.screenshot.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
      if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1] as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: m[2] } });
    }
    content.push({ type: "text", text: formatDecisionContext(input) });
    return this.parse<AgentDecision>(
      {
        max_tokens: 1024,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { effort: this.opts.effort },
      },
      zodOutputFormat(AgentDecisionSchema),
    );
  }

  async intervene(input: InterventionInput): Promise<InterventionDecision> {
    return this.parse<InterventionDecision>(
      {
        max_tokens: 400,
        system: [{ type: "text", text: INTERVENTION_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: formatInterventionContext(input) }],
        output_config: { effort: "low" },
      },
      zodOutputFormat(InterventionDecisionSchema),
    );
  }
}
