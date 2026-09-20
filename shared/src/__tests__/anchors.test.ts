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

describe("switch_tab / look_up / press_enter validation", () => {
  it("switch_tab requires a tabId; look_up requires a query; press_enter needs its element", () => {
    expect(validateDecision({ ...base, action: "switch_tab", elementId: null, tabId: 41 }).ok).toBe(true);
    expect(validateDecision({ ...base, action: "switch_tab", elementId: null }).ok).toBe(false);
    expect(validateDecision({ ...base, action: "look_up", elementId: null, text: "two step equations video" }).ok).toBe(true);
    expect(validateDecision({ ...base, action: "look_up", elementId: null, text: "  " }).ok).toBe(false);
    expect(validateDecision({ ...base, action: "press_enter", elementId: 4 }).ok).toBe(true);
    expect(validateDecision({ ...base, action: "press_enter", elementId: null }).ok).toBe(false);
  });
});

describe("open_tab validation", () => {
  it("requires an absolute http(s) url, like navigate", () => {
    expect(validateDecision({ ...base, action: "open_tab", elementId: null, url: "https://www.khanacademy.org/" }).ok).toBe(true);
    expect(validateDecision({ ...base, action: "open_tab", elementId: null, url: "khanacademy.org" }).ok).toBe(false);
    expect(validateDecision({ ...base, action: "open_tab", elementId: null, url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateDecision({ ...base, action: "open_tab", elementId: null }).ok).toBe(false);
  });
});
