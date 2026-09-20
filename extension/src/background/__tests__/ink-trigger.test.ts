import { describe, expect, it } from "vitest";
import { changedPixels, InkTrigger, toGray, type TriggerRules } from "../ink-trigger";

const RULES: TriggerRules = { noise: 0.001, ink: 0.01, pauseInk: 0.003, pauseMs: 1000, minGapMs: 2000 };
const PIXELS = 10_000; // so 1% ink = 100 changed pixels

describe("changedPixels / toGray", () => {
  it("counts only pixels that moved past the threshold", () => {
    const a = new Uint8Array([0, 100, 200, 50]);
    const b = new Uint8Array([10, 130, 200, 100]);
    expect(changedPixels(a, b, 24)).toBe(2);
  });
  it("turns RGBA into one luma byte per pixel", () => {
    const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
    expect(Array.from(g)).toEqual([255, 0]);
  });
});

describe("InkTrigger", () => {
  it("ignores noise and never fires on it", () => {
    const t = new InkTrigger(PIXELS, RULES);
    for (let i = 0; i < 20; i++) expect(t.push(5, 500 * i)).toBeNull();
    expect(t.pending).toBe(0);
  });

  it("fires 'ink' once enough new ink accumulates while writing", () => {
    const t = new InkTrigger(PIXELS, RULES);
    expect(t.push(40, 3000)).toBeNull(); // 0.4%
    expect(t.push(40, 3500)).toBeNull(); // 0.8%
    expect(t.push(40, 4000)).toBe("ink"); // 1.2%
  });

  it("fires 'pause' after the pen rests with a little unjudged ink", () => {
    const t = new InkTrigger(PIXELS, RULES);
    expect(t.push(40, 3000)).toBeNull();
    expect(t.push(0, 3500)).toBeNull();
    expect(t.push(0, 3900)).toBeNull(); // 900 ms still: not yet
    expect(t.push(0, 4100)).toBe("pause");
  });

  it("holds while a check is in flight and inside the minimum gap", () => {
    const t = new InkTrigger(PIXELS, RULES);
    t.push(200, 3000);
    t.checkStarted(3000);
    expect(t.pending).toBe(0);
    expect(t.push(200, 3500)).toBeNull(); // in flight
    t.checkFinished();
    expect(t.push(200, 4000)).toBeNull(); // still inside the 2 s gap
    expect(t.push(0, 5100)).toBe("ink"); // gap over, plenty of ink waiting
  });
});
