import { HeuristicConceptExtractor, type ConceptExtraction, type ConceptExtractor, type ExtractionInput } from "@shared/concepts";
import { OpenAIConceptExtractor } from "../agent/openai-extract";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("extract");

/**
 * Concept extraction service: OpenAI when a key is configured, heuristic otherwise or on failure.
 * Mirrors AgentService's degrade-to-deterministic pattern so browsing always fills the graph.
 */
export class ExtractService {
  private readonly primary: ConceptExtractor | null;
  private readonly fallback = new HeuristicConceptExtractor();
  readonly providerName: string;

  constructor(cfg: Config) {
    if (cfg.llmProvider === "openai" && cfg.llmApiKey) {
      const p = new OpenAIConceptExtractor({ apiKey: cfg.llmApiKey, model: cfg.llmModel, effort: cfg.llmEffort });
      this.primary = p;
      this.providerName = p.name;
    } else {
      this.primary = null;
      this.providerName = "heuristic";
    }
  }

  async extract(input: ExtractionInput): Promise<ConceptExtraction> {
    if (this.primary) {
      try {
        return await this.primary.extract(input);
      } catch (e) {
        logger.warn("primary extractor failed; using heuristic", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return this.fallback.extract(input);
  }
}
