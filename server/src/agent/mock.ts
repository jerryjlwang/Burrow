import { decideMock, interveneMock } from "@shared/mock-agent";
import type { AgentProvider } from "./provider";

export class MockProvider implements AgentProvider {
  readonly name = "mock";
  async decide(input: Parameters<typeof decideMock>[0]) {
    return decideMock(input);
  }
  async intervene(input: Parameters<typeof interveneMock>[0]) {
    return interveneMock(input);
  }
}
