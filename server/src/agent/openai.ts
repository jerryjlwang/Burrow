import OpenAI from "openai";
import type { AgentDecision, InterventionDecision } from "@shared/actions";
import type { AgentInput, InterventionInput } from "@shared/types";
import type { AgentProvider } from "./provider";
import { SYSTEM_PROMPT, INTERVENTION_PROMPT, formatDecisionContext, formatInterventionContext } from "./prompt";
import { DECISION_JSON_SCHEMA, INTERVENTION_JSON_SCHEMA } from "./json-schemas";
import { log } from "../util/logger";

const logger = log("agent");

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  effort: "none" | "minimal" | "low" | "medium" | "high";
}

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** OpenAI-backed provider using Chat Completions with strict JSON-schema structured outputs. */
export class OpenAIProvider implements AgentProvider {
  readonly name: string;
  private client: OpenAI;
  private opts: OpenAIProviderOptions;
  private readonly reasoningModel: boolean;
  private effortOverrides = new Map<string, string>();

  private effortFor(effort: OpenAIProviderOptions["effort"]): OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"] {
    return (this.effortOverrides.get(effort) ?? effort) as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"];
  }

  constructor(opts: OpenAIProviderOptions) {
    this.opts = opts;
    this.name = `openai:${opts.model}`;
    // Bounded so the worst-case decide pipeline (call + one corrective retry) stays inside the
    // client's 40s budget — a slow answer must never look like a dead server.
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: 15_000, maxRetries: 0 });
    this.reasoningModel = /^(gpt-[5-9]|o\d)/.test(opts.model);
  }

  /** One strict-JSON-schema completion. Shared by the agent, the step planner and the step judge. */
  async complete<T>(system: string, user: ContentPart[], schemaName: string, schema: Record<string, unknown>, maxTokens: number, effort?: OpenAIProviderOptions["effort"]): Promise<T> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.opts.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      max_completion_tokens: maxTokens,
    };
    if (this.reasoningModel) params.reasoning_effort = this.effortFor(effort ?? this.opts.effort);
    else params.temperature = 0.3;
    let res: OpenAI.Chat.Completions.ChatCompletion;
    try {
      res = await this.client.chat.completions.create(params);
    } catch (e) {
      // Model generations disagree on effort names ("minimal" vs "none"): adopt what the API tells us it supports.
      const supported = e instanceof OpenAI.APIError && /reasoning_effort/.test(e.message) ? e.message.match(/Supported values are: ([^.]+)/)?.[1] : null;
      if (supported && this.reasoningModel) {
        const values = [...supported.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
        const wanted = String(params.reasoning_effort);
        const pick = wanted === "minimal" || wanted === "none" ? values.find((v) => v === "none" || v === "minimal") ?? values.find((v) => v === "low") : values.find((v) => v === wanted) ?? values.find((v) => v === "low") ?? values[0];
        if (pick) {
          logger.warn(`reasoning_effort '${wanted}' unsupported by ${this.opts.model}; using '${pick}'`);
          this.effortOverrides.set(wanted, pick);
          params.reasoning_effort = pick as OpenAI.Chat.Completions.ChatCompletionCreateParams["reasoning_effort"];
          res = await this.client.chat.completions.create(params);
        } else throw e;
      } else throw e;
    }
    const choice = res.choices[0];
    if (!choice) throw new Error("empty completion");
    if (choice.message.refusal) throw new Error(`model refused: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new Error("completion truncated (max tokens)");
    const text = choice.message.content;
    if (!text) throw new Error("no content in completion");
    logger.debug("usage", { prompt: res.usage?.prompt_tokens, completion: res.usage?.completion_tokens, cached: res.usage?.prompt_tokens_details?.cached_tokens });
    return JSON.parse(text) as T;
  }

  async decide(input: AgentInput): Promise<AgentDecision> {
    const parts: ContentPart[] = [];
    if (input.screenshot && /^data:image\/(jpeg|png|webp|gif);base64,/.test(input.screenshot)) {
      parts.push({ type: "image_url", image_url: { url: input.screenshot, detail: "low" } });
    }
    parts.push({ type: "text", text: formatDecisionContext(input) });
    return this.complete<AgentDecision>(SYSTEM_PROMPT, parts, "agent_decision", DECISION_JSON_SCHEMA as unknown as Record<string, unknown>, 900);
  }

  async intervene(input: InterventionInput): Promise<InterventionDecision> {
    return this.complete<InterventionDecision>(
      INTERVENTION_PROMPT,
      [{ type: "text", text: formatInterventionContext(input) }],
      "intervention_decision",
      INTERVENTION_JSON_SCHEMA as unknown as Record<string, unknown>,
      400,
      "low",
    );
  }
}
