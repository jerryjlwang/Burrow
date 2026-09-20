import { describe, it, expect } from "vitest";
import { composeMisconceptionNudge } from "./nudge";
import { KnowledgeGraph, type Misconception } from "./graph";

const T0 = 1_700_000_000_000;

function mis(overrides: Partial<Misconception> = {}): Misconception {
  return {
    id: "summer-happens-because-earth-is-closer-to-the-sun",
    concept: "seasons",
    belief: "summer happens because Earth is closer to the sun",
    status: "active",
    firstSeenAt: T0,
    lastSeenAt: T0,
    occurrences: 1,
    ...overrides,
  };
}

describe("composeMisconceptionNudge", () => {
  it("uses the hand-written Socratic question for a seed belief, fuzzy-matched", () => {
    // LLM phrasing differs from the seed slug — the regex must still catch it.
    const { message } = composeMisconceptionNudge(mis({ belief: "Summer is hot because the Earth is nearer to the Sun." }));
    expect(message).toContain("Australia");
    expect(message).not.toMatch(/axial|tilt/i); // never states the correct answer
  });

  it("falls back to a test-your-belief prompt for an unrecognized belief", () => {
    const { message } = composeMisconceptionNudge(mis({ belief: "plants eat soil to grow" }));
    expect(message).toContain("plants eat soil to grow");
    expect(message).toMatch(/expect to see/);
  });

  it("calls back to the learner's own past fix on a recurring misconception", () => {
    const { message } = composeMisconceptionNudge(
      mis({
        status: "recurring",
        occurrences: 2,
        resolution: { at: T0 + 1000, method: "self", note: "Australia has summer when we have winter" },
      }),
    );
    expect(message).toContain("untangled this one before");
    expect(message).toContain("Australia has summer when we have winter");
  });

  it("treats recurring-without-a-note like a fresh nudge (nothing to call back to)", () => {
    const { message } = composeMisconceptionNudge(mis({ status: "recurring", occurrences: 2 }));
    expect(message).toContain("Australia"); // seed question, not the callback template
    expect(message).not.toContain("untangled");
  });

  it("builds a goal carrying belief, evidence and the Socratic constraint", () => {
    const { goal, message } = composeMisconceptionNudge(mis({ evidence: "why is summer hot sun closer" }));
    expect(goal).toContain('misconception: "summer happens because Earth is closer to the sun"');
    expect(goal).toContain('they wrote "why is summer hot sun closer"');
    expect(goal).toContain(message);
    expect(goal).toMatch(/do NOT state the correct explanation/);
  });

  it("full loop: detect → resolve with the question as the note → recur → callback recalls it", () => {
    // The exact sequence the proactive engine drives against the graph.
    const g = new KnowledgeGraph();
    const belief = "Summer happens because Earth is closer to the Sun.";
    const m = g.recordMisconception("seasons", belief, T0, { evidence: "why is summer hot sun closer" });
    const first = composeMisconceptionNudge(m);
    expect(first.message).toContain("Australia");
    // Success attributed → engine records the question as the resolution note.
    g.resolveMisconception("seasons", belief, T0 + 60_000, { method: "self", note: first.message });
    // A day later the same belief resurfaces on another page.
    const again = g.recordMisconception("seasons", belief, T0 + 86_400_000);
    expect(again.status).toBe("recurring");
    const second = composeMisconceptionNudge(again);
    expect(second.message).toContain("untangled this one before");
    expect(second.message).toContain("Australia");
  });

  it("keeps a long resolution note to one bubble-sized sentence", () => {
    const longNote = `${"the key realization was that seasons flip between hemispheres ".repeat(6)}.`;
    const { message } = composeMisconceptionNudge(mis({ status: "recurring", occurrences: 3, resolution: { at: T0, method: "self", note: longNote } }));
    const idx = message.indexOf("remember what cracked it? ");
    expect(idx).toBeGreaterThan(-1);
    expect(message.length).toBeLessThan(280);
  });
});
