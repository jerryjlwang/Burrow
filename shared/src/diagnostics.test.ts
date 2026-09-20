import { describe, it, expect } from "vitest";
import { KnowledgeGraph, RECALL, emptyProfile } from "./graph";
import { diagnose, diagnoseConcept, formatDiagnostics, preferredModality, retention } from "./diagnostics";

const T0 = 1_700_000_000_000;
const DAY = 24 * 3_600_000;

describe("attempts → precision and recall", () => {
  it("precision is correct / attempts, and stays unknown below the evidence floor", () => {
    const g = new KnowledgeGraph();
    g.recordAttempt("Fractions", T0, { correct: false });
    expect(diagnoseConcept(g.get("fractions")!, T0).precision.value).toBeNull();
    g.recordAttempt("Fractions", T0 + 1000, { correct: true });
    g.recordAttempt("Fractions", T0 + 2000, { correct: true });
    const d = diagnoseConcept(g.get("fractions")!, T0 + 2000);
    expect(d.precision).toEqual({ value: 2 / 3, n: 3 });
  });

  it("only the first attempt after the gap is a retrieval opportunity, and a hinted one is not a recall", () => {
    const g = new KnowledgeGraph();
    g.recordAttempt("Moats", T0, { correct: true });
    g.recordAttempt("Moats", T0 + 60_000, { correct: true }); // same sitting: not a retrieval
    expect(g.get("moats")!.state.recallOpportunities).toBe(0);
    g.recordAttempt("Moats", T0 + RECALL.gapMs + 60_000, { correct: true });
    g.recordAttempt("Moats", T0 + 2 * RECALL.gapMs + 120_000, { correct: true, hinted: true });
    const st = g.get("moats")!.state;
    expect(st.recallOpportunities).toBe(2);
    expect(st.recallSuccesses).toBe(1);
    expect(diagnose(g, T0 + 3 * RECALL.gapMs).recall).toEqual({ value: 0.5, n: 2 });
  });

  it("a wrong attempt is a struggle and lowers mastery; a hinted success gains less than an unaided one", () => {
    const a = new KnowledgeGraph();
    const b = new KnowledgeGraph();
    a.recordAttempt("X", T0, { correct: true });
    b.recordAttempt("X", T0, { correct: true, hinted: true });
    expect(a.get("x")!.state.mastery).toBeGreaterThan(b.get("x")!.state.mastery);
    const before = a.get("x")!.state.mastery;
    a.recordAttempt("X", T0 + 1, { correct: false });
    expect(a.get("x")!.state.mastery).toBeLessThan(before);
    expect(a.get("x")!.state.struggles).toBe(1);
    expect(a.profile.solves).toEqual({ unaided: 1, hinted: 0 });
  });
});

describe("retention and review", () => {
  it("decays with time away, slower after successful recalls", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 4; i++) g.recordAttempt("Tilt", T0 + i, { correct: true });
    const fresh = structuredClone(g.get("tilt")!.state);
    expect(retention(fresh, T0 + 10)).toBeCloseTo(fresh.mastery, 3);
    const after = retention(fresh, T0 + 5 * DAY);
    expect(after).toBeLessThan(fresh.mastery * 0.5);
    expect(retention({ ...fresh, recallSuccesses: 3 }, T0 + 5 * DAY)).toBeGreaterThan(after);
  });

  it("flags a once-held concept as due, but not one never held", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 4; i++) g.recordAttempt("Tilt", T0 + i, { correct: true });
    g.recordExposure("Glanced at", T0);
    expect(diagnose(g, T0 + 60_000).dueForReview).toHaveLength(0);
    const later = diagnose(g, T0 + 6 * DAY);
    expect(later.dueForReview.map((c) => c.id)).toEqual(["tilt"]);
  });
});

