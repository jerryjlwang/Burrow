import OpenAI from "openai";
import type { ConceptExtraction, ConceptExtractor, ExtractionInput } from "@shared/concepts";
import { log } from "../util/logger";

const logger = log("extract");

export interface OpenAIExtractorOptions {
  apiKey: string;
  model: string;
  effort: "none" | "minimal" | "low" | "medium" | "high";
}

const SYSTEM_PROMPT = `You build a learner knowledge graph from what a student is currently looking at in their browser (a page, or a search query they typed).

Extract four things:
- concepts: the curriculum-level ideas actually present — e.g. "axial tilt", "linear equations", "photosynthesis". Use canonical names, NOT UI labels, site names, section boilerplate, or navigation. Add short aliases only if the page phrases a concept differently. salience is 0..1: how central each concept is to this view.
- edges: prerequisite links (from must be understood before to) and related links, both among the concepts above and to well-known foundational concepts a learner needs first (e.g. "fractions" is a prerequisite of "ratios"). Only include edges you are confident about.
- missed: ONLY when the page is showing graded results or feedback (a score, questions marked incorrect): the concepts of the questions the student got WRONG, using the same canonical names. [] on every other page — never guess.
- misconceptions: a wrong belief evident in the student's query or text — e.g. the query "why is summer hot sun closer" reveals the belief "summer happens because Earth is closer to the sun" on the concept "seasons". Only emit one when there is REAL evidence; never invent a misconception. Put the triggering text in evidence.

Prefer a few high-quality concepts over many noisy ones. Return empty arrays if there is nothing meaningful (e.g. a login page). Output only the JSON object.`;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Canonical concept name." },
          aliases: { type: "array", items: { type: "string" }, description: "Alternate phrasings on the page; [] if none." },
          domain: nullable({ type: "string" }),
          salience: { type: "number", description: "0..1 centrality to this view." },
        },
        required: ["label", "aliases", "domain", "salience"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string", enum: ["prerequisite", "related"] },
          weight: { type: "number", description: "0..1 confidence in the link." },
        },
        required: ["from", "to", "type", "weight"],
        additionalProperties: false,
      },
    },
    misconceptions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          concept: { type: "string" },
          belief: { type: "string", description: "The wrong belief in plain words." },
          evidence: nullable({ type: "string" }),
        },
        required: ["concept", "belief", "evidence"],
        additionalProperties: false,
      },
    },
    missed: { type: "array", items: { type: "string" }, description: "Concepts of questions the page marks as answered wrong; [] unless graded results are showing." },
  },
  required: ["concepts", "edges", "misconceptions", "missed"],
  additionalProperties: false,
} as const;

export interface RawExtraction {
  concepts: Array<{ label: string; aliases: string[]; domain: string | null; salience: number }>;
  edges: Array<{ from: string; to: string; type: "prerequisite" | "related"; weight: number }>;
  misconceptions: Array<{ concept: string; belief: string; evidence: string | null }>;
  missed?: string[];
}

function formatInput(input: ExtractionInput): string {
  const lines = [`URL: ${input.url}`, `TITLE: ${input.title}`];
  if (input.query) lines.push(`SEARCH QUERY: ${input.query}`);
  if (input.selection) lines.push(`SELECTED TEXT: ${input.selection.slice(0, 400)}`);
  if (input.headings?.length) lines.push(`HEADINGS:\n- ${input.headings.slice(0, 20).join("\n- ")}`);
  if (input.text) lines.push(`PAGE TEXT:\n${input.text.slice(0, 4000)}`);
  return lines.join("\n");
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Coerce raw model output into a clean ConceptExtraction — clamps, drops empties, null→undefined. */
export function normalizeExtraction(raw: RawExtraction): ConceptExtraction {
  return {
    concepts: (raw.concepts ?? [])
      .filter((c) => c && typeof c.label === "string" && c.label.trim())
      .map((c) => ({ label: c.label.trim(), aliases: Array.isArray(c.aliases) && c.aliases.length ? c.aliases : undefined, domain: c.domain ?? undefined, salience: Math.max(0, Math.min(1, num(c.salience, 0.5))) })),
    edges: (raw.edges ?? [])
      .filter((e) => e && typeof e.from === "string" && typeof e.to === "string" && (e.type === "prerequisite" || e.type === "related"))
      .map((e) => ({ from: e.from, to: e.to, type: e.type, weight: Math.max(0, Math.min(1, num(e.weight, 0.5))) })),
    misconceptions: (raw.misconceptions ?? [])
      .filter((m) => m && typeof m.concept === "string" && typeof m.belief === "string" && m.belief.trim())
      .map((m) => ({ concept: m.concept.trim(), belief: m.belief.trim(), evidence: m.evidence ?? undefined })),
    missed: (raw.missed ?? []).filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim().slice(0, 60)).slice(0, 6),
  };
}

/** OpenAI-backed concept extractor: the reactive producer's real brain (fuzzy naming, edges, open-ended misconceptions). */
export class OpenAIConceptExtractor implements ConceptExtractor {
  readonly name: string;
  private client: OpenAI;
  private opts: OpenAIExtractorOptions;
  private readonly reasoningModel: boolean;

  constructor(opts: OpenAIExtractorOptions) {
    this.opts = opts;
    this.name = `openai:${opts.model}`;
    this.client = new OpenAI({ apiKey: opts.apiKey, timeout: 35_000, maxRetries: 1 });
    this.reasoningModel = /^(gpt-[5-9]|o\d)/.test(opts.model);
  }

  async extract(input: ExtractionInput): Promise<ConceptExtraction> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.opts.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: formatInput(input) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "concept_extraction", strict: true, schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown> } },
      max_completion_tokens: 1200,
    };
    // "low" is the lowest effort every model generation accepts ("none"/"minimal" each 400 on some), and extraction is off the voice latency path.
    if (this.reasoningModel) params.reasoning_effort = this.opts.effort === "none" || this.opts.effort === "minimal" ? "low" : this.opts.effort;
    else params.temperature = 0.2;
    const res = await this.client.chat.completions.create(params);
    const choice = res.choices[0];
    if (!choice) throw new Error("empty completion");
    if (choice.message.refusal) throw new Error(`model refused: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new Error("extraction truncated (max tokens)");
    const text = choice.message.content;
    if (!text) throw new Error("no content in completion");
    logger.debug("usage", { prompt: res.usage?.prompt_tokens, completion: res.usage?.completion_tokens });
    return normalizeExtraction(JSON.parse(text) as RawExtraction);
  }
}
