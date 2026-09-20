import { describe, it, expect } from "vitest";
import { validateDecision } from "../validate";

const base = { say: null, text: null, url: null, direction: null, amount: null, value: null, pendingAction: null, taskType: null, reason: "t", done: true };

describe("decision anchor validation", () => {
  it("accepts point_to with a quote and no elementId", () => {
    const v = validateDecision({ ...base, action: "point_to", elementId: null, quote: "do to the other side" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.decision.quote).toBe("do to the other side");
  });

  it("still rejects click without an elementId (quotes only aim pointing actions)", () => {
    const v = validateDecision({ ...base, action: "click", elementId: null, quote: "Sign in" });
    expect(v.ok).toBe(false);
  });

  it("requires an elementId for line anchoring and rejects line < 1", () => {
    expect(validateDecision({ ...base, action: "point_to", elementId: null, line: 2 }).ok).toBe(false);
    expect(validateDecision({ ...base, action: "point_to", elementId: 4, line: 0 }).ok).toBe(false);
    const v = validateDecision({ ...base, action: "point_to", elementId: 4, line: 2 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.decision.line).toBe(2);
  });

  it("quashes anchors on non-pointing actions instead of rejecting", () => {
    const v = validateDecision({ ...base, action: "speak", say: "hi", elementId: null, quote: "stray", line: 3 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.decision.quote).toBeNull();
      expect(v.decision.line).toBeNull();
    }
  });

  it("trims and caps quotes, and an empty quote does not satisfy the element requirement", () => {
    const v = validateDecision({ ...base, action: "highlight", elementId: null, quote: "   " });
    expect(v.ok).toBe(false);
  });
});
