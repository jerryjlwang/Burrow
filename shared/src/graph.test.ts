import { describe, it, expect } from "vitest";
import { KnowledgeGraph, MASTERY, slugify } from "./graph";

const T0 = 1_700_000_000_000;

describe("slugify", () => {
  it("normalizes labels to stable slugs", () => {
    expect(slugify("Axial Tilt")).toBe("axial-tilt");
    expect(slugify("  Earth's Axis!  ")).toBe("earth-s-axis");
    expect(slugify("café")).toBe("cafe");
  });
});

describe("KnowledgeGraph learner state", () => {
  it("raises mastery on exposure and lowers it on struggle", () => {
    const g = new KnowledgeGraph();
    const n = g.recordExposure("Axial Tilt", T0);
    expect(n.state.exposures).toBe(1);
    expect(n.state.mastery).toBeCloseTo(MASTERY.exposureGain, 5);
    const after = g.recordStruggle("axial tilt", T0 + 1000);
    expect(after.id).toBe(n.id);
    expect(after.state.struggles).toBe(1);
    expect(after.state.mastery).toBeLessThan(MASTERY.exposureGain);
  });

  it("resolves aliases to one concept", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Photosynthesis", T0, { aliases: ["making food from light"] });
    expect(g.resolve("making food from light")).toBe("photosynthesis");
    g.recordExposure("making food from light", T0 + 1);
    expect(g.size).toBe(1);
    expect(g.get("photosynthesis")!.state.exposures).toBe(2);
  });
});

describe("proactive + reactive queries", () => {
  it("unseenPrerequisites returns only prerequisites below the mastery threshold", () => {
    const g = new KnowledgeGraph();
    g.link("Multiplication", "Long Division", "prerequisite", 0.9, T0);
    g.link("Subtraction", "Long Division", "prerequisite", 0.9, T0);
    // Master multiplication, leave subtraction unseen.
    for (let i = 0; i < 6; i++) g.recordSuccess("Multiplication", T0 + i);
    const unseen = g.unseenPrerequisites("long-division");
    expect(unseen.map((n) => n.id)).toEqual(["subtraction"]);
  });

  it("recentExposures grounds on what was seen inside the window", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Orbit", T0, { source: { url: "u", title: "Orbit video", at: T0, kind: "video" } });
    g.recordExposure("Tides", T0 + 60_000);
    const recent = g.recentExposures(120_000, T0 + 90_000);
    expect(recent.map((n) => n.id)).toEqual(["tides", "orbit"]);
    const stale = g.recentExposures(45_000, T0 + 90_000);
    expect(stale.map((n) => n.id)).toEqual(["tides"]);
  });
});

describe("persistence + maintenance", () => {
  it("round-trips through JSON with edges and learner state intact", () => {
    const g = new KnowledgeGraph();
    g.link("Fractions", "Ratios", "prerequisite", 0.8, T0);
    g.recordExposure("Ratios", T0, { dwellMs: 5000 });
    const restored = KnowledgeGraph.fromJSON(g.toJSON());
    expect(restored.size).toBe(2);
    expect(restored.get("ratios")!.state.dwellMs).toBe(5000);
    expect(restored.unseenPrerequisites("ratios").map((n) => n.id)).toEqual(["fractions"]);
  });

  it("returns an empty graph for a corrupt blob instead of throwing", () => {
    expect(KnowledgeGraph.fromJSON({ garbage: true }).size).toBe(0);
    expect(KnowledgeGraph.fromJSON(null).size).toBe(0);
    expect(KnowledgeGraph.fromJSON("nope").size).toBe(0);
  });

  it("prune evicts least-recently-seen nodes and their edges past the cap", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Old", T0);
    g.recordExposure("New", T0 + 10_000);
    g.link("Old", "New", "related", 0.5, T0);
    const dropped = g.prune(1);
    expect(dropped).toBe(1);
    expect(g.get("old")).toBeNull();
    expect(g.related("new")).toEqual([]);
  });

  it("merge folds a session graph into a persisted one, summing counts", () => {
    const persisted = new KnowledgeGraph();
    persisted.recordExposure("Gravity", T0);
    const session = new KnowledgeGraph();
    session.recordExposure("Gravity", T0 + 1000);
    session.recordStruggle("Gravity", T0 + 2000);
    persisted.merge(session, T0 + 3000);
    const g = persisted.get("gravity")!;
    expect(g.state.exposures).toBe(2);
    expect(g.state.struggles).toBe(1);
  });
});

