import { describe, it, expect } from "vitest";
import { formatPlan, linearPlan, parsePlan, scaffoldPlan, topicPlanKey } from "./plan";

describe("plans", () => {
  it("linear plan names moves, never results", () => {
    const plan = linearPlan({ kind: "linear-equation", a: 3, op: "+", b: 5, c: 20, raw: "3x + 5 = 20" }, "eq:3x + 5 = 20");
    expect(plan.steps).toHaveLength(3);
    const text = plan.steps.map((s) => s.title).join(" ");
    expect(text).toMatch(/subtracting/);
    expect(text).not.toMatch(/\b15\b|x\s*=\s*5/);
    expect(linearPlan({ kind: "linear-equation", a: 1, op: "-", b: 4, c: 10, raw: "x - 4 = 10" }, "k").steps).toHaveLength(2);
  });

  it("parsePlan rejects unusable output and clamps the rest", () => {
    expect(parsePlan(null, { key: "k", source: "llm" })).toBeNull();
    expect(parsePlan({ goal: "g", steps: [{ title: "only one" }] }, { key: "k", source: "llm" })).toBeNull();
    expect(parsePlan({ goal: "", steps: [{ title: "a" }, { title: "b" }] }, { key: "k", source: "llm" })).toBeNull();
    const plan = parsePlan({ goal: "g", kind: "topic", steps: [{ title: "a", concept: "A", query: "a for kids" }, { title: 7 }, { title: "b".repeat(500) }, ...Array(10).fill({ title: "x" })] }, { key: "k", source: "llm" })!;
    expect(plan).toMatchObject({ key: "k", kind: "topic", source: "llm" });
    expect(plan.steps).toHaveLength(8);
    expect(plan.steps[0]).toEqual({ title: "a", concept: "A", query: "a for kids" });
    expect(plan.steps[1].title.length).toBe(140);
  });

  it("formatPlan marks where the student is", () => {
    const text = formatPlan(scaffoldPlan("k", "the question"), 1);
    expect(text).toContain("step 2 of 4");
    expect(text.split("\n")[1]).toContain("✓");
    expect(text.split("\n")[2]).toContain("← current");
  });

  it("topic keys are stable slugs", () => {
    expect(topicPlanKey("Plate Tectonics!")).toBe("topic:plate-tectonics");
  });
});
