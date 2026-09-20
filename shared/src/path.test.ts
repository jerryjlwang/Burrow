import { describe, it, expect } from "vitest";
import { suggestNext } from "./path";
import { KnowledgeGraph } from "./graph";

const T0 = 1_700_000_000_000;

describe("suggestNext", () => {
  it("prefers shoring up an unseen prerequisite of the current page", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Ratios", T0);
    g.link("Fractions", "Ratios", "prerequisite", 0.9, T0);
    const s = suggestNext(g, { currentConceptIds: ["ratios"] });
    expect(s?.kind).toBe("prerequisite");
    expect(s?.conceptId).toBe("fractions");
    expect(s?.message).toContain("Fractions");
  });

  it("suggests revisiting an open misconception elsewhere, but not the current topic", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", "summer happens because Earth is closer to the sun", T0);
    for (let i = 0; i < 5; i++) g.recordSuccess("Linear equations", T0 + i);
    expect(suggestNext(g, { currentConceptIds: ["linear-equations"] })?.kind).toBe("revisit");
    expect(suggestNext(g, { currentConceptIds: ["seasons"] })?.kind ?? "none").not.toBe("revisit");
  });

  it("advances to the weakest related concept once the current one is solid", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 5; i++) g.recordSuccess("Two-step equations", T0 + i);
    g.link("Two-step equations", "Graphing lines", "related", 0.8, T0);
    const s = suggestNext(g, { currentConceptIds: ["two-step-equations"] });
    expect(s?.kind).toBe("advance");
    expect(s?.conceptId).toBe("graphing-lines");
  });

  it("respects the kinds filter and returns null when nothing qualifies", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", "belief", T0);
    expect(suggestNext(g, { currentConceptIds: [], kinds: ["prerequisite"] })).toBeNull();
    expect(suggestNext(new KnowledgeGraph(), { currentConceptIds: ["x"] })).toBeNull();
  });

  it("never puts answer content in the message — topics only", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", "summer happens because Earth is closer to the sun", T0);
    const s = suggestNext(g, {});
    expect(s?.message).not.toContain("closer to the sun"); // belief stays in the goal, not the bubble
    expect(s?.goal).toContain("closer to the sun");
  });
});
