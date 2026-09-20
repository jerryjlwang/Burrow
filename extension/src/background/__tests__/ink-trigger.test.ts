import { describe, expect, it } from "vitest";
import { changedPixels, InkTrigger, maskedChangedPixels, toGray, type TriggerRules } from "../ink-trigger";

const RULES: TriggerRules = { noise: 0.001, ink: 0.01, pauseInk: 0.003, pauseMs: 1000, minGapMs: 2000, stallMs: 10_000 };
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

describe("maskedChangedPixels", () => {
  const W = 20;
  const H = 10;
  const frame = (paint: Array<[number, number]>) => {
    const f = new Uint8Array(W * H);
    for (const [x, y] of paint) f[y * W + x] = 255;
    return f;
  };
  it("counts changes outside the masked regions only, with a little padding around each", () => {
    const prev = new Uint8Array(W * H);
    // A rabbit-sized blob in the lower right, a stroke of ink at the top left, and a pixel just outside the blob.
    const next = frame([[15, 6], [16, 6], [15, 7], [16, 7], [1, 1], [2, 1], [3, 1], [11, 6]]);
    const rabbit = { x: 0.7, y: 0.5, w: 0.2, h: 0.3 }; // x 14..18, y 5..8, padded by 2 → x 12..20, y 3..10
    expect(changedPixels(prev, next)).toBe(8);
    expect(maskedChangedPixels(prev, next, W, H, [rabbit])).toBe(4); // the stroke and the pixel at x 11
    expect(maskedChangedPixels(prev, next, W, H, [rabbit], 24, 0)).toBe(4);
    expect(maskedChangedPixels(prev, next, W, H, [rabbit, { x: 0, y: 0, w: 0.25, h: 0.2 }])).toBe(1);
  });
  it("is the plain count with no mask, and never counts a pixel twice under overlapping masks", () => {
    const prev = new Uint8Array(W * H);
    const next = frame([[5, 5], [6, 5]]);
    expect(maskedChangedPixels(prev, next, W, H, [])).toBe(2);
    expect(maskedChangedPixels(prev, next, W, H, [{ x: 0.2, y: 0.4, w: 0.2, h: 0.2 }, { x: 0.2, y: 0.4, w: 0.2, h: 0.2 }])).toBe(0);
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

  it("fires 'stall' once when the pen rests long enough after a check, and not on an untouched board", () => {
    const t = new InkTrigger(PIXELS, RULES);
    for (let i = 0; i < 40; i++) expect(t.push(0, 500 * i)).toBeNull(); // nothing ever written: never a stall
    t.push(200, 20_000);
    t.checkStarted(20_000);
    t.checkFinished();
    expect(t.push(0, 29_000)).toBeNull(); // 9 s of rest: not yet
    expect(t.push(0, 30_100)).toBe("stall");
    t.checkStarted(30_100);
    t.checkFinished();
    expect(t.push(0, 41_000)).toBeNull(); // still resting: the same stall does not fire again
    expect(t.push(0, 90_000)).toBeNull();
  });

  it("re-arms the stall once new ink lands, and measures from the later of ink and check", () => {
    const t = new InkTrigger(PIXELS, RULES);
    t.push(200, 1000);
    t.checkStarted(1000);
    t.checkFinished();
    expect(t.push(0, 11_100)).toBe("stall");
    t.checkStarted(11_100);
    t.checkFinished();
    t.push(20, 15_000); // a small mark, below the pause threshold, still counts as ink
    expect(t.push(0, 22_000)).toBeNull(); // 7 s since the ink
    expect(t.push(0, 25_100)).toBe("stall"); // 10 s since the ink, later than the check
  });

  it("lets the watcher shorten the rest or turn stalls off", () => {
    const t = new InkTrigger(PIXELS, RULES);
    t.push(200, 1000);
    t.checkStarted(1000);
    t.checkFinished();
    t.stallMs = 4000;
    expect(t.push(0, 5100)).toBe("stall");
    const off = new InkTrigger(PIXELS, RULES);
    off.push(200, 1000);
    off.checkStarted(1000);
    off.checkFinished();
    off.stallMs = Infinity;
    expect(off.push(0, 100_000)).toBeNull();
  });
});
