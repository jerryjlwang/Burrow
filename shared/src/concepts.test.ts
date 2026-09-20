import { describe, it, expect } from "vitest";
import { HeuristicConceptExtractor, applyExtraction, pageToExtractionInput, type ConceptExtraction } from "./concepts";
import { KnowledgeGraph } from "./graph";
import type { PageSummary } from "./types";

const T0 = 1_700_000_000_000;
const ex = new HeuristicConceptExtractor();

describe("HeuristicConceptExtractor.concepts", () => {
  it("reads concepts from headings and title, stripping site suffix and numbering", () => {
    const out = ex.extract({
      url: "https://khanacademy.org/x",
      title: "Solving linear equations · Khan Academy",
      headings: ["1. Two-step equations", "Checking your solution"],
    });
    const labels = out.concepts.map((c) => c.label);
    expect(labels).toContain("Two-step equations");
    expect(labels).toContain("Checking your solution");
    expect(labels).toContain("Solving linear equations");
    // headings outrank the title in salience
    expect(out.concepts[0]!.salience).toBeGreaterThan(out.concepts.at(-1)!.salience);
  });

  it("filters nav chrome and dedupes title against a matching heading", () => {
    const out = ex.extract({
      url: "u",
      title: "Photosynthesis",
      headings: ["Home", "Menu", "Photosynthesis", "Next"],
    });
    expect(out.concepts.map((c) => c.label)).toEqual(["Photosynthesis"]);
  });

  it("returns nothing for empty input without throwing", () => {
    expect(ex.extract({ url: "u", title: "" })).toEqual({ concepts: [], edges: [], misconceptions: [] });
  });
});

describe("HeuristicConceptExtractor.misconceptions", () => {
  it("catches the closer-to-the-sun misconception from a query", () => {
    const out = ex.extract({ url: "u", title: "Google", query: "why is summer hot sun closer" });
    expect(out.misconceptions).toHaveLength(1);
    expect(out.misconceptions[0]!.concept).toBe("Seasons");
    expect(out.misconceptions[0]!.evidence).toBe("why is summer hot sun closer");
  });

  it("catches heavier-falls-faster from body text", () => {
    const out = ex.extract({ url: "u", title: "Forum", text: "i think heavier things fall faster than light ones right" });
    expect(out.misconceptions.map((m) => m.concept)).toEqual(["Gravity"]);
  });

  it("stays quiet on a benign query", () => {
    const out = ex.extract({ url: "u", title: "Google", query: "photosynthesis light reactions explained" });
    expect(out.misconceptions).toEqual([]);
  });
});

describe("applyExtraction", () => {
  it("records exposures with a source and splits dwell by salience", () => {
    const g = new KnowledgeGraph();
    const extraction = ex.extract({ url: "https://x", title: "Orbits", headings: ["Orbital period"] });
    const summary = applyExtraction(g, extraction, { url: "https://x", title: "Orbits", kind: "page", dwellMs: 10_000 }, T0);
    expect(summary.concepts).toBe(2);
    const period = g.get("orbital-period")!;
    expect(period.state.exposures).toBe(1);
    expect(period.sources[0]!.url).toBe("https://x");
    // "Orbital period" (0.9) gets more dwell than the title "Orbits" (0.6).
    expect(period.state.dwellMs).toBeGreaterThan(g.get("orbits")!.state.dwellMs);
    // dwell is split, not double-counted
    expect(period.state.dwellMs + g.get("orbits")!.state.dwellMs).toBeLessThanOrEqual(10_000);
  });

  it("records a detected misconception into the graph as active", () => {
    const g = new KnowledgeGraph();
    const extraction = ex.extract({ url: "u", title: "Google", query: "why is summer hot sun closer" });
    applyExtraction(g, extraction, { url: "u", title: "Google search", kind: "query" }, T0);
    const active = g.activeMisconceptions();
    expect(active).toHaveLength(1);
    expect(active[0]!.concept).toBe("seasons");
    expect(active[0]!.evidence).toBe("why is summer hot sun closer");
  });

  it("links edges supplied by an extraction (e.g. from the LLM extractor)", () => {
    const g = new KnowledgeGraph();
    const extraction: ConceptExtraction = {
      concepts: [{ label: "Ratios", salience: 0.9 }],
      edges: [{ from: "Fractions", to: "Ratios", type: "prerequisite", weight: 0.8 }],
      misconceptions: [],
    };
    applyExtraction(g, extraction, { url: "u", title: "t", kind: "page" }, T0);
    expect(g.unseenPrerequisites("ratios").map((n) => n.id)).toEqual(["fractions"]);
  });
});

describe("pageToExtractionInput", () => {
  it("maps the fields the extractor reads off a PageSummary", () => {
    const page = {
      url: "https://p",
      title: "Cells",
      headings: ["Mitochondria"],
      textSummary: "the powerhouse of the cell",
      selection: "ATP",
    } as PageSummary;
    const input = pageToExtractionInput(page, { query: "what is ATP" });
    expect(input).toMatchObject({ url: "https://p", title: "Cells", headings: ["Mitochondria"], text: "the powerhouse of the cell", selection: "ATP", query: "what is ATP" });
  });
});
