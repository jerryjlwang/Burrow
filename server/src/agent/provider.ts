import type { AgentDecision, InterventionDecision } from "@shared/actions";
import type { AgentInput, InterventionInput } from "@shared/types";

/** Abstraction so the browser architecture never depends on one model vendor. */
export interface AgentProvider {
  readonly name: string;
  /** `onPartial` receives the decision's JSON as it streams in (providers that can't stream never call it). */
  decide(input: AgentInput, onPartial?: (jsonSoFar: string) => void): Promise<AgentDecision>;
  intervene(input: InterventionInput): Promise<InterventionDecision>;
}
