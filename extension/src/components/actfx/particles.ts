/**
 * Pixel particles for the set pieces: one canvas in the effects layer, squares on the 3px grid,
 * whole-pixel positions, gravity, a life in ms, and a colour from the palette. The loop runs only
 * while something is alive. Everything here is show; nothing reads the page.
 */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pixels per second squared, down. */
  g: number;
  /** Total life in ms and the ms it has lived. */
  life: number;
  age: number;
  /** Side of the square in screen pixels (a multiple of 3). */
  size: number;
  color: string;
  /** Fades in steps over the last part of its life (0 to 1 of life). */
  fadeFrom: number;
}

export const CREAM = "#fff8e7";
export const GOLD = "#f2c14e";
export const TEAL = "#1f8a7a";
export const INK = "#3b2a23";
export const WHITE = "#ffffff";

const parts: Particle[] = [];
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let last = 0;

function ensure(layer: HTMLElement): CanvasRenderingContext2D | null {
  if (canvas && canvas.parentNode !== layer) {
    canvas.remove();
    canvas = null;
  }
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "pip-actfx-canvas";
    layer.appendChild(canvas);
    ctx = canvas.getContext("2d");
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return ctx;
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const c = ctx;
  if (!c || !canvas) return;
  c.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.age += dt * 1000;
    if (p.age >= p.life) {
      parts.splice(i, 1);
      continue;
    }
    p.vy += p.g * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const t = p.age / p.life;
    // Three visible steps of fade, not a ramp: full, then two thirds, then one third.
    const k = t < p.fadeFrom ? 1 : 1 - Math.floor(((t - p.fadeFrom) / (1 - p.fadeFrom)) * 3) / 3;
    if (k <= 0) continue;
    c.globalAlpha = k;
    c.fillStyle = p.color;
    const s = p.size;
    c.fillRect(Math.round(p.x / 3) * 3, Math.round(p.y / 3) * 3, s, s);
  }
  c.globalAlpha = 1;
  if (parts.length) raf = requestAnimationFrame(tick);
  else {
    raf = 0;
    canvas.remove();
    canvas = null;
    ctx = null;
  }
}

function start(layer: HTMLElement): void {
  if (!ensure(layer)) return;
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

export function emit(layer: HTMLElement, p: Partial<Particle> & { x: number; y: number }): void {
  parts.push({ vx: 0, vy: 0, g: 900, life: 600, age: 0, size: 3, color: CREAM, fadeFrom: 0.5, ...p });
  start(layer);
}

/** A radial burst of n squares from a point, speeds between lo and hi px/s, colours cycling through `colors`. */
export function burst(layer: HTMLElement, x: number, y: number, n: number, opts: { lo?: number; hi?: number; colors?: string[]; g?: number; life?: number; size?: number } = {}): void {
  const { lo = 160, hi = 420, colors = [CREAM, GOLD], g = 900, life = 700, size = 3 } = opts;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const v = lo + Math.random() * (hi - lo);
    emit(layer, { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g, life: life + Math.random() * 200, size: i % 3 === 0 ? size * 2 : size, color: colors[i % colors.length], fadeFrom: 0.4 });
  }
}

/** Squares that gather in to a point from a ring around it: the wind-up. */
export function gather(layer: HTMLElement, x: number, y: number, n: number, radius: number, ms: number, colors = [GOLD, CREAM]): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = radius * (0.7 + Math.random() * 0.5);
    const sx = x + Math.cos(a) * r;
    const sy = y + Math.sin(a) * r;
    emit(layer, { x: sx, y: sy, vx: ((x - sx) / ms) * 1000, vy: ((y - sy) / ms) * 1000, g: 0, life: ms, size: 3, color: colors[i % colors.length], fadeFrom: 0.8 });
  }
}

/** A trail behind a moving point: two or three squares a frame, drifting and fading fast. */
export function trail(layer: HTMLElement, x: number, y: number, n = 2, colors = [CREAM, GOLD]): void {
  for (let i = 0; i < n; i++) {
    emit(layer, { x: x + (Math.random() - 0.5) * 18, y: y + (Math.random() - 0.5) * 12, vx: (Math.random() - 0.5) * 60, vy: 40 + Math.random() * 80, g: 120, life: 340 + Math.random() * 180, size: 3, color: colors[i % colors.length], fadeFrom: 0.2 });
  }
}

/** Confetti from the top edge across a span: gold, teal and cream squares drifting down. */
export function confetti(layer: HTMLElement, x0: number, x1: number, n: number): void {
  for (let i = 0; i < n; i++) {
    emit(layer, { x: x0 + Math.random() * (x1 - x0), y: -6, vx: (Math.random() - 0.5) * 80, vy: 60 + Math.random() * 120, g: 220, life: 1200 + Math.random() * 600, size: i % 4 === 0 ? 6 : 3, color: [GOLD, TEAL, CREAM][i % 3], fadeFrom: 0.7 });
  }
}
