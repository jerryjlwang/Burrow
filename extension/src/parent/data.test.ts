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
