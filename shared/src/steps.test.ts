import { describe, it, expect } from "vitest";
import { judgeWorking, parseLinearSide, parseWorkingLine } from "./steps";
import type { DetectedProblem } from "./hints";

// 3x + 5 = 20 → x = 5
const eq: DetectedProblem = { kind: "linear-equation", a: 3, op: "+", b: 5, c: 20, raw: "3x + 5 = 20" };

describe("parseLinearSide", () => {
  it("parses coefficients, constants, fractions and unary minus", () => {
    expect(parseLinearSide("3x + 5")).toEqual({ coef: 3, konst: 5 });
    expect(parseLinearSide("20 - 5")).toEqual({ coef: 0, konst: 15 });
    expect(parseLinearSide("-x")).toEqual({ coef: -1, konst: 0 });
    expect(parseLinearSide("15/3")).toEqual({ coef: 0, konst: 5 });
    expect(parseLinearSide("2*x - 1")).toEqual({ coef: 2, konst: -1 });
    expect(parseLinearSide("−2x")).toEqual({ coef: -2, konst: 0 }); // unicode minus
  });

  it("rejects things that are not linear expressions", () => {
    expect(parseLinearSide("x^2 + 1")).toBeNull();
    expect(parseLinearSide("3x 5")).toBeNull(); // missing operator
    expect(parseLinearSide("")).toBeNull();
    expect(parseWorkingLine("just thinking out loud")).toBeNull();
    expect(parseWorkingLine("3x + 5 = 20 = 15")).toBeNull();
  });
});

describe("judgeWorking", () => {
  it("accepts a fully correct derivation and detects the solve", () => {
    const j = judgeWorking(eq, "3x + 5 = 20\n3x = 15\nx = 15/3\nx = 5");
    expect(j.judged).toBe(true);
    expect(j.firstWrongStep).toBeNull();
    expect(j.solved).toBe(true);
    expect(j.steps.every((s) => s.ok === true)).toBe(true);
  });

  it("finds the first wrong step and flags a sign slip", () => {
    // Moved the +5 across without flipping: 3x = 25 is wrong; sign-flip of a term fixes it? 3x = 15 vs 25 — no.
    // Classic sign error: 3x = -15 (flipped the wrong way) → flipping rhs constant makes it hold.
    const j = judgeWorking(eq, "3x + 5 = 20\n3x = -15\nx = -5");
    expect(j.firstWrongStep).toBe(2);
    expect(j.steps[1]!.category).toBe("sign");
    expect(j.solved).toBe(false);
  });

  it("flags an arithmetic slip (20 - 5 = 25) at the right step", () => {
    const j = judgeWorking(eq, "3x + 5 = 20\n3x = 25\nx = 25/3");
    expect(j.firstWrongStep).toBe(2);
    expect(j.steps[1]!.category).toBe("arithmetic");
    // Later lines consistent with the earlier mistake are still wrong in absolute terms.
    expect(j.steps[2]!.ok).toBe(false);
  });

  it("skips unparseable lines without judging them", () => {
    const j = judgeWorking(eq, "first I move the 5\n3x = 15\nx = 5");
    expect(j.steps[0]!.ok).toBeNull();
    expect(j.firstWrongStep).toBeNull();
    expect(j.solved).toBe(true);
  });

  it("declines to judge when the problem has no computable solution", () => {
    const j = judgeWorking({ kind: "generic", question: "why is the sky blue?" }, "x = 5");
    expect(j.judged).toBe(false);
  });

  it("never emits corrected values — verdicts are indices and categories only", () => {
    const j = judgeWorking(eq, "3x = 25");
    const json = JSON.stringify(j.steps.map(({ line, ...rest }) => rest));
    expect(json).not.toContain("15"); // the corrected intermediate never appears
    expect(json).not.toMatch(/"5"/); // nor the final answer as a value
  });
});
