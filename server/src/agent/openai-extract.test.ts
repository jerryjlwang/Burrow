import { describe, it, expect } from "vitest";
import { normalizeExtraction, type RawExtraction } from "./openai-extract";

describe("normalizeExtraction", () => {
  it("clamps salience/weight, maps null → undefined, and keeps aliases", () => {
    const raw: RawExtraction = {
      concepts: [{ label: "Seasons", aliases: ["the seasons"], domain: "science", salience: 1.4 }],
      edges: [{ from: "Axial tilt", to: "Seasons", type: "prerequisite", weight: -0.2 }],
      misconceptions: [{ concept: "Seasons", belief: "closer sun = summer", evidence: null }],
    };
    const out = normalizeExtraction(raw);
    expect(out.concepts[0]).toMatchObject({ label: "Seasons", aliases: ["the seasons"], domain: "science", salience: 1 });
    expect(out.edges[0]!.weight).toBe(0);
    expect(out.misconceptions[0]!.evidence).toBeUndefined();
  });

  it("drops entries with empty labels/beliefs and empty alias arrays", () => {
    const raw: RawExtraction = {
      concepts: [
        { label: "  ", aliases: [], domain: null, salience: 0.5 },
        { label: "Ratios", aliases: [], domain: null, salience: 0.5 },
      ],
      edges: [{ from: "Fractions", to: "Ratios", type: "related", weight: 0.5 }],
      misconceptions: [{ concept: "X", belief: "   ", evidence: "q" }],
    };
    const out = normalizeExtraction(raw);
    expect(out.concepts.map((c) => c.label)).toEqual(["Ratios"]);
    expect(out.concepts[0]!.aliases).toBeUndefined();
    expect(out.misconceptions).toEqual([]);
  });

  it("tolerates missing arrays and non-numeric fields without throwing", () => {
    const out = normalizeExtraction({ concepts: [{ label: "A", aliases: [], domain: null, salience: NaN as unknown as number }] } as unknown as RawExtraction);
    expect(out.concepts[0]!.salience).toBe(0.5);
    expect(out.edges).toEqual([]);
    expect(out.misconceptions).toEqual([]);
  });
});