describe("curiosity", () => {
  it("counts their own questions and searches, not assigned exposure, and fades with time", () => {
    const g = new KnowledgeGraph();
    for (let i = 0; i < 5; i++) g.recordExposure("Assigned chapter", T0 + i, { source: { url: "u", title: "t", at: T0, kind: "page" } });
    g.recordAsk("Volcanoes", T0);
    g.recordAsk("Volcanoes", T0 + DAY);
    g.recordExposure("Volcanoes", T0 + DAY, { source: { url: "u", title: "t", at: T0, kind: "query" } });
    const d = diagnose(g, T0 + DAY);
    expect(d.interests.map((c) => c.id)).toEqual(["volcanoes"]);
    const much = diagnose(g, T0 + 60 * DAY);
    expect(much.interests).toHaveLength(0);
  });

  it("rolls interest up by domain", () => {
    const g = new KnowledgeGraph();
    g.ensureConcept("Volcanoes", T0, { domain: "geology" });
    g.ensureConcept("Plate tectonics", T0, { domain: "geology" });
    for (const c of ["Volcanoes", "Plate tectonics"]) for (let i = 0; i < 2; i++) g.recordAsk(c, T0 + i);
    expect(diagnose(g, T0 + 10).interestDomains[0].domain).toBe("geology");
  });
});

describe("profile: offers, resources, plans", () => {
  it("credits a resource with the next graded attempt on its concept, and learns the modality that works", () => {
    const g = new KnowledgeGraph();
    for (const [i, ok] of [true, true, false].entries()) {
      g.recordResource("Tilt", T0 + i * 10, { url: `https://www.youtube.com/watch?v=${i}`, title: "v", kind: "video", reason: "reconcile" });
      g.recordAttempt("Tilt", T0 + i * 10 + 5, { correct: ok });
    }
    expect(g.profile.resources.map((r) => r.helped)).toEqual([true, true, false]);
    const d = diagnose(g, T0 + 100);
    expect(d.modalities[0]).toMatchObject({ kind: "video", opened: 3, settled: 3, helped: 2 });
    expect(preferredModality(d)).toBe("video");
  });

  it("tracks offer outcomes and remembers when a suggestion was last made", () => {
    const g = new KnowledgeGraph();
    g.recordOffer("explore", "shown", T0, "explore:volcanoes");
    g.recordOffer("explore", "accepted", T0 + 1);
    expect(g.profile.offers.explore).toEqual({ shown: 1, accepted: 1, declined: 0, lastAt: T0 });
    expect(g.lastSuggestedAt("explore:volcanoes")).toBe(T0);
    expect(g.lastSuggestedAt("explore:other")).toBe(0);
  });

  it("completes a plan step when its resource is opened, and keeps done-flags on re-save", () => {
    const g = new KnowledgeGraph();
    const plan = { key: "topic:geology", goal: "geology", steps: [{ title: "Rocks", concept: "Rock types" }, { title: "Plates", concept: "Plate tectonics" }] };
    g.savePlan(plan, T0);
    g.recordResource("Rock types", T0 + 1, { url: "https://www.khanacademy.org/x", title: "x", kind: "lesson", reason: "plan" });
    expect(g.activePlan()!.steps.map((s) => s.done)).toEqual([true, false]);
    g.savePlan(plan, T0 + 2);
    expect(g.activePlan()!.steps[0].done).toBe(true);
    g.recordAttempt("Plate tectonics", T0 + 3, { correct: true });
    expect(g.activePlan()).toBeNull();
  });

  it("survives persistence, and reads a snapshot written before these fields existed", () => {
    const g = new KnowledgeGraph();
    g.recordAttempt("Tilt", T0, { correct: true });
    g.recordOffer("review", "shown", T0, "review:tilt");
    const back = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(back.get("tilt")!.state.correct).toBe(1);
    expect(back.lastSuggestedAt("review:tilt")).toBe(T0);

    const legacy = { version: 1, updatedAt: 0, edges: [], nodes: [{ id: "old", label: "Old", aliases: [], sources: [], misconceptions: [], state: { firstSeenAt: 1, lastSeenAt: 2, exposures: 3, dwellMs: 0, asks: 0, struggles: 0, mastery: 0.4 } }] };
    const old = KnowledgeGraph.fromJSON(legacy);
    expect(old.get("old")!.state).toMatchObject({ mastery: 0.4, attempts: 0, recallOpportunities: 0, voluntary: 0 });
    expect(old.profile.resources).toEqual([]);
    old.recordAttempt("Old", T0, { correct: true });
    expect(old.get("old")!.state.attempts).toBe(1);
  });

  it("drops a malformed profile instead of throwing", () => {
    const g = KnowledgeGraph.fromJSON({ version: 1, nodes: [], edges: [], updatedAt: 0, profile: { offers: "nope", resources: [{ url: 3 }, null], plans: [{ key: "k" }], suggested: [7] } });
    expect(g.profile).toEqual(emptyProfile());
  });
});

