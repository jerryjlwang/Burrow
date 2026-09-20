import { describe, it, expect } from "vitest";
import { KnowledgeGraph } from "./graph";
import { applyLearnerEvent, resourceKindOf, type LearnerEvent } from "./events";

const T0 = 1_700_000_000_000;

describe("applyLearnerEvent", () => {
  it("replays identically on the tab mirror and the canonical graph", () => {
    const events: LearnerEvent[] = [
      { kind: "extraction", at: T0, ctx: { url: "u", title: "t", kind: "page" }, extraction: { concepts: [{ label: "Axial tilt", salience: 0.9 }], edges: [], misconceptions: [{ concept: "Seasons", belief: "closer sun" }], missed: ["Axial tilt"] } },
      { kind: "attempt", concept: "Axial tilt", correct: true, hinted: false, at: T0 + 1 },
      { kind: "struggle", concept: "Axial tilt", at: T0 + 2 },
      { kind: "selfCorrection", concept: "Axial tilt", at: T0 + 3 },
      { kind: "ask", concept: "Volcanoes", at: T0 + 4 },
      { kind: "offer", offer: "explore", outcome: "shown", key: "explore:volcanoes", at: T0 + 5 },
      { kind: "resource", concept: "Volcanoes", url: "https://www.youtube.com/watch?v=1", title: "Volcanoes", resourceKind: "video", reason: "explore", at: T0 + 6 },
      { kind: "plan", plan: { key: "topic:geology", goal: "geology", steps: [{ title: "a" }, { title: "b" }] }, at: T0 + 7 },
      { kind: "resolve", concept: "Seasons", belief: "closer sun", at: T0 + 8, resolution: { method: "self", note: "australia" } },
    ];
    const tab = new KnowledgeGraph();
    const canonical = new KnowledgeGraph();
    for (const e of events) applyLearnerEvent(tab, e);
    for (const e of structuredClone(events)) applyLearnerEvent(canonical, e);
    const strip = (g: KnowledgeGraph) => ({ ...g.toJSON(), updatedAt: 0 });
    expect(strip(tab)).toEqual(strip(canonical));
    const tilt = tab.get("axial-tilt")!.state;
    expect(tilt).toMatchObject({ attempts: 2, correct: 1, selfCorrections: 1 }); // missed + attempt
    expect(tab.profile.plans).toHaveLength(1);
    expect(tab.activeMisconceptions()).toHaveLength(0);
  });
});

describe("resourceKindOf", () => {
  it("classifies destinations by modality", () => {
    expect(resourceKindOf("https://www.youtube.com/watch?v=abc")).toBe("video");
    expect(resourceKindOf("https://www.khanacademy.org/science/x/v/intro")).toBe("video");
    expect(resourceKindOf("https://www.khanacademy.org/search?page_search_query=x")).toBe("lesson");
    expect(resourceKindOf("https://www.khanacademy.org/math/algebra/e/linear")).toBe("practice");
    expect(resourceKindOf("https://en.wikipedia.org/wiki/Axial_tilt")).toBe("article");
    expect(resourceKindOf("https://example.com/")).toBe("page");
    expect(resourceKindOf("not a url")).toBe("page");
  });
});


describe("graded results pages", () => {
  const results = (at: number, missed: string[]): LearnerEvent => ({ kind: "extraction", at, ctx: { url: "https://example.edu/quiz/results#top", title: "Results", kind: "page" }, extraction: { concepts: [], edges: [], misconceptions: [], missed } });
  const DAY = 24 * 3_600_000;

  it("counts a results page once: a reload is not a second set of wrong answers", () => {
    const g = new KnowledgeGraph();
    applyLearnerEvent(g, results(T0, ["Seasons", "Plate tectonics"]));
    applyLearnerEvent(g, results(T0 + 60_000, ["Plate tectonics", "Seasons"])); // reload, order differs
    expect(g.get("seasons")!.state.attempts).toBe(1);
    expect(g.get("plate-tectonics")!.state.attempts).toBe(1);
  });

  it("still counts a retake with different misses, the same result a day later, and survives persistence", () => {
    const g = new KnowledgeGraph();
    applyLearnerEvent(g, results(T0, ["Seasons", "Plate tectonics"]));
    applyLearnerEvent(g, results(T0 + 60_000, ["Seasons"])); // retake: only one miss now
    expect(g.get("seasons")!.state.attempts).toBe(2);
    const back = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    applyLearnerEvent(back, results(T0 + 120_000, ["Seasons"])); // reload in a new session
    expect(back.get("seasons")!.state.attempts).toBe(2);
    applyLearnerEvent(back, results(T0 + DAY + 120_000, ["Seasons"]));
    expect(back.get("seasons")!.state.attempts).toBe(3);
  });
});
