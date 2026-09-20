import { describe, it, expect, vi } from "vitest";
import { StepService } from "./steps";
import type { OpenAIProvider } from "../agent/openai";

const fakeLlm = (reply: unknown) => ({ complete: vi.fn(async () => reply) }) as unknown as OpenAIProvider & { complete: ReturnType<typeof vi.fn> };

describe("StepService without an LLM", () => {
  const svc = new StepService(null);

  it("falls back to a generic scaffold for a problem and a three-step route for a topic", async () => {
    const problem = await svc.plan({ key: "page:x", title: "Photosynthesis quiz" });
    expect(problem).toMatchObject({ kind: "problem", source: "scaffold", key: "page:x" });
    const topic = await svc.plan({ topic: "Geology" });
    expect(topic).toMatchObject({ kind: "topic", key: "topic:geology" });
    expect(topic!.steps.every((s) => s.query && s.concept)).toBe(true);
  });

  it("does not pretend to judge", async () => {
    const plan = (await svc.plan({ key: "page:x" }))!;
    expect((await svc.judge({ plan, working: "a\nb" })).judged).toBe(false);
  });
});

describe("StepService with an LLM", () => {
  it("keeps final answers server-side for the leak filter and caches the plan", async () => {
    const llm = fakeLlm({ found: true, goal: "Name the process plants use to make food", steps: [{ title: "Recall what plants take in", concept: "Photosynthesis", query: null }, { title: "Name the process", concept: "Photosynthesis", query: null }], finalAnswers: ["photosynthesis"] });
    const svc = new StepService(llm);
    const plan = (await svc.plan({ key: "page:q1", title: "Quiz", text: "What process do plants use to make food?" }))!;
    expect(plan.source).toBe("llm");
    expect(JSON.stringify(plan)).not.toContain("finalAnswers");
    expect(svc.answersFor("page:q1")).toEqual(["photosynthesis"]);
    expect(svc.answersFor("page:other")).toEqual([]);
    await svc.plan({ key: "page:q1" });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("remembers that a page has no problem, so it is not asked about again", async () => {
    const llm = fakeLlm({ found: false, goal: "", steps: [], finalAnswers: [] });
    const svc = new StepService(llm);
    expect(await svc.plan({ key: "page:inbox" })).toBeNull();
    expect(await svc.plan({ key: "page:inbox" })).toBeNull();
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("judges any subject's working, sanitised through parseJudgement, and caches by working", async () => {
    const llm = fakeLlm({ judged: true, solved: false, planStep: 1, steps: [{ step: 1, ok: true, category: null }, { step: 2, ok: false, category: "reasoning", note: "LEAK: it is photosynthesis" }] });
    const svc = new StepService(llm);
    const plan = { key: "page:q1", kind: "problem" as const, goal: "g", steps: [{ title: "a" }, { title: "b" }], source: "llm" as const };
    const j = await svc.judge({ plan, working: "plants take in light\nso they eat soil" });
    expect(j).toMatchObject({ judged: true, firstWrongStep: 2, planStep: 1 });
    expect(j.steps[1]).toEqual({ step: 2, line: "so they eat soil", ok: false, category: "reasoning" });
    expect(JSON.stringify(j)).not.toContain("LEAK");
    await svc.judge({ plan, working: "plants take in light\nso they eat soil" });
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("degrades to the scaffold when the model call throws", async () => {
    const llm = { complete: vi.fn(async () => Promise.reject(new Error("boom"))) } as unknown as OpenAIProvider;
    expect((await new StepService(llm).plan({ key: "page:x", title: "T" }))?.source).toBe("scaffold");
  });
});
