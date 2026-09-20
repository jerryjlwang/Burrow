/**
 * Pure rules for when the tablet watcher asks the judge to look. The background samples the tablet
 * about twice a second and counts the pixels that changed between samples. Writing shows up as a
 * steady trickle of changed pixels; the judge is asked once enough new ink has landed, or when the
 * pen pauses with a little unjudged ink. Everything is a fraction of the sampled pixel count so the
 * rules do not care about screen size.
 */
export interface TriggerRules {
  /** Below this fraction a sample counts as noise (cursor blink, antialiasing, a hover highlight). */
  noise: number;
  /** Fire as soon as this much ink has accumulated since the last check. */
  ink: number;
  /** After a pause, fire if at least this much ink accumulated. */
  pauseInk: number;
  /** How long the pen has to be still for a pause. */
  pauseMs: number;
  /** Never fire twice inside this window. */
  minGapMs: number;
  /** The pen has been still this long since the last ink or check: the kid may be stuck. Infinity turns stalls off. */
  stallMs: number;
}

export const DEFAULT_RULES: TriggerRules = { noise: 0.0006, ink: 0.004, pauseInk: 0.0008, pauseMs: 1200, minGapMs: 2500, stallMs: 45_000 };

/** A region to leave out of the diff, as fractions of the frame (the rabbit, his bubble, his board, his rings). */
export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Luma of an RGBA buffer, one byte per pixel. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length >> 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = (rgba[i] * 77 + rgba[i + 1] * 151 + rgba[i + 2] * 28) >> 8;
  return out;
}

/** Pixels whose luma moved by more than `threshold` between two same-sized gray frames. */
export function changedPixels(prev: Uint8Array, next: Uint8Array, threshold = 24): number {
  const n = Math.min(prev.length, next.length);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = prev[i] - next[i];
    if (d > threshold || d < -threshold) changed++;
  }
  return changed;
}

/**
 * Changed pixels outside the masked regions of a width x height gray frame. The rabbit and his UI
 * live on the board tab too, so a hop, a typing bubble or a rising chalkboard would otherwise
 * read as a flurry of ink. Only changed pixels are tested against the mask, so it costs nothing
 * on a still frame. `pad` widens each region by a few sampled pixels for antialiasing.
 */
export function maskedChangedPixels(prev: Uint8Array, next: Uint8Array, width: number, height: number, rects: MaskRect[], threshold = 24, pad = 2): number {
  if (!rects.length) return changedPixels(prev, next, threshold);
  const boxes = rects.map((r) => ({
    x0: Math.max(0, Math.floor(r.x * width) - pad),
    y0: Math.max(0, Math.floor(r.y * height) - pad),
    x1: Math.min(width, Math.ceil((r.x + r.w) * width) + pad),
    y1: Math.min(height, Math.ceil((r.y + r.h) * height) + pad),
  }));
  const n = Math.min(prev.length, next.length, width * height);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = prev[i] - next[i];
    if (d <= threshold && d >= -threshold) continue;
    const x = i % width;
    const y = (i - x) / width;
    let masked = false;
    for (const b of boxes) {
      if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) {
        masked = true;
        break;
      }
    }
    if (!masked) changed++;
  }
  return changed;
}

export type TriggerReason = "ink" | "pause" | "stall";

export class InkTrigger {
  private inkSinceCheck = 0;
  private lastInkAt = 0;
  private lastCheckAt = 0;
  private inFlight = false;
  /** A stall fired and no ink has landed since: one stall per rest, however long it lasts. */
  private stalled = false;
  /** How long the pen may rest before a stall; the watcher shortens it after a wrong line and turns it off on solved work. */
  stallMs: number;

  constructor(
    private readonly pixels: number,
    private readonly rules: TriggerRules = DEFAULT_RULES,
  ) {
    this.stallMs = rules.stallMs;
  }

  /** Feed one sample. Returns why the judge should look now, or null. */
  push(changed: number, now: number): TriggerReason | null {
    const frac = changed / this.pixels;
    if (frac > this.rules.noise) {
      this.inkSinceCheck += frac;
      this.lastInkAt = now;
      this.stalled = false;
    }
    if (this.inFlight || now - this.lastCheckAt < this.rules.minGapMs) return null;
    if (this.inkSinceCheck >= this.rules.ink) return "ink";
    if (this.inkSinceCheck >= this.rules.pauseInk && this.lastInkAt > 0 && now - this.lastInkAt >= this.rules.pauseMs) return "pause";
    // A stall needs work on the board (at least one check) and a rest measured from whichever was later, the last ink or the last check.
    if (!this.stalled && this.lastCheckAt > 0 && Number.isFinite(this.stallMs) && now - Math.max(this.lastInkAt, this.lastCheckAt) >= this.stallMs) {
      this.stalled = true;
      return "stall";
    }
    return null;
  }

  /** The judge was asked: new ink accumulates from zero while the answer is pending. */
  checkStarted(now: number): void {
    this.inFlight = true;
    this.lastCheckAt = now;
    this.inkSinceCheck = 0;
  }

  checkFinished(): void {
    this.inFlight = false;
  }

  /** Unjudged ink so far, as a fraction of the frame. */
  get pending(): number {
    return this.inkSinceCheck;
  }
}
