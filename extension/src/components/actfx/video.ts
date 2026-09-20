import { assetUrl } from "../pet";
import { grid, spawn, wait, type Piece, type PieceContext, type Rect, type VideoDetail } from "./common";
import { videoCue } from "./video-sound";

/**
 * Watching along. Everything here is show: the video is paused and played by the watcher and the
 * student, never by this file. The layer is pointer-transparent, so nothing drawn intercepts a click.
 *
 * pause by us: he travels to the frame's bottom left corner, outside it, and taps. A big pixel pause
 * glyph pops in the centre in three steps and holds a beat while the frame dims through four Bayer
 * tiles (never the whole picture); the glyph then shrinks in steps into a small badge in the top left
 * corner that stays while paused. He waves once to the viewer, because he is about to talk.
 *
 * play by us: he taps again. A play glyph pulses twice where the badge was, the badge and the dim
 * lift in reverse steps, six cream motes drift up across the frame and fade, and he settles beside
 * the frame with a glance at his watch.
 *
 * pause by them: no travel; a glance at his watch and the small badge pops into the corner.
 * play by them: the badge goes, a pixel "!" pops over his head, and he settles.
 * seek by them: his pocket watch appears in the top right corner and its hand spins three turns,
 * one tick a turn.
 *
 * Reduced motion: no travel; the badge and the dim appear whole and go at once. Whole pixels
 * throughout: sizes step through whole scales and positions land on the 3px grid.
 */

/** Asset variables set once on the layer; the CSS reads them (styles.css, "watching along"). */
const ASSETS: [string, string][] = [
  ["--vfx-play", "ui/actfx/video_play.png"],
  ["--vfx-badge", "ui/actfx/video_badge.png"],
  ["--vfx-watch", "ui/actfx/video_watch.png"],
  ["--vfx-bang", "ui/actfx/video_bang.png"],
  ["--vfx-dim-1", "ui/actfx/video_dim_1.png"],
  ["--vfx-dim-2", "ui/actfx/video_dim_2.png"],
  ["--vfx-dim-3", "ui/actfx/video_dim_3.png"],
  ["--vfx-dim-4", "ui/actfx/video_dim_4.png"],
];

/** Source sizes of the pieces (tools/sprites/actfx_video_px.py); drawn at whole-number scales. */
const BADGE_SRC = 11;
const PLAY_SRC = 11;
const BANG_W = 5;
const BANG_H = 13;
const WATCH_W = 39;
const WATCH_H = 42;
const SCALE = 3;
const BADGE = BADGE_SRC * SCALE;
/** The badge and the watch sit this far in from the frame's corner. */
const INSET = 9;
/** The big glyph is this much of the frame's height, and never smaller than the floor. */
const GLYPH_RATIO = 0.15;
const GLYPH_MIN = 45;
/** One step of a pop, of the dim, of the shrink to the corner, of a pulse. */
const POP_MS = 70;
const DIM_MS = 90;
const SHRINK_MS = 60;
const PULSE_MS = 90;
/** The big glyph holds this long at full size before it shrinks. */
const BEAT_MS = 450;
/** Into idle_tap (10 fps): the foot is down on frame 3. */
const TAP_MS = 240;
/** A trip through the hole is under three seconds; never wait longer for him. */
const TRAVEL_CAP_MS = 3200;
/** One turn of the watch hand (eight frames) and the turns it makes. Must match styles.css. */
const SPIN_MS = 360;
const SPIN_TURNS = 3;
/** The motes rise this many 9px or 12px steps. Must match styles.css (twelve steps). */
const MOTE_STEPS = 12;
const MOTES = 6;

/** A fixed element that follows the page when the window scrolls, so a badge stays on its frame. */
interface Pinned {
  el: HTMLElement;
  left: number;
  top: number;
  sx: number;
  sy: number;
}

/** What is up on the frame while it is paused. One frame at a time; the newest event wins. */
interface Paused {
  rect: Rect;
  badge: Pinned | null;
  dim: Pinned | null;
}

const pinned = new Set<Pinned>();
let paused: Paused | null = null;
let watch: Pinned | null = null;
let watchUntil = 0;
/** Bumped by every pause and play piece; an older piece's steps stop when they see a newer number. */
let seq = 0;

const onScroll = () => {
  for (const p of pinned) {
    p.el.style.left = `${p.left - (window.scrollX - p.sx)}px`;
    p.el.style.top = `${p.top - (window.scrollY - p.sy)}px`;
  }
};

function pin(el: HTMLElement, left: number, top: number): Pinned {
  const p: Pinned = { el, left, top, sx: window.scrollX, sy: window.scrollY };
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  if (pinned.size === 0) window.addEventListener("scroll", onScroll, { passive: true });
  pinned.add(p);
  return p;
}

