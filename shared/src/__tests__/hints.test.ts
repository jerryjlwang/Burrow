import { describe, expect, it } from "vitest";
import { detectProblem, hintFor } from "../hints";
import type { PageSummary } from "../types";

const base: PageSummary = { url: "x", title: "t", headings: [], textSummary: "", elements: [], errors: [], successes: [], dialogs: [], forms: 0, landmarks: [], isPdf: false, hasQuizUi: true, scroll: { x: 0, y: 0, maxY: 0 }, viewport: { width: 1, height: 1 }, capturedAt: 0, truncatedElements: 0 };

describe("hints", () => {
  it("detects linear equations including unicode minus", () => {
    expect(detectProblem({ ...base, textSummary: "Solve for x: 3x + 5 = 20" })).toMatchObject({ kind: "linear-equation", a: 3, op: "+", b: 5, c: 20 });
    expect(detectProblem({ ...base, textSummary: "2x − 4 = 10" })).toMatchObject({ kind: "linear-equation", a: 2, op: "-", b: 4, c: 10 });
  });
  it("gives progressively more direct hints without stating the final answer first", () => {
    const p = detectProblem({ ...base, textSummary: "3x + 5 = 20" });
    const h0 = hintFor(p, 0);
    const h2 = hintFor(p, 2);
    expect(h0).toMatch(/both sides/);
    expect(h0).not.toMatch(/x = 5/);
    expect(h2).toMatch(/3x = 15/);
  });
  it("falls back to generic Socratic hints", () => {
    const p = detectProblem({ ...base, textSummary: "What is the capital of France?" });
    expect(p.kind).toBe("generic");
    expect(hintFor(p, 0)).toMatch(/asking you to find/);
  });
});
