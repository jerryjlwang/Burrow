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

describe("actionable suggestions", () => {
  const DAY = 24 * 3_600_000;

  it("reconciles what was just missed with a resource, ahead of other moves", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", "closer sun", T0);
    g.recordAttempt("Axial tilt", T0, { correct: false });
    const s = suggestNext(g, { currentConceptIds: ["axial-tilt"], sessionMisses: ["axial-tilt"], now: T0 + 10 })!;
    expect(s.kind).toBe("reconcile");
    expect(s.resource).toEqual({ query: "Axial tilt explained", prefer: "video" });
    expect(s.goal).toContain('look_up "Axial tilt explained"');
    expect(s.goal).toContain("open_tab");
    expect(s.message).not.toMatch(/closer sun/);
  });

  it("escalates a recurring misconception from questions to a resource", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", "closer sun", T0);
    g.resolveMisconception("Seasons", "closer sun", T0 + 1, { method: "hint", note: "australia" });
    g.recordMisconception("Seasons", "closer sun", T0 + 2);
    expect(suggestNext(g, { now: T0 + 3 })?.kind).toBe("reconcile");
  });

  it("prefers the modality that has worked for this learner", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 2; i++) {
      g.recordResource("Warmup", T0 + i * 10, { url: "https://en.wikipedia.org/wiki/W", title: "w", kind: "article", reason: "advance" });
      g.recordAttempt("Warmup", T0 + i * 10 + 1, { correct: true });
    }
    g.recordAttempt("Axial tilt", T0 + 50, { correct: false });
    expect(suggestNext(g, { sessionMisses: ["axial-tilt"], now: T0 + 60 })?.resource?.prefer).toBe("article");
  });

  it("offers a retrieval check once a held concept has faded", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 4; i++) g.recordAttempt("Moats", T0 + i, { correct: true });
    expect(suggestNext(g, { kinds: ["review"], now: T0 + 1000 })).toBeNull();
    const s = suggestNext(g, { kinds: ["review"], now: T0 + 6 * DAY })!;
    expect(s.kind).toBe("review");
    expect(s.goal).toContain("from memory");
  });

  it("follows curiosity to the unexplored neighbour", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 3; i++) g.recordAsk("Volcanoes", T0 + i);
    g.link("Volcanoes", "Plate tectonics", "related", 0.8, T0);
    const s = suggestNext(g, { kinds: ["explore"], now: T0 + 10 })!;
    expect(s).toMatchObject({ kind: "explore", conceptId: "plate-tectonics" });
    expect(s.resource?.query).toBe("Plate tectonics for kids");
  });

  it("walks a learning plan one open step at a time", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", goal: "geology", steps: [{ title: "What rocks are made of", concept: "Rock types", query: "rock types for kids" }, { title: "How plates move", concept: "Plate tectonics" }] }, T0);
    const first = suggestNext(g, { kinds: ["plan"], now: T0 + 1 })!;
    expect(first).toMatchObject({ kind: "plan", conceptId: "rock-types", resource: { query: "rock types for kids", prefer: "lesson" } });
    g.recordResource("Rock types", T0 + 2, { url: "https://www.khanacademy.org/x", title: "x", kind: "lesson", reason: "plan" });
    expect(suggestNext(g, { kinds: ["plan"], now: T0 + 3 })).toBeNull(); // still with step 1's resource
    expect(suggestNext(g, { kinds: ["plan"], now: T0 + 11 * 60_000 })?.conceptId).toBe("plate-tectonics");
  });

  it("does not repeat the same suggestion inside the resuggest window, across sessions", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 3; i++) g.recordAsk("Volcanoes", T0 + i);
    const s = suggestNext(g, { kinds: ["explore"], now: T0 + 10 })!;
    g.recordOffer(s.kind, "shown", T0 + 10, `${s.kind}:${s.conceptId}`);
    const reloaded = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(suggestNext(reloaded, { kinds: ["explore"], now: T0 + 3_600_000 })).toBeNull();
    expect(suggestNext(reloaded, { kinds: ["explore"], now: T0 + DAY })?.kind).toBe("explore");
  });
});
