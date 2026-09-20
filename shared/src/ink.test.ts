import { describe, expect, it } from "vitest";
import { judgeInkMock, validateInkJudgement, type InkJudgeInput } from "./ink";

const input = (seq: number): InkJudgeInput => ({ frame: "data:image/jpeg;base64,AAAA", context: null, contextTitle: "", contextUrl: "", previousLines: [], seq });

describe("validateInkJudgement", () => {
  it("accepts a well formed off verdict and keeps its fields", () => {
    const v = validateInkJudgement({ lines: [" 3x + 5 = 20 ", "3x = 25"], status: "off", line: 2, issue: "wrong sign", nudge: "Look at the 5.", confidence: 0.8, solved: false });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement.lines).toEqual(["3x + 5 = 20", "3x = 25"]);
    expect(v.judgement.line).toBe(2);
    expect(v.judgement.nudge).toBe("Look at the 5.");
    expect(v.judgement.solved).toBe(false);
  });

  it("drops the issue, nudge and line when the work is fine", () => {
    const v = validateInkJudgement({ lines: ["x = 5"], status: "ok", line: 1, issue: "leftover", nudge: "leftover", confidence: 2, solved: true });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement).toMatchObject({ line: null, issue: "", nudge: "", confidence: 1, solved: true });
  });

  it("rejects an unknown status and an off verdict without a nudge", () => {
    expect(validateInkJudgement({ status: "maybe" }).ok).toBe(false);
    expect(validateInkJudgement({ status: "off", line: 1 }).ok).toBe(false);
    expect(validateInkJudgement("nope").ok).toBe(false);
  });

  it("never marks unclear or off work as solved", () => {
    const v = validateInkJudgement({ status: "unclear", solved: true });
    expect(v.ok && v.judgement.solved).toBe(false);
  });
});

describe("judgeInkMock", () => {
  it("cycles fine, slip on line two, then solved", () => {
    expect(judgeInkMock(input(0)).status).toBe("ok");
    const slip = judgeInkMock(input(1));
    expect(slip.status).toBe("off");
    expect(slip.line).toBe(2);
    expect(slip.nudge).not.toMatch(/15|x = 5/);
    expect(judgeInkMock(input(2)).solved).toBe(true);
    expect(judgeInkMock(input(3)).status).toBe("ok");
  });
});