function unpin(p: Pinned | null): void {
  if (!p) return;
  pinned.delete(p);
  p.el.remove();
  if (pinned.size === 0) window.removeEventListener("scroll", onScroll);
}

function ensureAssets(layer: HTMLElement): void {
  if (layer.dataset.vfx) return;
  layer.dataset.vfx = "1";
  for (const [name, file] of ASSETS) layer.style.setProperty(name, `url("${assetUrl(file)}")`);
}

/** Transient pieces (glyphs, motes, the "!") of an older pause or play piece are swept by the next one. */
function sweep(layer: HTMLElement): void {
  for (const el of layer.querySelectorAll(".pip-vfx-t")) el.remove();
}

/* ---------- where things go ---------- */

function usable(rect: Rect | null): Rect | null {
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

/** The visible part of the frame. */
function visible(rect: Rect): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Math.max(rect.x, 0), y0: Math.max(rect.y, 0), x1: Math.min(rect.x + rect.width, window.innerWidth), y1: Math.min(rect.y + rect.height, window.innerHeight) };
}

function centre(rect: Rect): { x: number; y: number } {
  const v = visible(rect);
  return { x: Math.round((v.x0 + v.x1) / 2), y: Math.round((v.y0 + v.y1) / 2) };
}

/** The badge's spot: the top left corner, inset, on the grid. */
function corner(rect: Rect): { x: number; y: number } {
  const v = visible(rect);
  return { x: grid(v.x0 + INSET), y: grid(v.y0 + INSET) };
}

/** The watch's spot: the top right corner, so it never sits on the badge. */
function watchCorner(rect: Rect): { x: number; y: number } {
  const v = visible(rect);
  return { x: grid(v.x1 - INSET - WATCH_W), y: grid(v.y0 + INSET) };
}

function glyphHeight(rect: Rect): number {
  return Math.max(GLYPH_MIN, grid(rect.height * GLYPH_RATIO));
}

/** Where he stands to tap: beside the frame's bottom left corner, outside it, or the right when the left has no room. */
function tapSpot(rect: Rect, body: DOMRect | null): { x: number; y: number } {
  const w = body?.width ?? 93;
  const h = body?.height ?? 159;
  const gap = 12;
  const leftFits = rect.x - gap - w >= 0;
  const rightFits = rect.x + rect.width + gap + w <= window.innerWidth;
  const x = leftFits || !rightFits ? rect.x - gap - w / 2 : rect.x + rect.width + gap + w / 2;
  const y = Math.max(h / 2, Math.min(window.innerHeight - h / 2, rect.y + rect.height - h / 2));
  return { x: Math.round(x), y: Math.round(y) };
}

/** Send him to the tap spot unless he is already there. Capped, so a stuck trip never stalls the piece. */
async function travel(rect: Rect, ctx: PieceContext): Promise<void> {
  const pet = ctx.pet;
  if (!pet || ctx.reduced) return;
  const body = ctx.petRect();
  const spot = tapSpot(rect, body);
  if (body && body.width > 0 && Math.abs(body.left + body.width / 2 - spot.x) < 30 && Math.abs(body.top + body.height / 2 - spot.y) < 30) return;
  await Promise.race([pet.goTo(spot.x, spot.y), wait(TRAVEL_CAP_MS)]);
}

/* ---------- the pieces of the picture ---------- */

/** Two cream bars, sized in whole steps by `sizePause`. */
function pauseGlyph(layer: HTMLElement): HTMLElement {
  const { el } = spawn(layer, "pip-vfx-pause pip-vfx-t");
  el.append(document.createElement("i"), document.createElement("i"));
  return el;
}

function sizePause(el: HTMLElement, cx: number, cy: number, h: number): void {
  const bar = Math.max(6, grid(h * 0.36));
  const gap = Math.max(3, grid(h * 0.22));
  const w = bar * 2 + gap;
  el.style.setProperty("--bar", `${bar}px`);
  el.style.setProperty("--gap", `${gap}px`);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.left = `${Math.round(cx - w / 2)}px`;
  el.style.top = `${Math.round(cy - h / 2)}px`;
}

function badge(layer: HTMLElement, x: number, y: number, scale: number): Pinned {
  const { el } = spawn(layer, "pip-vfx-badge");
  scaleBadge(el, scale);
  return pin(el, x, y);
}

function scaleBadge(el: HTMLElement, scale: number): void {
  el.style.width = `${BADGE_SRC * scale}px`;
  el.style.height = `${BADGE_SRC * scale}px`;
}

