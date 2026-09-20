import { describe, expect, it } from "vitest";
import { ringPath } from "../InkCoach";

const points = (d: string): Array<[number, number]> =>
  d
    .split(/(?=[ML])/)
    .map((seg) => seg.trim().slice(1).trim().split(/\s+/).map(Number))
    .filter((n) => n.length === 2 && n.every(Number.isFinite))
    .map(([x, y]) => [x, y]);

describe("ringPath", () => {
  it("is one continuous stroke that starts with a move and runs past a full turn", () => {
    const d = ringPath(80, 40, 7);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.match(/L /g)?.length).toBe(56);
    const pts = points(d);
    const [x0, y0] = pts[0];
    const [xn, yn] = pts[pts.length - 1];
    // The end passes the start (a 1.12 turn), so it lands a little further round, not on top of it.
    expect(Math.hypot(xn - x0, yn - y0)).toBeGreaterThan(4);
    expect(Math.hypot(xn - x0, yn - y0)).toBeLessThan(40);
  });

  it("hugs the box: every point stays within a few pixels of it and goes round all four sides", () => {
    const w = 60;
    const h = 36;
    const pts = points(ringPath(w, h, 3));
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThan(-6);
      expect(x).toBeLessThan(w + 6);
      expect(y).toBeGreaterThan(-6);
      expect(y).toBeLessThan(h + 6);
    }
    expect(Math.min(...pts.map((p) => p[0]))).toBeLessThan(8);
    expect(Math.max(...pts.map((p) => p[0]))).toBeGreaterThan(w - 8);
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThan(8);
    expect(Math.max(...pts.map((p) => p[1]))).toBeGreaterThan(h - 8);
  });

  it("wobbles differently for different seeds and never collapses on a tiny box", () => {
    expect(ringPath(50, 30, 1)).not.toBe(ringPath(50, 30, 2));
    const tiny = points(ringPath(4, 4, 5));
    const xs = tiny.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
  });
});
