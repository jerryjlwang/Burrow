import { describe, expect, it } from "vitest";
import { SignalTracker, computeLevel, THRESHOLDS } from "../signals";
import type { PageSummary } from "@shared/types";

const page = (errors: string[] = [], successes: string[] = [], extra: Partial<PageSummary> = {}): PageSummary => ({
  url: "http://x/algebra.html",
  title: "Practice",
  headings: ["Question 1"],
  textSummary: "Solve for x: 3x + 5 = 20",
  elements: [],
  errors,
  successes,
  dialogs: [],
  forms: 0,
  landmarks: [],
  isPdf: false,
  hasQuizUi: true,
  scroll: { x: 0, y: 0, maxY: 0 },
  viewport: { width: 1, height: 1 },
  capturedAt: Date.now(),
  truncatedElements: 0,
  ...extra,
});

const ctx = (now: number, over: Partial<Parameters<typeof computeLevel>[1]> = {}) => ({ proactiveEnabled: true, cooldownUntil: 0, declinedCount: 0, lastDeclineAt: 0, now, ...over });

describe("SignalTracker", () => {
  it("counts incorrect attempts after user actions and escalates", () => {
    const t = new SignalTracker();
    let now = 1000;
    t.recordPage(page(), now);
    t.recordClick({ at: now, key: "check", name: "Check answer", disabled: false });
    t.recordPage(page(["Not quite — try again."]), now + 300);
    expect(t.snapshot(now + 300).incorrectAttempts).toBe(1);
    expect(computeLevel(t.snapshot(now + 300), ctx(now + 300))).toBe(1);
    // error disappears, then reappears after another attempt
    now += 2000;
    t.recordPage(page([]), now);
    t.recordClick({ at: now, key: "check", name: "Check answer", disabled: false });
    t.recordPage(page(["Not quite — try again."]), now + 300);
    const s = t.snapshot(now + 300);
    expect(s.incorrectAttempts).toBe(2);
    expect(computeLevel(s, ctx(now + 300))).toBeGreaterThanOrEqual(3);
  });
  it("counts repeated attempts even when the page keeps showing the same error text", () => {
    const t = new SignalTracker();
    let now = 0;
    t.recordPage(page(), now);
    for (let i = 0; i < 3; i++) {
      now += 3000;
      t.recordClick({ at: now, key: "check", name: "Check answer", disabled: false });
      t.recordPage(page(["Not quite — try again."]), now + 300);
      t.recordPage(page(["Not quite — try again."]), now + 1200); // a second observation of the same state must not double count
    }
    expect(t.snapshot(now + 1200).incorrectAttempts).toBe(3);
  });
  it("resets when the problem changes and clears on success", () => {
    const t = new SignalTracker();
    t.recordPage(page(), 0);
    t.recordClick({ at: 0, key: "check", name: "Check answer", disabled: false });
    t.recordPage(page(["Not quite — try again."]), 100);
    t.recordPage(page([], ["Correct! x = 5"]), 200);
    expect(t.snapshot(200).incorrectAttempts).toBe(0);
    t.recordPage(page([], [], { textSummary: "2x - 4 = 10" }), 300);
    expect(t.currentProblemKey).toMatch(/2x/);
  });
  it("detects repeated unproductive clicks on a disabled control", () => {
    const t = new SignalTracker();
    t.recordPage(page(), 0);
    for (let i = 0; i < 3; i++) {
      const rec = t.recordClick({ at: 1000 * i, key: "continue", name: "Continue", disabled: true });
      t.resolveClick(rec, false);
    }
    const s = t.snapshot(3000);
    expect(s.repeatedClicks).toBe(3);
    expect(s.failedUiAction).toBe(true);
    expect(computeLevel(s, ctx(3000))).toBe(4);
  });
  it("detects navigation oscillation and dead ends", () => {
    const t = new SignalTracker();
    ["a", "b", "a", "b"].forEach((u, i) => t.recordUrl(`http://x/${u}`, i * 1000));
    expect(t.snapshot(5000).navigationOscillation).toBe(true);
    const t2 = new SignalTracker();
    t2.recordPage(page([], [], { title: "403 Access denied", textSummary: "You don't have permission to view grades." }), 0);
    expect(t2.snapshot(0).deadEnd).toBe(true);
  });
  it("respects cooldowns and declines", () => {
    const s = { repeatedClicks: 0, validationErrors: 0, incorrectAttempts: 2, timeOnCurrentProblemMs: 0, navigationOscillation: false, rapidClicks: 0, deadEnd: false, failedUiAction: false, summary: [], strength: 0.75 };
    expect(computeLevel(s, ctx(1000))).toBe(3);
    expect(computeLevel(s, ctx(1000, { cooldownUntil: 5000 }))).toBeLessThanOrEqual(1);
    expect(computeLevel(s, ctx(1000, { declinedCount: 2, lastDeclineAt: 900 }))).toBe(1);
    expect(computeLevel(s, ctx(1000, { proactiveEnabled: false }))).toBe(0);
    expect(computeLevel(s, ctx(THRESHOLDS.declineCooldownMs + 2000, { declinedCount: 2, lastDeclineAt: 900 }))).toBe(3);
  });
});
