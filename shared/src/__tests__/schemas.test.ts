import { describe, expect, it } from "vitest";
import { validateDecision, validateIntervention } from "../validate";

describe("validateDecision", () => {
  it("accepts a minimal valid click and fills defaults", () => {
    const r = validateDecision({ action: "click", elementId: 3, reason: "open it" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision.say).toBeNull();
      expect(r.decision.done).toBe(false);
      expect(r.decision.elementId).toBe(3);
    }
  });
  it("rejects element actions without an element id", () => {
    for (const action of ["click", "double_click", "right_click", "hover", "point_to", "highlight", "focus", "select", "scroll_to", "clear"]) {
      const r = validateDecision({ action, reason: "x", text: "hello", value: "v" });
      expect(r.ok, action).toBe(false);
    }
  });
  it("lets pointer actions aim at a viewport point instead of an element", () => {
    for (const action of ["click", "double_click", "right_click", "hover"]) {
      const r = validateDecision({ action, x: 640, y: 310.5, reason: "canvas" });
      expect(r.ok, action).toBe(true);
    }
    expect(validateDecision({ action: "click", x: 640, reason: "half a point" }).ok).toBe(false);
    expect(validateDecision({ action: "click", x: -5, y: 10, reason: "off page" }).ok).toBe(false);
    expect(validateDecision({ action: "click", x: 1e9, y: 10, reason: "off page" }).ok).toBe(false);
    // A -1 "no element" sentinel next to a real point is the point's click, not an error.
    const r = validateDecision({ action: "click", elementId: -1, x: 5, y: 5, reason: "x" });
    expect(r.ok && r.decision.elementId).toBeNull();
  });
  it("requires both ends of a drag", () => {
    expect(validateDecision({ action: "drag", elementId: 2, reason: "x" }).ok).toBe(false);
    expect(validateDecision({ action: "drag", toX: 9, toY: 9, reason: "x" }).ok).toBe(false);
    expect(validateDecision({ action: "drag", elementId: 2, toElementId: 7, reason: "x" }).ok).toBe(true);
    expect(validateDecision({ action: "drag", x: 100, y: 100, toX: 400, toY: 120, reason: "slider" }).ok).toBe(true);
    expect(validateDecision({ action: "drag", x: 100, y: 100, toX: 400, reason: "x" }).ok).toBe(false);
  });
  it("accepts real key chords for press_key and rejects invented keys", () => {
    for (const text of ["Escape", "ArrowDown", "Control+a", "Shift+Tab", "cmd+z", "F5", "+"]) expect(validateDecision({ action: "press_key", text, reason: "x" }).ok, text).toBe(true);
    for (const text of ["", "Hyper+x", "SuperJump", "Control+"]) expect(validateDecision({ action: "press_key", text, reason: "x" }).ok, text).toBe(false);
    expect(validateDecision({ action: "press_key", reason: "x" }).ok).toBe(false);
  });
  it("types at the focus when no element is named, but still needs text", () => {
    expect(validateDecision({ action: "type", text: "y = 2x + 1", reason: "graphing canvas" }).ok).toBe(true);
    expect(validateDecision({ action: "type", reason: "x" }).ok).toBe(false);
  });
  it("rejects unknown actions and garbage", () => {
    expect(validateDecision({ action: "eval", reason: "x" }).ok).toBe(false);
    expect(validateDecision("click").ok).toBe(false);
    expect(validateDecision(null).ok).toBe(false);
    expect(validateDecision([]).ok).toBe(false);
  });
  it("requires text for type and absolute http urls for navigate", () => {
    expect(validateDecision({ action: "type", elementId: 1, reason: "x" }).ok).toBe(false);
    expect(validateDecision({ action: "navigate", url: "javascript:alert(1)", reason: "x" }).ok).toBe(false);
    expect(validateDecision({ action: "navigate", url: "https://example.com", reason: "x" }).ok).toBe(true);
  });
  it("validates nested pending actions for confirmations", () => {
    const bad = validateDecision({ action: "ask_confirmation", say: "Sure?", pendingAction: { action: "click", elementId: null, text: null, url: null, value: null }, reason: "x" });
    expect(bad.ok).toBe(false);
    const good = validateDecision({ action: "ask_confirmation", say: "Submit it?", pendingAction: { action: "click", elementId: 9, text: null, url: null, value: null }, reason: "x" });
    expect(good.ok).toBe(true);
  });
  it("clamps wait and scroll amounts", () => {
    const w = validateDecision({ action: "wait", amount: 99999, reason: "x" });
    expect(w.ok && w.decision.amount).toBe(5000);
    const s = validateDecision({ action: "scroll", direction: "down", amount: -20, reason: "x" });
    expect(s.ok && s.decision.amount).toBe(80);
  });
});

describe("validateIntervention", () => {
  it("requires a message when intervening", () => {
    expect(validateIntervention({ intervene: true, confidence: 0.9, type: "hint", message: null, elementId: null, reason: "x" }).ok).toBe(false);
    expect(validateIntervention({ intervene: true, confidence: 0.9, type: "hint", message: "Want a hint?", elementId: 2, reason: "x" }).ok).toBe(true);
  });
  it("rejects confidence out of range", () => {
    expect(validateIntervention({ intervene: false, confidence: 2, type: "none", message: null, elementId: null, reason: "x" }).ok).toBe(false);
  });
});

describe("observe region targets", () => {
  it("keeps quote on observe (region read) but quashes it on plain actions", () => {
    const observe = validateDecision({ action: "observe", quote: "the description", reason: "r" });
    expect(observe.ok && observe.decision.quote).toBe("the description");
    const click = validateDecision({ action: "click", elementId: 1, quote: "stray", reason: "r" });
    expect(click.ok && click.decision.quote).toBeNull();
  });

  it("quashes a stray line on observe instead of rejecting the decision", () => {
    const v = validateDecision({ action: "observe", quote: "the description", line: 2, reason: "r" });
    expect(v.ok && v.decision.line).toBeNull();
    expect(v.ok && v.decision.quote).toBe("the description");
  });
});

describe("sketch modes", () => {
  it("keeps quote (anchor) and normalizes value to add-or-null on sketch", () => {
    const add = validateDecision({ action: "sketch", text: "rect 20 72 8 8", value: "add", quote: "3x + 5 = 20", line: 2, reason: "r" });
    expect(add.ok && add.decision.value).toBe("add");
    expect(add.ok && add.decision.quote).toBe("3x + 5 = 20");
    expect(add.ok && add.decision.line).toBeNull();
    const fresh = validateDecision({ action: "sketch", text: "dot 5 5", value: "replace", reason: "r" });
    expect(fresh.ok && fresh.decision.value).toBeNull();
  });
});
