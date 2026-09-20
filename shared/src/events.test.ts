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
