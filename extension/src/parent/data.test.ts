import { describe, it, expect } from "vitest";
import { learningNotes, sampleGraph } from "./data";

describe("learningNotes", () => {
  it("turns the sample graph's diagnostics into parent-readable notes", () => {
    const now = 1_760_000_000_000;
    const titles = learningNotes(sampleGraph(now), "Sam", now).map((n) => n.title);
    expect(titles).toContain("Getting it right");
    expect(titles).toContain("Remembering it later");
    expect(titles).toContain("Curious about");
  });

  it("says nothing when there is no evidence", () => {
    expect(learningNotes({ version: 1, nodes: [], edges: [], updatedAt: 0 }, "Sam")).toEqual([]);
  });
});

describe("plan provenance for parents", () => {
  it("says where a plan came from and what finished a step", async () => {
    const { provenanceLine, completionLine } = await import("./data");
    const now = 1_760_000_000_000;
    const [castles, fractions] = sampleGraph(now).profile!.plans;
    expect(provenanceLine(castles, "Sam", now)).toBe('Sam asked 5 days ago: "I want to learn about castles"');
    expect(provenanceLine(fractions, "Sam", now)).toBe('From "Fractions homework, question 4", 6 days ago');
    expect(completionLine(castles.steps[0].completion!, now)).toBe('opened "Castles for kids (video)", 5 days ago');
    expect(completionLine(castles.steps[1].completion!, now)).toBe("answered a question on it correctly, yesterday");
  });
});
