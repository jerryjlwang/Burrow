import type { AgentDecision, InterventionDecision } from "@shared/actions";
import type { AgentInput, InterventionInput } from "@shared/types";

/** Abstraction so the browser architecture never depends on one model vendor. */
export interface AgentProvider {
  readonly name: string;
  decide(input: AgentInput): Promise<AgentDecision>;
  intervene(input: InterventionInput): Promise<InterventionDecision>;
}
