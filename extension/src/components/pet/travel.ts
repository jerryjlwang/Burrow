/**
 * Pure movement decisions for the pet: hop or hole, hop planning, wander gating and planning,
 * where to stand beside a pointed-at element, and one step of throw physics.
 * No DOM here so every rule can be unit tested.
 */

export type TravelKind = "hop" | "hole";

/** Short trips along the same row are hops; anything else goes through the hole. */
export function chooseTravel(dx: number, dy: number, maxDy = 24, maxDx = 420): TravelKind {
  return Math.abs(dy) <= maxDy && Math.abs(dx) <= maxDx ? "hop" : "hole";
}

export interface HopPlan {
  direction: -1 | 1;
  /** Whole hops, at least one. */
  hops: number;
  /** Signed distance in px to the landing spot. */
  distance: number;
}

/** Whole hops of `hopLength` px from `from` to `to`; the last hop is clamped so he lands exactly on `to`. */
export function planHops(from: number, to: number, hopLength: number): HopPlan {
  const distance = to - from;
  const direction: -1 | 1 = distance < 0 ? -1 : 1;
  const hops = hopLength > 0 ? Math.max(1, Math.ceil(Math.abs(distance) / hopLength)) : 1;
  return { direction, hops, distance };
}

/** Advance a hop in progress: add this frame's travel, never past the landing spot. */
export function stepHop(left: number, moved: number, targetLeft: number, direction: -1 | 1): number {
  const next = left + moved;
  return direction > 0 ? Math.min(next, targetLeft) : Math.max(next, targetLeft);
}

export interface WanderGate {
  quiet: boolean;
  reducedMotion: boolean;
  inSequence: boolean;
  /** Dragging, flying, hopping or hidden. */
  busy: boolean;
  onScreen: boolean;
  /** Seconds left on the wander timer. */
  timer: number;
  /** Milliseconds since the last wander started. */
  sinceLastMs: number;
  /** Hard floor between wanders, seconds (`wander_gap[0]`). */
  minGapS: number;
}

/** Whether the wander timer may run down this frame. */
export function wanderTimerRuns(g: Pick<WanderGate, "quiet" | "reducedMotion" | "inSequence" | "busy" | "onScreen">): boolean {
  return g.quiet && !g.reducedMotion && !g.inSequence && !g.busy && g.onScreen;
}

/** Whether a wander may start right now. */
export function wanderAllowed(g: WanderGate): boolean {
  return wanderTimerRuns(g) && g.timer <= 0 && g.sinceLastMs >= g.minGapS * 1000;
}

export interface WanderPlan {
  direction: -1 | 1;
  hops: number;
  /** Landing spot for the footprint's left edge. */
  targetLeft: number;
}

/**
 * Pick a direction with room and a hop count in range, keeping the body at least `margin` px
 * from both viewport edges. Fewer hops when the row is short; null when even one does not fit.
 */
export function planWander(left: number, bodyWidth: number, viewportWidth: number, hopLength: number, hops: [number, number], random: () => number, margin = 40): WanderPlan | null {
  if (hopLength <= 0) return null;
  const want = hops[0] + Math.floor(random() * (Math.max(hops[0], hops[1]) - hops[0] + 1));
  const roomLeft = left - margin;
  const roomRight = viewportWidth - margin - (left + bodyWidth);
  const fitLeft = Math.min(want, Math.floor(roomLeft / hopLength));
  const fitRight = Math.min(want, Math.floor(roomRight / hopLength));
  if (fitLeft < 1 && fitRight < 1) return null;
  let direction: -1 | 1;
  if (fitLeft >= want && fitRight >= want) direction = random() < 0.5 ? -1 : 1;
  else direction = fitLeft >= fitRight ? -1 : 1;
  const n = direction < 0 ? fitLeft : fitRight;
  return { direction, hops: n, targetLeft: left + direction * n * hopLength };
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Body center to stand beside a pointed-at rect: left of it with a gap when there is room, else right. Feet on its bottom line. */
export function besidePoint(rect: RectLike, bodyWidth: number, bodyHeight: number, viewportWidth: number, gap = 16): { x: number; y: number } {
  const leftFits = rect.x - gap - bodyWidth >= 0;
  const rightFits = rect.x + rect.width + gap + bodyWidth <= viewportWidth;
  const x = leftFits || !rightFits ? rect.x - gap - bodyWidth / 2 : rect.x + rect.width + gap + bodyWidth / 2;
  return { x, y: rect.y + rect.height - bodyHeight / 2 };
}

export interface FlightState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds in the air. */
  t: number;
}

export interface FlightBounds {
  minX: number;
  maxX: number;
  minY: number;
  /** The resting line; landing happens here. */
  floorY: number;
}

export const FLIGHT = {
  gravity: 2400,
  wallBounce: 0.5,
  floorBounce: 0.35,
  /** Below this vertical speed a floor contact is a landing, not a bounce. */
  settleSpeed: 250,
  maxSeconds: 3,
  /** Release speed that turns a drop into a throw. */
  throwSpeed: 350,
};

/** One frame of throw physics. Returns the new state and whether he has landed. */
export function stepFlight(s: FlightState, dt: number, b: FlightBounds): { state: FlightState; landed: boolean } {
  let { x, y, vx, vy } = s;
  const t = s.t + dt;
  vy += FLIGHT.gravity * dt;
  x += vx * dt;
  y += vy * dt;
  if (x < b.minX) {
    x = b.minX;
    vx = -vx * FLIGHT.wallBounce;
  } else if (x > b.maxX) {
    x = b.maxX;
    vx = -vx * FLIGHT.wallBounce;
  }
  if (y < b.minY) {
    y = b.minY;
    vy = Math.max(0, vy);
  }
  let landed = false;
  if (t >= FLIGHT.maxSeconds) {
    y = b.floorY;
    landed = true;
  } else if (y >= b.floorY) {
    y = b.floorY;
    if (Math.abs(vy) > FLIGHT.settleSpeed) vy = -vy * FLIGHT.floorBounce;
    else landed = true;
  }
  return { state: { x, y, vx, vy, t }, landed };
}

/** Release velocity from the last pointer samples inside `windowMs`. */
export function releaseVelocity(samples: { t: number; x: number; y: number }[], now: number, windowMs = 120): { vx: number; vy: number; speed: number } {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return { vx: 0, vy: 0, speed: 0 };
  const a = recent[0];
  const z = recent[recent.length - 1];
  const dt = (z.t - a.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0, speed: 0 };
  const vx = (z.x - a.x) / dt;
  const vy = (z.y - a.y) / dt;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}