const BELIEF = "closer to the sun causes summer";

describe("misconceptions", () => {
  it("records a misconception as active and counts it as a struggle", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Seasons", T0);
    const before = g.get("seasons")!.state.mastery;
    const m = g.recordMisconception("Seasons", BELIEF, T0 + 1000, { evidence: "why is summer hot sun closer" });
    expect(m.status).toBe("active");
    expect(m.occurrences).toBe(1);
    expect(g.get("seasons")!.state.struggles).toBe(1);
    expect(g.get("seasons")!.state.mastery).toBeLessThan(before);
  });

  it("resolves a misconception and calls back to how they fixed it themselves", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", BELIEF, T0);
    const resolved = g.resolveMisconception("Seasons", BELIEF, T0 + 5000, {
      method: "self",
      note: "realized Australia has summer at the opposite time",
    });
    expect(resolved?.status).toBe("resolved");
    const callback = g.misconceptionCallback("Seasons");
    expect(callback?.resolution?.method).toBe("self");
    expect(callback?.resolution?.note).toContain("Australia");
  });

  it("flips a resolved misconception to recurring when it comes back", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", BELIEF, T0);
    g.resolveMisconception("Seasons", BELIEF, T0 + 1000, { method: "hint", rung: 2, note: "tilt, not distance" });
    const again = g.recordMisconception("Seasons", BELIEF, T0 + 10_000);
    expect(again.status).toBe("recurring");
    expect(again.occurrences).toBe(2);
    // The prior resolution is still callable — "last time, rung 2 fixed it".
    expect(g.misconceptionCallback("Seasons")?.resolution?.rung).toBe(2);
  });

  it("activeMisconceptions excludes resolved ones", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", BELIEF, T0);
    g.recordMisconception("Gravity", "heavier things fall faster", T0 + 100);
    g.resolveMisconception("Gravity", "heavier things fall faster", T0 + 200, { method: "self", note: "feather vs hammer on the moon" });
    const active = g.activeMisconceptions();
    expect(active.map((m) => m.concept)).toEqual(["seasons"]);
  });

  it("callback returns null when there is nothing to recall, so we stay silent", () => {
    const g = new KnowledgeGraph();
    g.recordExposure("Seasons", T0);
    expect(g.misconceptionCallback("Seasons")).toBeNull();
    g.recordMisconception("Seasons", BELIEF, T0 + 1); // unresolved → nothing to call back to
    expect(g.misconceptionCallback("Seasons")).toBeNull();
  });

  it("round-trips misconceptions and their resolution through JSON", () => {
    const g = new KnowledgeGraph();
    g.recordMisconception("Seasons", BELIEF, T0);
    g.resolveMisconception("Seasons", BELIEF, T0 + 1000, { method: "self", note: "opposite hemispheres" });
    const restored = KnowledgeGraph.fromJSON(g.toJSON());
    const cb = restored.misconceptionCallback("Seasons");
    expect(cb?.belief).toBe(BELIEF);
    expect(cb?.status).toBe("resolved");
    expect(cb?.resolution?.note).toBe("opposite hemispheres");
  });

  it("loads a pre-misconception snapshot, defaulting to an empty list", () => {
    // A blob persisted before the misconceptions field existed — no `misconceptions` on the node.
    const legacy = {
      version: 1,
      nodes: [
        {
          id: "seasons",
          label: "Seasons",
          aliases: [],
          state: { firstSeenAt: T0, lastSeenAt: T0, exposures: 1, dwellMs: 0, asks: 0, struggles: 0, mastery: 0.2 },
          sources: [],
        },
      ],
      edges: [],
      updatedAt: T0,
    };
    const g = KnowledgeGraph.fromJSON(legacy);
    expect(g.size).toBe(1);
    expect(g.get("seasons")!.misconceptions).toEqual([]);
  });

  it("merge folds misconceptions, summing occurrences and taking the later resolution", () => {
    const persisted = new KnowledgeGraph();
    persisted.recordMisconception("Seasons", BELIEF, T0);
    const session = new KnowledgeGraph();
    session.recordMisconception("Seasons", BELIEF, T0 + 1000);
    session.resolveMisconception("Seasons", BELIEF, T0 + 2000, { method: "self", note: "axial tilt" });
    persisted.merge(session, T0 + 3000);
    const m = persisted.get("seasons")!.misconceptions[0]!;
    expect(m.occurrences).toBe(2);
    expect(m.resolution?.note).toBe("axial tilt");
  });
});