describe("formatDiagnostics", () => {
  it("is null with no evidence and compact with some", () => {
    expect(formatDiagnostics(diagnose(new KnowledgeGraph(), T0))).toBeNull();
    const g = new KnowledgeGraph();
    g.recordAttempt("Tilt", T0, { correct: true });
    g.recordAttempt("Tilt", T0 + 1, { correct: false });
    for (let i = 0; i < 3; i++) g.recordAsk("Volcanoes", T0 + i);
    const text = formatDiagnostics(diagnose(g, T0 + 10))!;
    expect(text).toContain("50% (n=2)");
    expect(text).toContain("curious about: Volcanoes");
  });
});

describe("plans in diagnostics", () => {
  it("summarises plan progress for the prompt, so the agent knows what exists before showing it", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", goal: "geology", steps: [{ title: "Rocks", concept: "Rock types" }, { title: "Plates", concept: "Plate tectonics" }] }, T0);
    g.recordAttempt("Rock types", T0 + 1, { correct: true });
    const d = diagnose(g, T0 + 2);
    expect(d.plans).toEqual([{ goal: "geology", done: 1, total: 2, next: "Plates" }]);
    expect(formatDiagnostics(d)).toContain('learning plan "geology": 1/2 steps done; next: Plates');
  });
});

describe("plan provenance in long-term memory", () => {
  const asked = { origin: "asked" as const, planner: "llm" as const, utterance: "I want to learn about geology", url: "https://example.edu/home", title: "Home" };
  const steps = [{ title: "Rocks", concept: "Rock types", query: "rock types for kids" }, { title: "Plates", concept: "Plate tectonics" }];

  it("records where a plan came from and what evidence completed each step", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", kind: "topic", goal: "geology", steps, provenance: asked }, T0);
    g.recordResource("Rock types", T0 + 10, { url: "https://www.khanacademy.org/rocks", title: "Types of rock", kind: "lesson", reason: "plan" });
    g.recordAttempt("Plate tectonics", T0 + 20, { correct: true });
    const plan = g.plan("topic:geology")!;
    expect(plan.provenance).toEqual(asked);
    expect(plan.steps[0].completion).toEqual({ at: T0 + 10, by: "resource", url: "https://www.khanacademy.org/rocks", title: "Types of rock" });
    expect(plan.steps[1].completion).toEqual({ at: T0 + 20, by: "attempt" });
    expect(plan.history.map((e) => e.type)).toEqual(["created", "step_done", "step_done"]);
    expect(plan.history[0].detail).toBe("I want to learn about geology");
  });

  it("re-saving a plan never rewrites its origin, completions or history", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", kind: "topic", goal: "geology", steps, provenance: asked }, T0);
    g.recordAttempt("Rock types", T0 + 5, { correct: true });
    const again = g.savePlan({ key: "topic:geology", goal: "geology", steps, provenance: { origin: "asked", planner: "scaffold", utterance: "different words" } }, T0 + 9);
    expect(again.createdAt).toBe(T0);
    expect(again.provenance).toEqual(asked);
    expect(again.steps[0].completion?.by).toBe("attempt");
    expect(again.history).toHaveLength(2);
  });

  it("keeps a worked problem's plan with its progress, wrong lines and solve — by key, not by concept", () => {
    const g = new KnowledgeGraph();
    const page = { origin: "page" as const, planner: "deterministic" as const, url: "https://example.edu/working", title: "Show your work" };
    const problem = [{ title: "Clear the constant", concept: "Linear equations" }, { title: "Divide out the coefficient", concept: "Linear equations" }, { title: "Check", concept: "Linear equations" }];
    g.savePlan({ key: "eq:3x + 5 = 20", kind: "problem", goal: "Solve 3x + 5 = 20", steps: problem, provenance: page }, T0);
    g.savePlan({ key: "eq:2x - 4 = 10", kind: "problem", goal: "Solve 2x - 4 = 10", steps: problem, provenance: page }, T0);
    g.recordPlanProgress("eq:3x + 5 = 20", T0 + 1, { wrongStep: 2, by: "working" });
    g.recordPlanProgress("eq:3x + 5 = 20", T0 + 2, { wrongStep: 2, by: "working" }); // same wrong line: logged once
    g.recordPlanProgress("eq:3x + 5 = 20", T0 + 3, { reached: 1, by: "working" });
    g.recordAttempt("Linear equations", T0 + 4, { correct: true }); // evidence on the concept must not complete OTHER problems
    g.recordPlanProgress("eq:3x + 5 = 20", T0 + 5, { solved: true, by: "attempt" });
    const solved = g.plan("eq:3x + 5 = 20")!;
    expect(solved.history.map((e) => `${e.type}:${e.step ?? ""}`)).toEqual(["created:", "wrong_step:2", "step_done:1", "step_done:2", "step_done:3", "solved:"]);
    expect(solved.solvedAt).toBe(T0 + 5);
    expect(solved.steps[0].completion).toMatchObject({ by: "working", title: "Show your work" });
    expect(g.plan("eq:2x - 4 = 10")!.steps.every((s) => !s.done)).toBe(true);
    expect(g.recordPlanProgress("eq:unknown", T0, { solved: true, by: "attempt" })).toBeNull();
  });

  it("worked problems never crowd out, or masquerade as, the plans the learner asked for", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", kind: "topic", goal: "geology", steps, provenance: asked }, T0);
    for (let i = 0; i < 60; i++) g.savePlan({ key: `page:p${i}`, kind: "problem", goal: `p${i}`, steps: [{ title: "a" }, { title: "b" }] }, T0 + 1 + i);
    expect(g.plan("topic:geology")).not.toBeNull();
    expect(g.profile.plans.filter((p) => p.kind === "problem")).toHaveLength(40);
    expect(g.plan("page:p0")).toBeNull(); // oldest worked problems age out first
    expect(g.activePlan()?.key).toBe("topic:geology");
    expect(diagnose(g, T0 + 100).plans).toHaveLength(1);
  });

  it("survives persistence, and upgrades a plan stored before provenance existed", () => {
    const g = new KnowledgeGraph();
    g.savePlan({ key: "topic:geology", kind: "topic", goal: "geology", steps, provenance: asked }, T0);
    g.recordResource("Rock types", T0 + 10, { url: "https://www.khanacademy.org/rocks", title: "Types of rock", kind: "lesson", reason: "plan" });
    const back = KnowledgeGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
    expect(back.plan("topic:geology")).toEqual(g.plan("topic:geology"));

    const legacy = KnowledgeGraph.fromJSON({ version: 1, nodes: [], edges: [], updatedAt: 0, profile: { plans: [{ key: "topic:old", goal: "old", createdAt: 1, updatedAt: 2, steps: [{ title: "a", done: true }, { title: "b", done: false }] }] } });
    expect(legacy.plan("topic:old")).toMatchObject({ kind: "topic", history: [], steps: [{ done: true }, { done: false }] });
    expect(legacy.plan("topic:old")!.provenance).toBeUndefined();
  });
});
