import { describe, expect, it } from "vitest";
import { besidePoint, chooseTravel, planHops, planWander, releaseVelocity, stepFlight, stepHop, wanderAllowed, wanderTimerRuns, FLIGHT } from "../travel";

describe("chooseTravel", () => {
  it("hops for short trips on the same row and uses the hole otherwise", () => {
    expect(chooseTravel(100, 0)).toBe("hop");
    expect(chooseTravel(-420, 24)).toBe("hop");
    expect(chooseTravel(421, 0)).toBe("hole");
    expect(chooseTravel(10, 25)).toBe("hole");
    expect(chooseTravel(10, -300)).toBe("hole");
  });
});

describe("planHops and stepHop", () => {
  it("uses whole hops, at least one, and clamps the last one", () => {
    expect(planHops(100, 100, 42)).toEqual({ direction: 1, hops: 1, distance: 0 });
    expect(planHops(100, 184, 42)).toEqual({ direction: 1, hops: 2, distance: 84 });
    expect(planHops(100, 185, 42)).toEqual({ direction: 1, hops: 3, distance: 85 });
    expect(planHops(300, 100, 42)).toEqual({ direction: -1, hops: 5, distance: -200 });
    let left = 300;
    for (const moved of [-12, -18, -12, -12, -18, -12, -12, -18, -12, -12, -18, -12, -12, -18, -12]) left = stepHop(left, moved, 100, -1);
    expect(left).toBe(100);
  });
});

describe("wander gate", () => {
  const base = { quiet: true, reducedMotion: false, inSequence: false, busy: false, onScreen: true, timer: 0, sinceLastMs: 200_000, minGapS: 75 };
  it("runs the timer only when quiet, unreduced, free and on screen", () => {
    expect(wanderTimerRuns(base)).toBe(true);
    expect(wanderTimerRuns({ ...base, quiet: false })).toBe(false);
    expect(wanderTimerRuns({ ...base, reducedMotion: true })).toBe(false);
    expect(wanderTimerRuns({ ...base, inSequence: true })).toBe(false);
    expect(wanderTimerRuns({ ...base, busy: true })).toBe(false);
    expect(wanderTimerRuns({ ...base, onScreen: false })).toBe(false);
  });
  it("never allows more than one wander per minimum gap", () => {
    expect(wanderAllowed(base)).toBe(true);
    expect(wanderAllowed({ ...base, timer: 1 })).toBe(false);
    expect(wanderAllowed({ ...base, sinceLastMs: 74_999 })).toBe(false);
    expect(wanderAllowed({ ...base, sinceLastMs: 75_000 })).toBe(true);
  });
  it("plans hops in range on a side with room and keeps the margin", () => {
    // Left edge: only the right side has room.
    const r = planWander(40, 93, 1280, 42, [2, 3], () => 0);
    expect(r).toEqual({ direction: 1, hops: 2, targetLeft: 124 });
    // Right edge, want 3 hops: only the left side fits.
    const l = planWander(1147, 93, 1280, 42, [2, 3], () => 0.99);
    expect(l).toEqual({ direction: -1, hops: 3, targetLeft: 1021 });
    // A narrow row: fewer hops than wanted, never less than fits.
    const short = planWander(80, 93, 260, 42, [2, 3], () => 0.99);
    expect(short).toEqual({ direction: 1, hops: 1, targetLeft: 122 });
    // No room at all.
    expect(planWander(50, 93, 200, 42, [2, 3], () => 0)).toBeNull();
  });
});

describe("besidePoint", () => {
  it("stands left of the rect with a gap, or right when the left does not fit, feet on its bottom", () => {
    expect(besidePoint({ x: 400, y: 100, width: 120, height: 30 }, 93, 159, 1280)).toEqual({ x: 400 - 16 - 46.5, y: 130 - 79.5 });
    expect(besidePoint({ x: 20, y: 100, width: 120, height: 30 }, 93, 159, 1280)).toEqual({ x: 140 + 16 + 46.5, y: 130 - 79.5 });
  });
});

describe("flight", () => {
  const bounds = { minX: 0, maxX: 1187, minY: -6, floorY: 608 };
  it("falls under gravity, bounces off walls and settles on the floor", () => {
    let s = { x: 600, y: 300, vx: -3000, vy: -200, t: 0 };
    let landed = false;
    let bouncedWall = false;
    let frames = 0;
    while (!landed && frames < 600) {
      const r = stepFlight(s, 1 / 60, bounds);
      if (r.state.x === bounds.minX && r.state.vx > 0) bouncedWall = true;
      s = r.state;
      landed = r.landed;
      frames++;
    }
    expect(bouncedWall).toBe(true);
    expect(landed).toBe(true);
    expect(s.y).toBe(bounds.floorY);
    expect(s.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(s.x).toBeLessThanOrEqual(bounds.maxX);
    expect(s.t).toBeLessThanOrEqual(FLIGHT.maxSeconds + 1 / 60);
  });
  it("clamps at the ceiling and caps the flight at three seconds", () => {
    const up = stepFlight({ x: 100, y: -5, vx: 0, vy: -5000, t: 0 }, 1 / 60, bounds);
    expect(up.state.y).toBe(bounds.minY);
    expect(up.state.vy).toBe(0);
    const capped = stepFlight({ x: 100, y: 300, vx: 0, vy: -100, t: 2.99 }, 0.02, bounds);
    expect(capped.landed).toBe(true);
    expect(capped.state.y).toBe(bounds.floorY);
  });
  it("reads the release velocity from the last 120 ms of samples", () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 500, x: 900, y: 0 },
      { t: 900, x: 900, y: 0 },
      { t: 950, x: 880, y: 5 },
      { t: 1000, x: 840, y: 15 },
    ];
    const v = releaseVelocity(samples, 1000);
    expect(v.vx).toBeCloseTo(-600);
    expect(v.vy).toBeCloseTo(150);
    expect(v.speed).toBeGreaterThan(FLIGHT.throwSpeed);
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }], 1000).speed).toBe(0);
  });
});