function sizePlay(el: HTMLElement, cx: number, cy: number, scale: number): void {
  const s = PLAY_SRC * scale;
  el.style.width = `${s}px`;
  el.style.height = `${s}px`;
  el.style.left = `${Math.round(cx - s / 2)}px`;
  el.style.top = `${Math.round(cy - s / 2)}px`;
}

function dim(layer: HTMLElement, rect: Rect, level: number): Pinned {
  const { el } = spawn(layer, "pip-vfx-dim");
  setDim(el, level);
  el.style.width = `${Math.round(rect.width)}px`;
  el.style.height = `${Math.round(rect.height)}px`;
  return pin(el, Math.round(rect.x), Math.round(rect.y));
}

function setDim(el: HTMLElement, level: number): void {
  el.className = `pip-vfx-dim d${level}`;
}

/** Step the dim one tile at a time. Going to 0 clears it and lets it go. */
async function stepDim(p: Pinned | null, from: number, to: number, live: () => boolean): Promise<void> {
  if (!p) return;
  const dir = to > from ? 1 : -1;
  for (let level = from; level !== to; ) {
    level += dir;
    if (!live()) return;
    setDim(p.el, level);
    await wait(DIM_MS);
  }
  if (to === 0) unpin(p);
}

/** Six cream motes rise from the lower part of the frame in whole steps and fade. */
function motes(layer: HTMLElement, rect: Rect): void {
  const v = visible(rect);
  const step = rect.height >= 480 ? 12 : 9;
  const lift = Math.min(60, Math.round(rect.height * 0.15));
  for (let i = 0; i < MOTES; i++) {
    const fx = (i + 0.3 + Math.random() * 0.4) / MOTES;
    const x = grid(v.x0 + (v.x1 - v.x0) * fx);
    const y = grid(v.y1 - 24 - Math.random() * lift);
    const delay = `${i * 60}ms`;
    const { el } = spawn(layer, `pip-vfx-mote pip-vfx-t${i % 2 ? " big" : ""}`, { left: `${x}px`, top: `${y}px`, animationDelay: delay }, 1300 + i * 60);
    el.style.setProperty("--rise", `${-step * MOTE_STEPS}px`);
    const core = document.createElement("i");
    core.style.animationDelay = delay;
    el.appendChild(core);
  }
}

/** A gold "!" pops over his head: small, big, settled; a beat; gone. */
async function bang(ctx: PieceContext): Promise<void> {
  const body = ctx.petRect();
  if (!body || body.width === 0) return;
  const cx = Math.round(body.left + body.width / 2);
  const bottom = Math.round(body.top) - 6;
  const { el, gone } = spawn(ctx.layer, "pip-vfx-bang pip-vfx-t");
  const size = (s: number) => {
    el.style.width = `${BANG_W * s}px`;
    el.style.height = `${BANG_H * s}px`;
    el.style.left = `${Math.round(cx - (BANG_W * s) / 2)}px`;
    el.style.top = `${bottom - BANG_H * s}px`;
  };
  if (ctx.reduced) {
    size(SCALE);
    await wait(700);
    gone();
    return;
  }
  videoCue("bang");
  for (const s of [2, 4, 3]) {
    size(s);
    await wait(POP_MS);
  }
  await wait(600);
  size(2);
  await wait(POP_MS);
  gone();
}

/* ---------- the pieces ---------- */

async function pauseByUs(rect: Rect | null, ctx: PieceContext, live: () => boolean): Promise<void> {
  const { pet, layer, reduced } = ctx;
  if (!rect) {
    pet?.play("wave");
    return;
  }
  await travel(rect, ctx);
  if (!live()) return;
  pet?.play("idle_tap");
  if (!reduced) await wait(TAP_MS);
  if (!live()) return;
  const k = corner(rect);
  if (reduced) {
    paused = { rect, dim: dim(layer, rect, 4), badge: badge(layer, k.x, k.y, SCALE) };
    pet?.play("wave");
    return;
  }
  const c = centre(rect);
  const h = glyphHeight(rect);
  const state: Paused = { rect, dim: dim(layer, rect, 0), badge: null };
  paused = state;
  videoCue("pause");
  void stepDim(state.dim, 0, 4, live);
  const g = pauseGlyph(layer);
  for (const f of [0.5, 1.15, 1]) {
    sizePause(g, c.x, c.y, grid(h * f));
    await wait(POP_MS);
    if (!live()) return;
  }
  pet?.play("wave");
  await wait(BEAT_MS);
  // Off the centre: into the corner in whole steps, then the badge takes over.
  const bx = k.x + Math.round(BADGE / 2);
  const by = k.y + Math.round(BADGE / 2);
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    if (!live()) return;
    const t = i / steps;
    sizePause(g, Math.round(c.x + (bx - c.x) * t), Math.round(c.y + (by - c.y) * t), Math.max(15, grid(h + (BADGE - h) * t)));
    await wait(SHRINK_MS);
  }
  g.remove();
  if (!live()) return;
  state.badge = badge(layer, k.x, k.y, SCALE);
  state.badge.el.classList.add("drop");
}

