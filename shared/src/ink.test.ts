import { describe, expect, it } from "vitest";
import { judgeInkMock, noteReusesNumbers, parseInkBox, validateInkJudgement, type InkJudgeInput, type InkReason } from "./ink";

const input = (seq: number, reason: InkReason = "ink", rung = 1): InkJudgeInput => ({ frame: "data:image/jpeg;base64,AAAA", context: null, contextTitle: "", contextUrl: "", previousLines: [], seq, reason, rung, lastWrongLine: null });

describe("parseInkBox", () => {
  it("reads the model's [ymin, xmin, ymax, xmax] on 0..1000 into fractions", () => {
    expect(parseInkBox([398, 248, 425, 312])).toEqual({ x: 0.248, y: 0.398, w: 0.064, h: 0.027 });
  });
  it("accepts fractions and the {x, y, w, h} form, and clamps to the frame", () => {
    expect(parseInkBox([0.1, 0.2, 0.3, 0.4])).toEqual({ x: 0.2, y: 0.1, w: 0.2, h: 0.2 });
    expect(parseInkBox({ x: 0.9, y: 0.5, w: 0.5, h: 0.1 })).toEqual({ x: 0.9, y: 0.5, w: 0.1, h: 0.1 });
  });
  it("is null for anything empty, degenerate or malformed", () => {
    expect(parseInkBox(null)).toBeNull();
    expect(parseInkBox([1, 2, 3])).toBeNull();
    expect(parseInkBox([400, 300, 400, 500])).toBeNull();
    expect(parseInkBox(["a", 1, 2, 3])).toBeNull();
    expect(parseInkBox({ x: 0.1, y: 0.1, w: 0, h: 0.2 })).toBeNull();
  });
});

describe("validateInkJudgement", () => {
  it("accepts a well formed off verdict and keeps its fields", () => {
    const v = validateInkJudgement({ lines: [" 3x + 5 = 20 ", "3x = 25"], status: "off", line: 2, issue: "wrong sign", nudge: "Look at the 5.", confidence: 0.8, solved: false });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement.lines).toEqual(["3x + 5 = 20", "3x = 25"]);
    expect(v.judgement.line).toBe(2);
    expect(v.judgement.nudge).toBe("Look at the 5.");
    expect(v.judgement.solved).toBe(false);
    expect(v.judgement.note).toEqual([]);
  });

  it("keeps the wrong line's box and mark on an off verdict, the mark falling back to the box", () => {
    const v = validateInkJudgement({ status: "off", line: 2, nudge: "Look.", box: [398, 248, 425, 312], mark: [398, 287, 424, 312], space: [465, 224, 917, 800] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement.box).toEqual({ x: 0.248, y: 0.398, w: 0.064, h: 0.027 });
    expect(v.judgement.mark?.x).toBeCloseTo(0.287);
    expect(v.judgement.space?.w).toBeCloseTo(0.576);
    const noMark = validateInkJudgement({ status: "off", line: 2, nudge: "Look.", box: [398, 248, 425, 312] });
    expect(noMark.ok && noMark.judgement.mark).toEqual({ x: 0.248, y: 0.398, w: 0.064, h: 0.027 });
  });

  it("drops the issue, nudge, line and boxes when the work is fine, but keeps the empty space", () => {
    const v = validateInkJudgement({ lines: ["x = 5"], status: "ok", line: 1, issue: "leftover", nudge: "leftover", confidence: 2, solved: true, box: [1, 1, 500, 500], mark: [1, 1, 500, 500], space: [0, 500, 1000, 1000] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement).toMatchObject({ line: null, issue: "", nudge: "", confidence: 1, solved: true, box: null, mark: null });
    expect(v.judgement.space).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("keeps a stall's note and its spoken line even when the work is fine so far", () => {
    const v = validateInkJudgement({ lines: ["3x + 5 = 20"], status: "ok", nudge: "Here is a similar one.", note: ["A similar one:", "y + 2 = 9", "", "take 2 from both sides"] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.judgement.note).toEqual(["A similar one:", "y + 2 = 9", "take 2 from both sides"]);
    expect(v.judgement.nudge).toBe("Here is a similar one.");
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

  it("survives its own output (a judgement re-validated is unchanged)", () => {
    const first = validateInkJudgement({ status: "off", line: 2, nudge: "Look.", box: [398, 248, 425, 312], mark: [398, 287, 424, 312], note: ["y + 2 = 9"], space: [465, 224, 917, 800] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = validateInkJudgement(JSON.parse(JSON.stringify(first.judgement)));
    expect(again.ok && again.judgement).toEqual(first.judgement);
  });
});

describe("noteReusesNumbers", () => {
  const lines = ["3x + 5 = 20", "3x = 25"];
  it("passes an analogous example in other numbers, questions and diagrams", () => {
    expect(noteReusesNumbers(lines, ["A similar one:", "y + 2 = 9", "take 2 from both sides", "y = 7"])).toEqual([]);
    expect(noteReusesNumbers(lines, ["What undoes adding?", "line 20 50 80 50", "label 20 30 y + 2 = 9"])).toEqual([]);
    expect(noteReusesNumbers([], ["5 + 5"])).toEqual([]);
  });
  it("catches the kid's own numbers in text lines and label words, ignoring shape coordinates", () => {
    expect(noteReusesNumbers(lines, ["To undo + 5:", "subtract 5 from", "both sides"])).toEqual(["5"]);
    expect(noteReusesNumbers(lines, ["label 20 30 3x = 15"])).toEqual(["3"]);
    expect(noteReusesNumbers(lines, ["circle 25 20 5"])).toEqual([]);
    expect(noteReusesNumbers(["x = 5.0"], ["try 5"])).toEqual(["5"]);
  });
});

describe("judgeInkMock", () => {
  it("cycles fine, slip on line two, then solved", () => {
    expect(judgeInkMock(input(0)).status).toBe("ok");
    const slip = judgeInkMock(input(1));
    expect(slip.status).toBe("off");
    expect(slip.line).toBe(2);
    expect(slip.nudge).not.toMatch(/15|x = 5/);
    expect(slip.box).not.toBeNull();
    expect(slip.mark).not.toBeNull();
    expect(judgeInkMock(input(2)).solved).toBe(true);
    expect(judgeInkMock(input(3)).status).toBe("ok");
  });

  it("gives away a little more with each rung, never the fix", () => {
    const one = judgeInkMock(input(1, "ink", 1)).nudge;
    const two = judgeInkMock(input(1, "ink", 2)).nudge;
    const three = judgeInkMock(input(1, "ink", 3)).nudge;
    expect(new Set([one, two, three]).size).toBe(3);
    expect(one).toMatch(/\?$/);
    for (const n of [one, two, three]) expect(n).not.toMatch(/15|x = 5/);
    expect(judgeInkMock(input(1, "ink", 9)).nudge).toBe(three);
  });

  it("answers a stall with a chalk note in other numbers and a line to say", () => {
    const j = judgeInkMock(input(4, "stall", 2));
    expect(j.note.length).toBeGreaterThan(1);
    expect(j.note.join(" ")).not.toMatch(/3x = 15|x = 5/);
    expect(j.nudge).toBeTruthy();
    expect(j.space).not.toBeNull();
  });
});