async function playByUs(rect: Rect | null, ctx: PieceContext, live: () => boolean): Promise<void> {
  const { pet, layer, reduced } = ctx;
  const r = rect ?? paused?.rect ?? null;
  if (!r) {
    pet?.play("idle_watch");
    return;
  }
  await travel(r, ctx);
  if (!live()) return;
  pet?.play("idle_tap");
  if (!reduced) await wait(TAP_MS);
  if (!live()) return;
  const was = paused;
  paused = null;
  const k = was?.badge ? { x: was.badge.left, y: was.badge.top } : corner(r);
  unpin(was?.badge ?? null);
  const { el: p, gone } = spawn(layer, "pip-vfx-play pip-vfx-t");
  const cx = k.x + Math.round(BADGE / 2);
  const cy = k.y + Math.round(BADGE / 2);
  if (reduced) {
    sizePlay(p, cx, cy, SCALE);
    unpin(was?.dim ?? null);
    await wait(500);
    gone();
    pet?.play("idle_watch");
    return;
  }
  videoCue("play");
  void stepDim(was?.dim ?? null, 4, 0, live);
  for (const s of [SCALE, SCALE + 1, SCALE, SCALE + 1, SCALE]) {
    sizePlay(p, cx, cy, s);
    await wait(PULSE_MS);
    if (!live()) return;
  }
  motes(layer, r);
  await wait(PULSE_MS * 2);
  gone();
  pet?.play("idle_watch");
}

async function pauseByThem(rect: Rect | null, ctx: PieceContext, live: () => boolean): Promise<void> {
  const { pet, layer, reduced } = ctx;
  pet?.play("idle_watch");
  if (!rect) return;
  if (paused?.badge) return;
  const k = corner(rect);
  const state: Paused = { rect, dim: paused?.dim ?? null, badge: null };
  paused = state;
  const b = badge(layer, k.x, k.y, reduced ? SCALE : SCALE - 1);
  state.badge = b;
  if (reduced) return;
  await wait(POP_MS);
  if (!live()) return;
  scaleBadge(b.el, SCALE);
}

async function playByThem(ctx: PieceContext, live: () => boolean): Promise<void> {
  const { pet, reduced } = ctx;
  const was = paused;
  paused = null;
  if (was?.badge && !reduced) {
    scaleBadge(was.badge.el, SCALE - 1);
    await wait(POP_MS);
  }
  unpin(was?.badge ?? null);
  if (reduced) unpin(was?.dim ?? null);
  else void stepDim(was?.dim ?? null, 4, 0, live);
  pet?.play("settle");
  await bang(ctx);
}

async function seekByThem(rect: Rect | null, ctx: PieceContext): Promise<void> {
  const { pet, layer, reduced } = ctx;
  pet?.play("idle_watch");
  if (!rect) return;
  const life = reduced ? 900 : SPIN_MS * SPIN_TURNS + 150;
  if (watch) {
    // Scrubbing: one watch, its hand set going again, its time extended.
    watchUntil = Date.now() + life;
    if (!reduced) {
      watch.el.classList.remove("spin");
      void watch.el.offsetWidth;
      watch.el.classList.add("spin");
    }
    return;
  }
  const k = watchCorner(rect);
  const { el } = spawn(layer, "pip-vfx-watch drop");
  el.style.width = `${WATCH_W}px`;
  el.style.height = `${WATCH_H}px`;
  const w = pin(el, k.x, k.y);
  watch = w;
  watchUntil = Date.now() + life;
  if (!reduced) {
    el.classList.add("spin");
    videoCue("tick");
  }
  while (Date.now() < watchUntil) await wait(Math.max(16, watchUntil - Date.now()));
  if (watch === w) watch = null;
  unpin(w);
}

async function run(d: VideoDetail, ctx: PieceContext): Promise<void> {
  ensureAssets(ctx.layer);
  const rect = usable(d.rect);
  if (d.kind === "seek") {
    await seekByThem(rect, ctx);
    return;
  }
  const token = ++seq;
  const live = () => seq === token;
  sweep(ctx.layer);
  if (d.kind === "pause") await (d.by === "us" ? pauseByUs(rect, ctx, live) : pauseByThem(rect, ctx, live));
  else await (d.by === "us" ? playByUs(rect, ctx, live) : playByThem(ctx, live));
}

export const playVideoPiece: Piece<VideoDetail> = (detail, ctx) => {
  try {
    return run(detail, ctx).catch(() => undefined);
  } catch {
    return undefined;
  }
};
