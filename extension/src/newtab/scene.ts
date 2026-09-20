// The meadow behind the new tab page. Pieces come from extension/public/scene (tools/sprites/scene_px.py).
// Everything is composed at source size on an offscreen canvas and drawn 3x with smoothing off, so every
// position is a whole source pixel by construction. Layers move by whole pixels on timers; nothing tweens.
//
// Five layers, back to front: sky things (sun, moon, stars, clouds, birds, balloon, rainbow), the far
// hills with the windmill and the village, the near hills with sheep, the hedge line with the oak, and
// the front grass with the pond, the tea party, the roses, the giant mushroom, the card soldiers, the
// carrot patch, flowers and signs. The kid can poke at nearly all of it; see `react`. What he was taught
// grows along the front left as concept flowers. On the first tab of a session the world boots in layer
// by layer; see the boot section in `render`.

import type { GraphSnapshot } from "@shared/graph";
import { blipFor } from "./blip";

export type Tod = "morning" | "day" | "evening" | "night";

interface Piece {
  x: number;
  y: number;
  w: number;
  h: number;
  frames: number;
}

interface SceneManifest {
  atlas: { width: number; height: number; files: Record<Tod, string> };
  pieces: Record<string, Piece>;
  palettes: Record<Tod, Record<string, [number, number, number]>>;
  palette_hours: Record<Tod, number>;
  profiles: { hills_far: number[]; hills_near: number[] };
}

export interface BootView {
  mode: "full" | "quick" | "none";
  /** ms since the boot began. */
  elapsed: number;
  done: boolean;
}

export interface HoverSign {
  label: string;
  /** Viewport rect of the thing. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** True for the empty meadow's sprout, whose sign always shows and may wrap. */
  pinned?: boolean;
}

/** The far hills' line in viewport pixels, and the stretch of it clear of the windmill and the oak. */
export interface Ridge {
  y: number;
  left: number;
  right: number;
}

export interface SceneOptions {
  /** Real hour of the day, fractional, read on every tick. */
  hour: () => number;
  reducedMotion: boolean;
  rain: boolean;
  /** The rabbit's body box in viewport pixels, or null. */
  getPetRect: () => DOMRect | null;
  getBoot: () => BootView;
  /** Viewport x of DOM posts planted in the front grass, so concept flowers stay clear of them. */
  postXs?: () => number[];
  onPalette?: (tod: Tod, ground: string) => void;
  /** The layout settled for this viewport: where DOM signposts may stand. */
  onLayout?: (ridge: Ridge) => void;
  onHover?: (info: HoverSign | null) => void;
  /** First pointer or key on the scene, for starting sound. */
  onInteract?: () => void;
}

/** Test hooks, exposed as window.__meadow. Rects are viewport pixels. */
export interface MeadowApi {
  particles(): number;
  particleXY(): [number, number][];
  carrots(): number;
  concepts(): number;
  reactions(): number;
  carrotRect(i: number): Rect | null;
  conceptRect(i: number): Rect | null;
  sunRect(): Rect | null;
  moonRect(): Rect | null;
  oakRect(): Rect | null;
  shownHour(): number;
  bootElapsed(): number;
  weather(): "clear" | "rain";
  /** Force a happening now: cards, cheshire, fish, gust, balloon, rainbow, shadow. */
  event(name: string): void;
  cardsX(): number | null;
  cheshireFrame(): number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneHandle {
  stop(): void;
  setGraph(graph: GraphSnapshot | null): void;
  api: MeadowApi;
}

export const SCALE = 3;
const PET_HOLD_MS = 600;
const PET_STROKE_PX = 60;
const PET_GAP_MS = 4000;
const SCRUB_HOLD_MS = 60_000;
/** A change of light dithers the old picture away over seven Bayer steps. */
const FADE_STEP_MS = 60;
const REGROW_MS = 20_000;
const MAX_CONCEPTS = 10;
const RAIN_MS = 75_000;
const RAINBOW_MS = 20_000;
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER_STEPS = [0, 3, 6, 9, 12, 14, 16];

/** Which palette an hour gets (also used for the greeting). */
export function todFor(hour: number): Tod {
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** mulberry32: a tiny seeded generator so the meadow lays out the same way every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ItemKind = "tuft" | "flower" | "mush" | "bush" | "fence" | "signpost";

interface Fx {
  kind: "bloom" | "bounce" | "wiggle";
  at: number;
  until: number;
}

interface Item {
  piece: string;
  kind: ItemKind;
  x: number;
  y: number;
  flip?: boolean;
  /** 0..1, staggers two frame swaps. */
  phase: number;
  /** Sways between two frames when the piece has them. */
  sways?: boolean;
  fx?: Fx;
}

interface Cloud {
  piece: string;
  x0: number;
  y: number;
  /** ms per one pixel step. */
  period: number;
  flip: boolean;
  rainUntil: number;
}

interface Walker {
  x: number;
  y: number;
  phase: number;
  /** Home to circle, for bees. */
  hx?: number;
  hy?: number;
}

interface Carrot {
  x: number;
  y: number;
  stage: "grown" | "held" | "gone" | "sprout";
  at: number;
}

interface Concept {
  id: string;
  label: string;
  piece: "concept_tall" | "concept_plain" | "concept_wilted" | "sprout";
  x: number;
  y: number;
  phase: number;
  pinned?: boolean;
}

interface Particle {
  piece: string;
  x: number;
  y: number;
  born: number;
  life: number;
  /** ms per whole pixel step. */
  step: number;
  dx: number[];
  dy: number[];
  frames: number;
  k: number;
}

type HitKind = "cloud" | "birds" | "sun" | "moon" | "chimney" | "door" | "item" | "carrot" | "concept" | "pond" | "flamingo" | "oak" | "swing" | "tea" | "roses" | "giant" | "card" | "sheep" | "windmill" | "arrow";

interface Hit {
  kind: HitKind;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

interface Layout {
  sw: number;
  sh: number;
  groundTop: number;
  hedgeTop: number;
  horizon: number;
  farBottom: number;
  nearBottom: number;
  clouds: Cloud[];
  stars: Item[];
  back: Item[];
  ground: Item[];
  fireflies: Walker[];
  butterflies: Walker[];
  rain: { x: number; y0: number }[];
  mound: { x: number; y: number };
  path: { from: number; to: number; y: number };
  carrots: Carrot[];
  conceptY: number;
  pond: { x: number; y: number };
  flamingo: { x: number; y: number };
  hoops: [number, number][];
  oak: { x: number; y: number };
  tea: { x: number; y: number };
  roses: { x: number; y: number };
  giant: { x: number; y: number };
  sheep: { x: number; phase: number }[];
  windmill: { x: number };
  village: { x: number };
  arrow: { x: number; y: number };
  watch: { x: number; y: number };
  dirt: [number, number][];
  fork: { x: number; from: number; to: number };
}

function layout(sw: number, sh: number): Layout {
  const groundTop = sh - 83;
  const hedgeTop = groundTop - 11;
  const nearBottom = hedgeTop + 5;
  const farBottom = hedgeTop - 2;
  const horizon = farBottom - 6;
  const r = rng(7);
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)];

  const clouds: Cloud[] = [
    { piece: "cloud_b", x0: Math.round(sw * 0.12), y: Math.round(horizon * 0.2), period: 1000, flip: false, rainUntil: 0 },
    { piece: "cloud_a", x0: Math.round(sw * 0.58), y: Math.round(horizon * 0.42), period: 1400, flip: false, rainUntil: 0 },
    { piece: "cloud_c", x0: Math.round(sw * 0.82), y: Math.round(horizon * 0.58), period: 750, flip: true, rainUntil: 0 },
    { piece: "cloud_c", x0: Math.round(sw * 0.36), y: Math.round(horizon * 0.1), period: 1900, flip: false, rainUntil: 0 },
  ];

  const stars: Item[] = [];
  for (let i = 0; i < 52; i++) {
    stars.push({ piece: r() < 0.3 ? "star_a" : "star_b", kind: "flower", x: Math.floor(r() * sw), y: Math.floor(r() * (horizon - 10)), phase: r() });
  }

  // The right side of the middle ground, measured from the rabbit's clear corner (300 x 260 px).
  const clearX = sw - 100;
  const oak = { x: clearX - 47, y: groundTop + 4 - 62 };
  const tea = { x: oak.x - 40, y: groundTop + 16 - 16 };
  const roses = { x: tea.x - 30, y: groundTop + 16 - 11 };
  const giant = { x: roses.x - 34, y: groundTop + 16 - 30 };

  // Back row: fences at the edges, bushes between. The right corner stays his.
  const back: Item[] = [
    { piece: "fence", kind: "fence", x: 4, y: groundTop + 7 - 15, phase: 0 },
    { piece: "bush_a", kind: "bush", x: Math.round(sw * 0.28), y: groundTop + 5 - 10, phase: 0 },
    { piece: "bush_b", kind: "bush", x: Math.round(sw * 0.4), y: groundTop + 6 - 8, phase: 0 },
    { piece: "bush_d", kind: "bush", x: Math.round(sw * 0.5), y: groundTop + 5 - 8, phase: 0 },
    { piece: "bush_c", kind: "bush", x: giant.x - 30, y: groundTop + 6 - 11, phase: 0, flip: true },
  ];
  if (sw > 300) back.push({ piece: "fence", kind: "fence", x: clearX - 62, y: groundTop + 7 - 15, phase: 0 });

  // Middle and front rows: a jittered grid of tufts, flowers and mushrooms. The pond, the patch, the
  // concept row and the tea party keep their room.
  const ground: Item[] = [];
  const rows = [groundTop + 20, groundTop + 34, groundTop + 48, groundTop + 60];
  for (const baseY of rows) {
    for (let x = 6; x < clearX - 4; x += 20) {
      if (r() > 0.72) continue;
      const jx = x + Math.floor(r() * 11) - 5;
      const jy = baseY + Math.floor(r() * 9) - 4;
      const roll = r();
      if (jx < 100 && jy < groundTop + 40) continue;
      if (jx < 104 && jy > groundTop + 44 && jy < groundTop + 62) continue;
      if (jx > giant.x - 34 && jy < groundTop + 22) continue;
      const piece = roll < 0.52 ? pick(["tuft_a", "tuft_b", "tuft_c"]) : roll < 0.82 ? pick(["flower_r", "flower_y", "flower_w", "flower_s"]) : roll < 0.9 ? pick(["mush_a", "mush_b", "mush_c"]) : "flower_s";
      const kind: ItemKind = piece.startsWith("tuft") ? "tuft" : piece.startsWith("mush") ? "mush" : "flower";
      ground.push({ piece, kind, x: jx, y: jy, phase: r(), flip: r() < 0.5, sways: kind === "tuft" });
    }
  }
  for (let x = 110; x < clearX - 10; x += 34) {
    if (r() > 0.6) continue;
    ground.push({ piece: "tuft_c", kind: "tuft", x: x + Math.floor(r() * 9), y: sh - 12 + Math.floor(r() * 5), phase: r(), flip: r() < 0.5, sways: true });
  }
  ground.push({ piece: "mush_c", kind: "mush", x: clearX - 20, y: sh - 22, phase: 0 });
  ground.push({ piece: "flower_y", kind: "flower", x: clearX - 4, y: sh - 26, phase: 0 });

  const fireflies: Walker[] = [];
  for (let i = 0; i < 10; i++) {
    fireflies.push({ x: 10 + Math.floor(r() * Math.max(1, sw - 110)), y: groundTop - 30 + Math.floor(r() * 90), phase: Math.floor(r() * 8) });
  }
  const butterflies: Walker[] = [];
  for (let i = 0; i < 4; i++) {
    butterflies.push({ x: 20 + Math.floor(r() * Math.max(1, sw - 130)), y: groundTop + 4 + Math.floor(r() * 50), phase: Math.floor(r() * 4) });
  }
  const rain: { x: number; y0: number }[] = [];
  for (let i = 0; i < 90; i++) rain.push({ x: Math.floor(r() * sw), y0: Math.floor(r() * sh) });

  const carrots: Carrot[] = [0, 1, 2].map((i) => ({ x: 14 + i * 12, y: groundTop + 30 + (i % 2) * 2, stage: "grown", at: 0 }));

  return {
    sw, sh, groundTop, hedgeTop, horizon, farBottom, nearBottom, clouds, stars, back, ground, fireflies, butterflies, rain,
    mound: { x: sw - 81, y: sh - 3 - 29 },
    path: { from: Math.round(sw * 0.3), to: sw - 26, y: sh - 9 },
    carrots,
    conceptY: sh - 28,
    pond: { x: 8, y: groundTop - 2 },
    flamingo: { x: 80, y: groundTop + 6 },
    hoops: [[58, groundTop + 31], [72, groundTop + 33], [94, groundTop + 30]],
    oak,
    tea,
    roses,
    giant,
    sheep: [{ x: 70, phase: 0.1 }, { x: 165, phase: 0.6 }, { x: sw - 55, phase: 0.35 }],
    windmill: { x: 14 },
    village: { x: -1 },
    arrow: { x: clearX - 27, y: sh - 41 },
    watch: { x: 3, y: groundTop - 6 },
    dirt: [[128, sh - 31], [clearX - 31, sh - 21]],
    fork: { x: clearX - 7, from: groundTop + 20, to: sh - 9 },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

function send(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const inRect = (px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean => px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;

export function startScene(canvas: HTMLCanvasElement, opts: SceneOptions): SceneHandle {
  let stopped = false;
  let man: SceneManifest | null = null;
  const atlases: Partial<Record<Tod, HTMLImageElement>> = {};
  let img: HTMLImageElement | null = null;
  let tod: Tod | null = null;
  let lay: Layout | null = null;
  let mx = 0;
  let my = 0;
  const src = document.createElement("canvas");
  const sctx = src.getContext("2d")!;
  const t0 = performance.now();
  const motion = !opts.reducedMotion;
  const chance = rng(Math.floor(Math.random() * 1e9));
  const between = (a: number, b: number): number => a + chance() * (b - a);

  // Walkers keep their own state because their steps happen on ticks.
  let fireflyTick = -1;
  let flies: Walker[] = [];
  let butterflyTick = -1;
  let butters: Walker[] = [];
  let beeTick = -1;
  let bees: Walker[] = [];
  // The flock: scattered by a click, drifting back into formation.
  const flock = { scatterAt: 0, deltas: [] as [number, number][] };
  let doorOpenUntil = 0;
  const particles: Particle[] = [];
  let hits: Hit[] = [];
  let concepts: Concept[] = [];
  let graphSnapshot: GraphSnapshot | null | undefined;

  // The inhabitants' clocks. Times are performance.now() ms.
  const duck = { x: 14, dir: 1, tick: -1 };
  let fishAt = t0 + between(12_000, 30_000);
  let fishStart = 0;
  let flamingoLeg = 0;
  let flamingoAt = t0 + between(5000, 10_000);
  const cards = { start: 0, dir: 1, salute: [0, 0], nextAt: t0 + between(25_000, 60_000) };
  let steamUntil = 0;
  let rattleUntil = 0;
  const roses: ("w" | "r")[] = ["w", "w", "w"];
  let dripAt = 0;
  let dripAtRose = -1;
  let ringsAt = t0 + 4000;
  let windmillFast = 0;
  let balloonStart = t0 + 20_000;
  let gustAt = t0 + between(20_000, 40_000);
  let shadowStart = t0 + 12_000;
  let rainUntil = opts.rain ? t0 + RAIN_MS : 0;
  let rainbowUntil = 0;
  let sheepHop = [0, 0, 0];

  // The hour drawn. A dragged sun or moon scrubs it; the light holds for a minute, then eases back one
  // whole hour at a time.
  let scrub: { hour: number; heldUntil: number } | null = null;
  let easeAt = 0;
  let cheshireAt = 0;
  let cheshireNext = t0 + between(30_000, 70_000);
  // The last picture drawn with the previous palette, dithered away over the new one.
  const old = document.createElement("canvas");
  const octx = old.getContext("2d")!;
  let fade: { at: number } | null = null;
  const shownHour = (): number => (scrub ? scrub.hour : opts.hour()) % 24;

  // Pointer state: which thing is pressed or dragged, and how long the pointer has rested on the rabbit.
  let pressed: { hit: Hit | null; x: number; y: number; moved: boolean } | null = null;
  let drag: { kind: "sun" | "moon" | "carrot"; index: number; x: number; y: number } | null = null;
  const pointer = { x: -1, y: -1 };
  let overPetSince = 0;
  let stroke = 0;
  let lastPetAt = -Infinity;
  let cursorKind = "";
  let hoveredHit: Hit | null = null;
  let interacted = false;

  const pal = (): Record<string, [number, number, number]> => man!.palettes[tod!];
  const rgb = (key: string): string => {
    const c = pal()[key] ?? [255, 0, 255];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  };
  const piece = (name: string): Piece => man!.pieces[name];

  /** Sky colors blend between the neighbouring palettes by the shown hour, whole numbers only. */
  const skyColor = (key: string, hour: number): string => {
    const ph = man!.palette_hours;
    const anchors: [number, Tod][] = [[ph.night - 24, "night"], [ph.morning, "morning"], [ph.day, "day"], [ph.evening, "evening"], [ph.night, "night"]];
    const h = hour >= ph.night ? hour - 24 : hour;
    let i = 0;
    while (i < anchors.length - 2 && h > anchors[i + 1][0]) i++;
    const [ha, ta] = anchors[i];
    const [hb, tb] = anchors[i + 1];
    const f = Math.max(0, Math.min(1, (h - ha) / (hb - ha)));
    const a = man!.palettes[ta][key];
    const b = man!.palettes[tb][key];
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  };

  const draw = (name: string, x: number, y: number, frame = 0, flip = false): void => {
    const p = piece(name);
    if (!p || !img) return;
    const sx = p.x + (frame % p.frames) * p.w;
    if (!flip) {
      sctx.drawImage(img, sx, p.y, p.w, p.h, x, y, p.w, p.h);
      return;
    }
    sctx.save();
    sctx.translate(x + p.w, y);
    sctx.scale(-1, 1);
    sctx.drawImage(img, sx, p.y, p.w, p.h, 0, 0, p.w, p.h);
    sctx.restore();
  };

  /** Draw only the bottom `rows` rows of a piece: sprouting tufts, puffing bushes. */
  const drawBottom = (name: string, x: number, y: number, rows: number, frame = 0, flip = false): void => {
    const p = piece(name);
    if (!p || !img || rows <= 0) return;
    const h = Math.min(p.h, rows);
    const sx = p.x + (frame % p.frames) * p.w;
    if (!flip) {
      sctx.drawImage(img, sx, p.y + p.h - h, p.w, h, x, y + p.h - h, p.w, h);
      return;
    }
    sctx.save();
    sctx.translate(x + p.w, y + p.h - h);
    sctx.scale(-1, 1);
    sctx.drawImage(img, sx, p.y + p.h - h, p.w, h, 0, 0, p.w, h);
    sctx.restore();
  };

  /**
   * Repeat a tile across the width, mirroring every other copy when asked. Copy k sits at offset + k * w
   * and the odd copies are the mirrored ones, whatever the offset, so a parallax slide of one pixel moves
   * the skyline by one pixel. (Wrapping the start at w flipped every copy's mirror when the offset went
   * negative: the far hills grew a different skyline as the pointer crossed the middle.)
   */
  const tileAcross = (name: string, y: number, offset: number, mirrorAlternate: boolean): void => {
    const p = piece(name);
    if (!p || !lay) return;
    for (let k = Math.floor(-offset / p.w) - 1; offset + k * p.w < lay.sw; k++) draw(name, offset + k * p.w, y, 0, mirrorAlternate && (((k % 2) + 2) % 2) === 1);
  };

  /** Height of a tiled, alternately mirrored hill profile at scene column x, with the same copies as tileAcross. */
  const hillHeight = (name: "hills_far" | "hills_near", x: number, offset: number): number => {
    const prof = man!.profiles[name];
    const w = prof.length;
    const rel = x - offset;
    const k = Math.floor(rel / w);
    const col = rel - k * w;
    return prof[(((k % 2) + 2) % 2) === 1 ? w - 1 - col : col];
  };

  // Bayer patterns for the boot: a color in the cells already shown at a step, or an eraser mask.
  const patterns = new Map<string, CanvasPattern>();
  const bayerPattern = (color: string | null, step: number): CanvasPattern => {
    const key = `${color ?? "mask"}:${step}`;
    const cached = patterns.get(key);
    if (cached) return cached;
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 4;
    const g = c.getContext("2d")!;
    const thr = BAYER_STEPS[Math.max(0, Math.min(6, step))];
    g.fillStyle = color ?? "#000";
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (color ? BAYER[y][x] < thr : BAYER[y][x] >= thr) g.fillRect(x, y, 1, 1);
    const pat = sctx.createPattern(c, "repeat")!;
    patterns.set(key, pat);
    return pat;
  };

  const ensureSize = (): boolean => {
    const sw = Math.ceil(window.innerWidth / SCALE);
    const sh = Math.ceil(window.innerHeight / SCALE);
    if (lay && lay.sw === sw && lay.sh === sh) return false;
    lay = layout(sw, sh);
    flies = lay.fireflies.map((f) => ({ ...f }));
    butters = lay.butterflies.map((f) => ({ ...f }));
    const flowers = lay.ground.filter((it) => it.kind === "flower").slice(0, 3);
    bees = flowers.map((f, i) => ({ x: f.x + 2, y: f.y - 3, phase: i, hx: f.x + 2, hy: f.y - 3 }));
    src.width = sw;
    src.height = sh;
    canvas.width = sw * SCALE;
    canvas.height = sh * SCALE;
    canvas.style.width = `${sw * SCALE}px`;
    canvas.style.height = `${sh * SCALE}px`;
    plantConcepts();
    opts.onLayout?.({ y: lay.horizon * SCALE, left: (lay.windmill.x + 24) * SCALE, right: (lay.oak.x - 6) * SCALE });
    return true;
  };

  /* ---------- the sun and moon on their arcs ---------- */

  const arcPos = (f: number, w: number): { x: number; y: number } => {
    const L = lay!;
    const peak = Math.round(L.horizon * 0.36);
    return { x: Math.round(20 + f * (L.sw - 40 - w)), y: Math.round(L.horizon - 6 - Math.sin(f * Math.PI) * (L.horizon - 6 - peak)) };
  };
  const sunF = (h: number): number => (h - 6) / 16;
  const moonF = (h: number): number => (((h - 22) % 24) + 24) % 24 / 8;
  const skyBody = (kind: "sun" | "moon", hour: number): { x: number; y: number; w: number; h: number } | null => {
    const f = kind === "sun" ? sunF(hour) : moonF(hour);
    if (f < -0.02 || f > 1.02) return null;
    const p = piece(kind);
    const pos = arcPos(Math.max(0, Math.min(1, f)), p.w);
    return { x: pos.x, y: pos.y, w: p.w, h: p.h };
  };

  /* ---------- particles ---------- */

  const spawn = (piece: string, x: number, y: number, life: number, step: number, dx: number[], dy: number[], frames: number): void => {
    particles.push({ piece, x, y, born: performance.now(), life, step, dx, dy, frames, k: 0 });
  };
  const hearts = (cx: number, cy: number): void => {
    const r = rng(Math.floor(performance.now()));
    for (let i = 0; i < 4; i++) {
      const wobble = r() < 0.5 ? [1, 0, -1, 0] : [-1, 0, 1, 0];
      spawn("heart", cx - 6 + i * 4 - 2, cy - 4 + Math.floor(r() * 4), 1800 + i * 120, 130, wobble, [-1], 3);
    }
  };
  const sparkles = (cx: number, cy: number): void => {
    const dirs: [number, number][] = [[1, -1], [-1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [-1, 0], [0, 1]];
    dirs.forEach(([dx, dy], i) => spawn("sparkle", cx + dx * 3, cy + dy * 3, 650 + (i % 3) * 80, 90, [dx], [dy], 2));
  };
  const petals = (item: Item): void => {
    const color = item.piece.endsWith("_y") ? "petal_y" : item.piece.endsWith("_w") || item.piece.endsWith("_s") ? "petal_w" : "petal_r";
    for (let i = 0; i < 3; i++) spawn(color, item.x + i * 2, item.y + 1, 1200 + i * 150, 150, i % 2 ? [1, 0, -1, 0] : [-1, 0, 1, 0], [-1, 0], 1);
  };
  const smokeRing = (x: number, y: number): void => spawn("smoke_ring", x, y, 1600, 160, [0, 1, 0, -1], [-1], 3);
  const gust = (): void => {
    const L = lay!;
    const r = rng(Math.floor(performance.now()));
    for (let i = 0; i < 6; i++) spawn("seed", 10 + Math.floor(r() * 80), L.groundTop + 30 + Math.floor(r() * 30), 3600 + i * 200, 90, [1, 1, 0, 1], [-1, 0, 0, 0, -1, 0], 1);
    for (let i = 0; i < 3; i++) spawn("leaf", 20 + Math.floor(r() * 60), L.groundTop + 24 + Math.floor(r() * 30), 3200 + i * 300, 80, [1, 1, 1, 0], [0, 1, -1, 0, 0, -1], 1);
  };
  const stepParticles = (now: number): void => {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const age = now - p.born;
      if (age > p.life) {
        particles.splice(i, 1);
        continue;
      }
      const want = Math.floor(age / p.step);
      while (p.k < want) {
        if (motion) {
          p.x += p.dx[p.k % p.dx.length];
          p.y += p.dy[p.k % p.dy.length];
        }
        p.k++;
      }
    }
  };
  const drawParticles = (now: number): void => {
    for (const p of particles) {
      const frame = Math.min(p.frames - 1, Math.floor(((now - p.born) / p.life) * p.frames));
      draw(p.piece, p.x, p.y, frame);
    }
  };

  /* ---------- concept flowers from the graph ---------- */

  function plantConcepts(): void {
    if (!lay) return;
    const L = lay;
    const nodes = (graphSnapshot?.nodes ?? []).slice().sort((a, b) => (b.state?.lastSeenAt ?? 0) - (a.state?.lastSeenAt ?? 0)).slice(0, MAX_CONCEPTS);
    const posts = (opts.postXs?.() ?? []).map((x) => Math.round(x / SCALE));
    const clear = (x: number): number => {
      let cx = x;
      for (let guard = 0; guard < 4; guard++) {
        const near = posts.find((p) => Math.abs(p - cx - 3) < 10);
        if (near === undefined) break;
        cx = near + 10;
      }
      return cx;
    };
    const left = Math.round(L.sw / 2) - 58;
    if (!nodes.length) {
      concepts = [{ id: "sprout", label: "Teach me something and the meadow grows.", piece: "sprout", x: clear(Math.round(L.sw / 2) - 2), y: L.conceptY - piece("sprout").h, phase: 0 }];
      return;
    }
    concepts = nodes.map((n, i) => {
      const m = n.state?.mastery ?? 0;
      const kind = m > 0.6 ? "concept_tall" : m > 0.3 ? "concept_plain" : "concept_wilted";
      return { id: n.id, label: n.label, piece: kind, x: clear(left + i * 12), y: L.conceptY - piece(kind).h, phase: (i * 0.37) % 1 };
    });
  }

  /* ---------- the boot: the world drawn in layer by layer ---------- */

  const since = (bt: number, start: number, dur: number): number => (bt === Infinity ? 1 : Math.max(0, Math.min(1, (bt - start) / dur)));
  const stepOf = (bt: number, start: number, dur: number, n: number): number => Math.floor(since(bt, start, dur) * n);

  const paintEarth = (): void => {
    const L = lay!;
    const e = piece("earth");
    for (let y = 0; y < L.sh; y += e.h) for (let x = 0; x < L.sw; x += e.w) draw("earth", x, y);
  };

  /* ---------- the picture ---------- */

  const render = (): void => {
    if (!man || !img || !tod || !lay) return;
    const L = lay;
    const now = performance.now();
    const boot = opts.getBoot();
    const full = boot.mode === "full" && !boot.done;
    const quick = boot.mode === "quick" && !boot.done;
    // bt: boot time for the layer choreography; Infinity means everything is in place.
    const bt = full ? boot.elapsed : Infinity;
    const settled = !full && !quick;
    const t = motion ? now - t0 : 0;
    const live = motion && settled;
    const px = live ? Math.round(mx * 2) : 0;
    const py = live ? Math.round(my * 1) : 0;
    const farOff = live ? Math.round(-mx * 2) : 0;
    const nearOff = 40 + (live ? Math.round(-mx * 3) : 0);
    const hedgeOff = live ? Math.round(-mx * 4) : 0;
    const hour = shownHour();
    const daytime = tod !== "night";
    sctx.imageSmoothingEnabled = false;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, L.sw, L.sh);
    hits = [];
    const hit = (kind: HitKind, index: number, x: number, y: number, w: number, h: number, label?: string): void => {
      hits.push({ kind, index, x, y, w, h, label });
    };

    if (full) paintEarth();

    // Sky: six flat bands blended for the hour, the lowest one glows behind the hills. During the boot
    // each band dissolves in through a Bayer threshold, top band first.
    const edges = [0, 0.3, 0.5, 0.65, 0.78, 0.9].map((f) => Math.round(L.horizon * f));
    edges.push(L.groundTop + 2);
    const bandStep: number[] = [];
    for (let i = 0; i < 6; i++) {
      const color = skyColor(`K${i + 1}`, hour);
      const step = full ? stepOf(bt, 400 + i * 90, 240, 6) : 6;
      bandStep.push(step);
      if (step <= 0) continue;
      sctx.fillStyle = step >= 6 ? color : bayerPattern(color, step);
      sctx.fillRect(0, edges[i], L.sw, edges[i + 1] - edges[i]);
    }
    for (let i = 1; i < 6; i++) {
      if (bandStep[i - 1] < 6 || bandStep[i] < 6) continue;
      const y = edges[i];
      sctx.fillStyle = skyColor(`K${i}`, hour);
      for (let x = y & 1; x < L.sw; x += 2) sctx.fillRect(x, y, 1, 1);
    }

    // Stars, then the sun and moon on their arcs. In the boot they rise from behind the horizon line.
    if ((tod === "night" || tod === "evening") && bandStep[0] >= 6) {
      const limit = tod === "night" ? L.horizon - 10 : L.horizon - 80;
      for (const s of L.stars) {
        if (s.y >= limit) continue;
        const tick = Math.floor(t / 500 + s.phase * 4);
        const frame = s.piece === "star_a" ? tick % 2 : tick % 5 === 0 ? 1 : 0;
        draw(s.piece, s.x + px, s.y + py, frame);
      }
    }
    const riseP = full ? since(bt, 700, 600) : 1;
    if (bandStep[3] >= 1) {
      sctx.save();
      sctx.beginPath();
      sctx.rect(0, 0, L.sw, L.horizon + 6);
      sctx.clip();
      for (const kind of ["sun", "moon"] as const) {
        const b = skyBody(kind, hour);
        if (!b) continue;
        const rise = Math.round((1 - riseP) * (L.horizon + 8 - b.y));
        draw(kind, b.x + px, b.y + py + rise);
        hit(kind, 0, b.x + px, b.y + py + rise, b.w, b.h);
      }
      sctx.restore();
    }
    // A rainbow for a while after the rain, and the balloon on its slow crossing.
    if (settled && rainbowUntil > now) draw("rainbow", Math.round(L.sw * 0.12) + px, L.horizon - 40 + py);
    if (settled && live && now >= balloonStart) {
      const bx = -14 + Math.floor((now - balloonStart) / 200);
      if (bx < L.sw + 14) draw("balloon", bx + px, 56 + py);
    }

    // Clouds drift right by one pixel per period and wrap. A clicked cloud rains for a while.
    if (bt >= 1000) {
      L.clouds.forEach((c, i) => {
        const p = piece(c.piece);
        const span = L.sw + p.w;
        const x = ((c.x0 + Math.floor(t / c.period)) % span) - p.w + px;
        const y = c.y + py + (full && bt < 1060 ? 1 : 0);
        draw(c.piece, x, y, 0, c.flip);
        hit("cloud", i, x, y, p.w, p.h);
        if (c.rainUntil > now) {
          const tick = Math.floor(now / 60);
          const r = rng(tick * 7 + i);
          for (let k = 0; k < 3; k++) spawn("rain", x + 2 + Math.floor(r() * (p.w - 4)), y + p.h, Math.max(200, ((L.hedgeTop - y - p.h) / 3) * 50), 50, [0], [3], 1);
        }
      });
    }
    // A small flock crosses leftward by day, rests off screen a while, and scatters when clicked.
    if (daytime && live) {
      const span = L.sw + 260;
      const lead = L.sw + 40 - (Math.floor(t / 110) % span);
      const flap = Math.floor(t / 220);
      const y0 = Math.round(L.horizon * 0.44);
      const base: [number, number, number][] = [[0, 0, 0], [10, 4, 1], [20, 8, 0], [12, -5, 1]];
      const scatter = flock.scatterAt && now - flock.scatterAt < 1500 ? 1 - (now - flock.scatterAt) / 1500 : 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      base.forEach(([dx, dy, ph], i) => {
        const d = flock.deltas[i] ?? [0, 0];
        const x = lead + dx + px + Math.round(d[0] * scatter);
        const y = y0 + dy + py + Math.round(d[1] * scatter);
        draw("bird", x, y, (flap + ph + (scatter ? Math.floor(now / 90) : 0)) % 2);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 7);
        maxY = Math.max(maxY, y + 3);
      });
      if (lead > -30 && lead < L.sw) hit("birds", 0, minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);
    }

    // Far hills with the windmill and the village; near hills with sheep. Hills slide up in the boot.
    const farP = piece("hills_far");
    const nearP = piece("hills_near");
    const farLift = full ? Math.round((1 - since(bt, 1000, 350)) * (farP.h + 12)) : 0;
    const nearLift = full ? Math.round((1 - since(bt, 1150, 350)) * (nearP.h + 8)) : 0;
    if (bt >= 1000) {
      tileAcross("hills_far", L.farBottom - farP.h + farLift, farOff, true);
      if (settled) {
        const wx = L.windmill.x + farOff;
        const wy = L.farBottom - hillHeight("hills_far", L.windmill.x + 7, farOff) - 12;
        draw("windmill", wx, wy);
        const spin = windmillFast > now ? 150 : 600;
        draw("blades", wx + 1, wy - 5, Math.floor(t / spin) % 2);
        hit("windmill", 0, wx - 6, wy - 6, 26, 21);
        if (L.village.x < 0) {
          let best = Math.round(L.sw * 0.3);
          for (let x = 60; x < L.sw - 140; x += 2) {
            let ok = true;
            for (let k = 0; k < 30 && ok; k += 3) if (hillHeight("hills_near", x + k, 40) > 8) ok = false;
            if (ok) {
              best = x;
              break;
            }
          }
          L.village.x = best;
        }
        draw("village", L.village.x + farOff, L.farBottom - 4 - 9, Math.floor(t / 700) % 2);
      }
    }
    if (bt >= 1150) {
      tileAcross("hills_near", L.nearBottom - nearP.h + nearLift, nearOff, true);
      if (settled) {
        L.sheep.forEach((s, i) => {
          const sx = s.x + nearOff - 40;
          const sy = L.nearBottom - hillHeight("hills_near", s.x + 4, nearOff) - 4 - (sheepHop[i] > now ? 1 : 0);
          draw("sheep", sx, sy, Math.floor(t / 1700 + s.phase) % 2, i % 2 === 1);
          hit("sheep", i, sx, sy, 8, 5);
        });
      }
    }

    // Ground: the flat band dissolves in, then its tile, then a passing cloud shadow and the paths.
    const groundStep = full ? stepOf(bt, 900, 300, 6) : 6;
    if (groundStep > 0) {
      sctx.fillStyle = groundStep >= 6 ? rgb("g") : bayerPattern(rgb("g"), groundStep);
      sctx.fillRect(0, L.groundTop + 2, L.sw, L.sh - L.groundTop - 2);
    }
    if (groundStep >= 6) {
      const g = piece("ground");
      for (let y = L.groundTop + 2; y < L.sh; y += g.h) for (let x = 0; x < L.sw; x += g.w) draw("ground", x, y);
      if (live && now >= shadowStart) {
        const sx = -42 + Math.floor((now - shadowStart) / 70);
        if (sx < L.sw + 42) draw("cloud_shadow", sx, L.groundTop + 24);
      }
    }
    if (bt >= 1300) tileAcross("hedge", L.hedgeTop + (full && bt < 1340 ? 1 : 0), hedgeOff, false);
    if (bt >= 1600) {
      // The path wanders by a pixel per tile so it does not read as a plank; a fork climbs to the tea party.
      const pa = piece("path");
      const wobble = [0, 1, 1, 0, -1, -1];
      for (let x = L.path.from, i = 0; x < L.path.to; x += pa.w, i++) {
        const w = Math.min(pa.w, L.path.to - x);
        sctx.drawImage(img, pa.x, pa.y, w, pa.h, x, L.path.y + wobble[i % wobble.length], w, pa.h);
      }
      const pv = piece("path_v");
      for (let y = L.fork.from; y < L.fork.to; y += pv.h) draw("path_v", L.fork.x, y);
      for (const [dx, dy] of L.dirt) draw("dirt_patch", dx, dy);
    }
    if (bt >= 1250) {
      draw("mound", L.mound.x, L.mound.y);
      const doorOpen = doorOpenUntil > now;
      const arch = { x: L.mound.x + 50, y: L.mound.y + 29 - 16, w: 20, h: 16 };
      if (doorOpen) {
        if (Math.floor(now / 200) % 2 === 0) draw("eyes", arch.x + 8, arch.y + 7);
      } else {
        draw("door", arch.x, arch.y);
      }
      hit("door", 0, arch.x, arch.y, arch.w, arch.h);
      hit("chimney", 0, L.mound.x + 39, L.mound.y + 3, 9, 14);
      if (settled || bt >= 1400) draw("smoke", L.mound.x + 39, L.mound.y - 5, Math.floor(t / 700) % 2);
    }

    // Back row pops in left to right, one beat each; bushes puff up from the ground.
    const backOrder = L.back.map((it, i) => ({ it, i })).sort((a, b) => a.it.x - b.it.x);
    backOrder.forEach(({ it }, order) => {
      const start = 1350 + order * 60;
      if (bt < start) return;
      const p = piece(it.piece);
      if (it.kind === "bush") {
        const stage = full ? stepOf(bt, start, 210, 3) + 1 : 3;
        drawBottom(it.piece, it.x, it.y, Math.ceil((p.h * Math.min(3, stage)) / 3), 0, it.flip);
      } else {
        draw(it.piece, it.x, it.y + (full && bt < start + 60 ? 1 : 0), 0, it.flip);
      }
    });
    if (bt >= 1400) draw("pocket_watch", L.watch.x, L.watch.y, Math.floor(t / 1000) % 4);

    // The oak on the hedge line with its swing, and the cat's grin now and then.
    if (bt >= 1320) {
      const ox = L.oak.x + hedgeOff;
      const oy = L.oak.y + (full && bt < 1380 ? 2 : 0);
      draw("oak", ox, oy);
      hit("oak", 0, ox, oy, 47, 40);
      const swingFast = pressed?.hit?.kind === "swing";
      // The swing hangs from the branch on the left; its cell is 13 wide so the swung frame keeps both ropes.
      draw("swing", ox + 3, oy + 36, live ? Math.floor(t / (swingFast ? 250 : 900)) % 2 : 0);
      hit("swing", 0, ox + 3, oy + 36, 13, 17);
      const cf = cheshireFrame(now);
      if (cf >= 0) draw("cheshire", ox + 22, oy + 4, cf);
    }

    // The pond with its ducks, the fish that jumps, the flamingo and the croquet hoops.
    if (bt >= 1500) {
      draw("pond", L.pond.x, L.pond.y, live ? Math.floor(t / 600) % 2 : 0);
      hit("pond", 0, L.pond.x, L.pond.y + 7, 69, 20);
      const dy = L.pond.y + 12;
      const flipDuck = duck.dir < 0;
      const df = live ? Math.floor(t / 450) % 2 : 0;
      draw("duck", L.pond.x + duck.x, dy, df, flipDuck);
      for (let i = 1; i <= 3; i++) draw("duckling", L.pond.x + duck.x - duck.dir * (6 + i * 5) + (flipDuck ? 4 : 0), dy + 3, (df + i) % 2, flipDuck);
      if (fishStart) {
        const k = Math.floor((now - fishStart) / 110);
        const arc = [0, -3, -6, -8, -8, -6, -3, 0];
        if (k < arc.length) draw("fish", L.pond.x + 40, L.pond.y + 14 + arc[k], k < 4 ? 0 : 1);
        else if (k < arc.length + 3) draw("splash", L.pond.x + 40, L.pond.y + 12, k % 2);
        else fishStart = 0;
      }
      draw("flamingo", L.flamingo.x, L.flamingo.y, flamingoLeg);
      hit("flamingo", 0, L.flamingo.x, L.flamingo.y, 9, 17);
      for (const [hx, hy] of L.hoops) draw("hoop", hx, hy);
    }

    // The tea party, the roses being painted, the giant mushroom with its caterpillar.
    if (bt >= 1550) {
      const { x: tx, y: ty } = L.tea;
      draw("tea_table", tx, ty);
      const rattle = rattleUntil > now ? [1, 0, -1, 0][Math.floor(now / 60) % 4] : 0;
      draw("cup", tx + 29 + rattle, ty + 5);
      if (steamUntil > now) draw("steam", tx + 4, ty - 4, Math.floor(now / 300) % 2);
      hit("tea", 0, tx, ty - 4, 34, 20);
      const { x: rx, y: ry } = L.roses;
      draw("rose_bush", rx, ry);
      const slots: [number, number][] = [[3, 2], [9, 1], [15, 2]];
      slots.forEach(([sx, sy], i) => {
        draw(roses[i] === "r" ? "rose_r" : "rose_w", rx + sx, ry + sy);
        if (dripAtRose === i && dripAt + 3000 > now) draw("drip", rx + sx + 1, ry + sy + 3 + Math.min(4, Math.floor((now - dripAt) / 600)));
      });
      draw("bucket", rx + 24, L.groundTop - 5);
      hit("roses", 0, rx, ry, 32, 12);
      const { x: gx, y: gy } = L.giant;
      draw("giant_mushroom", gx, gy);
      draw("caterpillar", gx + 8, gy - 4, live ? Math.floor(t / 800) % 2 : 0);
      hit("giant", 0, gx, gy - 4, 29, 34);
    }

    // The card soldiers on their patrol along the hedge path.
    if (settled && cards.start) {
      const walked = Math.floor((now - cards.start) / 120);
      const lead = cards.dir > 0 ? -14 + walked : L.sw + 14 - walked;
      if (lead < -30 || lead > L.sw + 30) cards.start = 0;
      else {
        const step = Math.floor(now / 240) % 2;
        const y = L.groundTop + 6 - 15;
        [["card_hearts", 0], ["card_spades", 1]].forEach(([name, i]) => {
          const cx = lead - cards.dir * 16 * (i as number);
          const frame = cards.salute[i as number] > now ? 2 : step;
          draw(name as string, cx, y, frame, cards.dir < 0);
          hit("card", i as number, cx, y, 11, 15);
        });
      }
    }

    // The carrot patch, then the middle rows sorted by their feet, then the concept row, then the arrow sign.
    if (bt >= 1600) {
      L.carrots.forEach((c, i) => {
        const pop = full && bt < 1660 ? 1 : 0;
        if (c.stage === "grown") {
          draw("carrot_top", c.x, c.y + pop);
          hit("carrot", i, c.x - 1, c.y - 1, 9, 8);
        } else if (c.stage === "sprout") {
          draw("sprout", c.x + 1, c.y + 1 + pop);
        }
      });
    }
    const sorted = L.ground.map((it, i) => ({ it, i })).sort((a, b) => a.it.y + piece(a.it.piece).h - (b.it.y + piece(b.it.piece).h));
    for (const { it, i } of sorted) {
      const p = piece(it.piece);
      const start = 1400 + (it.kind === "tuft" ? 0 : 100) + Math.round((it.x / L.sw) * 300);
      if (bt < start) continue;
      let frame = it.sways && live ? Math.floor(t / 650 + it.phase) % 2 : 0;
      let dy = 0;
      if (it.fx && it.fx.until > now) {
        const age = now - it.fx.at;
        if (it.fx.kind === "bloom") frame = 1;
        if (it.fx.kind === "wiggle") frame = Math.floor(age / 80) % 2;
        if (it.fx.kind === "bounce") dy = [-2, -1, 0, -2, -1, 0][Math.min(5, Math.floor(age / 70))];
      } else if (it.fx) {
        it.fx = undefined;
      }
      if (full) {
        if (it.kind === "tuft") {
          const stage = stepOf(bt, start, 210, 3) + 1;
          if (stage < 3) {
            drawBottom(it.piece, it.x, it.y, stage === 1 ? 1 : Math.ceil(p.h / 2), 0, it.flip);
            continue;
          }
        } else if (it.kind === "flower" && bt < start + 150) {
          frame = 1;
        } else if (it.kind === "mush") {
          dy = [-2, -1, 0][Math.min(2, Math.floor((bt - start) / 60))];
        }
      }
      draw(it.piece, it.x, it.y + dy, frame, it.flip);
      hit("item", i, it.x - 1, it.y + dy - 1, p.w + 2, p.h + 2);
    }
    if (bt >= 1600) {
      concepts.forEach((c, i) => {
        const p = piece(c.piece);
        const frame = p.frames > 1 && live ? Math.floor(t / 900 + c.phase) % 2 : 0;
        draw(c.piece, c.x, c.y + (full && bt < 1660 ? 1 : 0), frame);
        hit("concept", i, c.x - 1, c.y - 2, p.w + 2, p.h + 3, c.label);
      });
      draw("arrow_sign", L.arrow.x, L.arrow.y);
      hit("arrow", 0, L.arrow.x, L.arrow.y, 16, 15, "This way to the burrow");
    }

    // Butterflies and bees by day: quick whole pixel flutters over the flowers.
    if ((tod === "day" || tod === "morning") && live) {
      const tick = Math.floor(t / 130);
      if (tick !== butterflyTick) {
        butterflyTick = tick;
        const r = rng(tick * 977 + 3);
        for (const b of butters) {
          if (r() < 0.7) b.x = Math.min(L.sw - 104, Math.max(6, b.x + (r() < 0.5 ? -1 : 1)));
          if (r() < 0.6) b.y = Math.min(L.sh - 20, Math.max(L.groundTop - 6, b.y + (r() < 0.5 ? -1 : 1)));
        }
      }
      butters.forEach((b, i) => draw(i % 2 ? "butterfly_w" : "butterfly_y", b.x, b.y, (tick + b.phase) % 2));
      const btick = Math.floor(t / 100);
      if (btick !== beeTick) {
        beeTick = btick;
        const r = rng(btick * 613 + 9);
        for (const b of bees) {
          const hx = b.hx ?? b.x;
          const hy = b.hy ?? b.y;
          b.x += r() < 0.5 ? -1 : 1;
          b.y += r() < 0.4 ? (r() < 0.5 ? -1 : 1) : 0;
          if (Math.abs(b.x - hx) > 6) b.x += b.x > hx ? -2 : 2;
          if (Math.abs(b.y - hy) > 4) b.y += b.y > hy ? -2 : 2;
        }
      }
      bees.forEach((b) => draw("bee", b.x, b.y, (btick + b.phase) % 2));
    }
    // Fireflies at night: whole pixel wanders, blinking on a phase.
    if (tod === "night" && flies.length && settled) {
      const tick = Math.floor(t / 250);
      if (motion && tick !== fireflyTick) {
        fireflyTick = tick;
        const r = rng(tick * 131 + 17);
        for (const f of flies) {
          if (r() < 0.6) f.x = Math.min(L.sw - 100, Math.max(6, f.x + (r() < 0.5 ? -1 : 1)));
          if (r() < 0.5) f.y = Math.min(L.sh - 10, Math.max(L.groundTop - 34, f.y + (r() < 0.5 ? -1 : 1)));
        }
      }
      for (const f of flies) draw("firefly", f.x, f.y, (tick + f.phase) % 9 < 5 ? 0 : 1);
    }
    if (rainUntil > now && live) {
      const tick = Math.floor(t / 45);
      for (const d of L.rain) draw("rain", d.x, ((d.y0 + tick * 3) % (L.sh + 3)) - 3);
    }

    // Particles, then whatever the kid is carrying.
    stepParticles(now);
    drawParticles(now);
    if (drag?.kind === "carrot") {
      const p = piece("carrot");
      draw("carrot", drag.x - Math.floor(p.w / 2), drag.y - Math.floor(p.h / 2));
    }

    // Quick boot: the finished picture dissolves in over the earth.
    if (quick) {
      const step = stepOf(boot.elapsed, 0, 420, 6);
      if (step < 6) {
        sctx.globalCompositeOperation = "destination-out";
        sctx.fillStyle = bayerPattern(null, step);
        sctx.fillRect(0, 0, L.sw, L.sh);
        sctx.globalCompositeOperation = "destination-over";
        paintEarth();
        sctx.globalCompositeOperation = "source-over";
      }
    }

    if (fade) {
      const step = Math.floor((now - fade.at) / FADE_STEP_MS);
      if (step >= 7 || old.width !== L.sw || old.height !== L.sh) fade = null;
      else {
        // Erase the cells the mask has reached so far, then lay what is left over the new picture.
        octx.globalCompositeOperation = "destination-out";
        octx.fillStyle = bayerPattern("#000", step);
        octx.fillRect(0, 0, old.width, old.height);
        octx.globalCompositeOperation = "source-over";
        sctx.globalCompositeOperation = "source-over";
        sctx.drawImage(old, 0, 0);
      }
    }
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, L.sw, L.sh, 0, 0, L.sw * SCALE, L.sh * SCALE);
    canvas.dataset.ready = "1";
  };

  /** The cat's frame for this moment: the smile, then the eyes, then the whole cat, and back to the smile. -1 when hidden. */
  function cheshireFrame(now: number): number {
    if (!cheshireAt) return -1;
    const age = now - cheshireAt;
    if (age < 400) return 0;
    if (age < 900) return 1;
    if (age < 3700) return 2;
    if (age < 4300) return 1;
    if (age < 5000) return 0;
    cheshireAt = 0;
    return -1;
  }

  /* ---------- reactions ---------- */

  const petCenter = (): { x: number; y: number } | null => {
    const r = opts.getPetRect();
    return r ? { x: Math.round((r.left + r.width / 2) / SCALE), y: Math.round((r.top + r.height / 2) / SCALE) } : null;
  };

  const pet = (): void => {
    const now = performance.now();
    if (now - lastPetAt < PET_GAP_MS) return;
    const r = opts.getPetRect();
    if (!r) return;
    lastPetAt = now;
    overPetSince = now;
    stroke = 0;
    hearts(Math.round((r.left + r.width / 2) / SCALE), Math.round(r.top / SCALE) + 4);
    send("burrow:play", { state: "wave" });
    blipFor("heart");
  };

  const feed = (): void => {
    const c = petCenter();
    if (c) sparkles(c.x, c.y);
    send("burrow:play", { state: "celebrate" });
    blipFor("munch");
  };

  const happen = (name: string): void => {
    const now = performance.now();
    const L = lay!;
    switch (name) {
      case "cards":
        if (!cards.start) {
          cards.start = now;
          cards.dir = chance() < 0.5 ? 1 : -1;
        }
        return;
      case "cheshire":
        cheshireAt = now;
        return;
      case "fish":
        fishStart = now;
        return;
      case "gust":
        gust();
        return;
      case "balloon":
        balloonStart = now;
        return;
      case "rainbow":
        rainbowUntil = now + RAINBOW_MS;
        return;
      case "shadow":
        shadowStart = now;
        return;
      case "rings":
        for (let i = 0; i < 3; i++) window.setTimeout(() => smokeRing(L.giant.x + 19, L.giant.y - 6), i * 350);
        return;
      default:
        return;
    }
  };

  const react = (h: Hit): void => {
    const L = lay!;
    const now = performance.now();
    switch (h.kind) {
      case "item": {
        const it = L.ground[h.index];
        if (it.kind === "flower") {
          it.fx = { kind: "bloom", at: now, until: now + 1500 };
          petals(it);
          blipFor("bloom");
        } else if (it.kind === "mush") {
          it.fx = { kind: "bounce", at: now, until: now + 420 };
          blipFor("bounce");
        } else {
          it.fx = { kind: "wiggle", at: now, until: now + 600 };
          blipFor("wiggle");
        }
        return;
      }
      case "cloud":
        L.clouds[h.index].rainUntil = now + 3000;
        blipFor("rain");
        return;
      case "birds":
        flock.scatterAt = now;
        flock.deltas = [[-12, -9], [14, -6], [-6, 10], [10, 12]];
        blipFor("chirp");
        return;
      case "chimney":
        smokeRing(L.mound.x + 41, L.mound.y + 2);
        blipFor("puff");
        return;
      case "door":
        doorOpenUntil = now + 1000;
        blipFor("creak");
        return;
      case "concept": {
        const c = concepts[h.index];
        const r = opts.getPetRect();
        const y = r ? r.top + r.height / 2 : window.innerHeight - 110;
        send("burrow:goto", { x: (c.x + Math.floor(piece(c.piece).w / 2)) * SCALE, y: Math.round(y) });
        send("burrow:play", { state: "thinking" });
        window.setTimeout(() => send("burrow:play", { state: "idle" }), 2800);
        blipFor("bloom");
        return;
      }
      case "pond":
        fishStart = now;
        blipFor("splash");
        return;
      case "flamingo":
        flamingoLeg = 1 - flamingoLeg;
        flamingoAt = now + between(6000, 12_000);
        blipFor("honk");
        return;
      case "oak":
        cheshireAt = now;
        blipFor("creak");
        return;
      case "swing":
        blipFor("wiggle");
        return;
      case "tea":
        steamUntil = now + 3000;
        rattleUntil = now + 600;
        blipFor("rattle");
        return;
      case "roses": {
        const i = roses.indexOf("w");
        if (i >= 0) {
          roses[i] = "r";
          dripAt = now;
          dripAtRose = i;
          blipFor("paint");
        } else {
          roses.fill("w");
          dripAtRose = -1;
          blipFor("wiggle");
        }
        return;
      }
      case "giant":
        happen("rings");
        blipFor("puff");
        return;
      case "card":
        cards.salute[h.index] = now + 1000;
        blipFor("salute");
        return;
      case "sheep":
        sheepHop[h.index] = now + 220;
        blipFor("baa");
        return;
      case "windmill":
        windmillFast = now + 3000;
        blipFor("wiggle");
        return;
      case "arrow": {
        const r = opts.getPetRect();
        const y = r ? r.top + r.height / 2 : window.innerHeight - 110;
        send("burrow:goto", { x: (L.sw - 21) * SCALE, y: Math.round(y) });
        blipFor("pick");
        return;
      }
      default:
        return;
    }
  };

  /* ---------- pointer ---------- */

  const toSrc = (e: { clientX: number; clientY: number }): { x: number; y: number } => ({ x: Math.floor(e.clientX / SCALE), y: Math.floor(e.clientY / SCALE) });
  const hitAt = (x: number, y: number): Hit | null => {
    for (let i = hits.length - 1; i >= 0; i--) if (inRect(x, y, hits[i])) return hits[i];
    return null;
  };
  const setCursor = (kind: "arrow" | "hand" | "grab"): void => {
    if (cursorKind === kind) return;
    cursorKind = kind;
    const hot = { arrow: "1 1", hand: "10 1", grab: "16 16" }[kind];
    canvas.style.cursor = `url("scene/cursor_${kind}.png") ${hot}, auto`;
  };
  const noteInteraction = (): void => {
    if (interacted) return;
    interacted = true;
    opts.onInteract?.();
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !lay || !opts.getBoot().done) return;
    noteInteraction();
    const { x, y } = toSrc(e);
    const h = hitAt(x, y);
    pressed = { hit: h, x, y, moved: false };
    if (h?.kind === "carrot") {
      lay.carrots[h.index].stage = "held";
      drag = { kind: "carrot", index: h.index, x, y };
      setCursor("grab");
      blipFor("pick");
      e.preventDefault();
    } else if (h?.kind === "sun" || h?.kind === "moon") {
      drag = { kind: h.kind, index: 0, x, y };
      scrub = { hour: shownHour(), heldUntil: Infinity };
      setCursor("grab");
      e.preventDefault();
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!lay) return;
    mx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    my = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    const L = lay;
    const { x, y } = toSrc(e);
    // Resting on the rabbit, or stroking across him, counts as petting.
    const r = opts.getPetRect();
    const now = performance.now();
    if (r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
      if (!overPetSince) overPetSince = now;
      else if (pointer.x >= 0) stroke += Math.abs(e.clientX - pointer.x) + Math.abs(e.clientY - pointer.y);
      if (stroke >= PET_STROKE_PX) pet();
    } else {
      overPetSince = 0;
      stroke = 0;
    }
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    if (drag) {
      drag.x = x;
      drag.y = y;
      if (drag.kind !== "carrot") {
        const w = piece(drag.kind).w;
        const f = Math.max(0, Math.min(1, (x - 20 - Math.floor(w / 2)) / (L.sw - 40 - w)));
        scrub = { hour: drag.kind === "sun" ? 6 + 16 * f : (22 + 8 * f) % 24, heldUntil: Infinity };
      }
      return;
    }
    if (pressed && (Math.abs(x - pressed.x) > 1 || Math.abs(y - pressed.y) > 1)) pressed.moved = true;
    const h = e.target === canvas ? hitAt(x, y) : null;
    setCursor(h ? (h.kind === "sun" || h.kind === "moon" || h.kind === "carrot" ? "grab" : "hand") : "arrow");
    const labeled = h?.label ? h : null;
    if ((labeled?.kind ?? null) !== (hoveredHit?.kind ?? null) || labeled?.index !== hoveredHit?.index) {
      hoveredHit = labeled;
      announceHover();
    }
  };

  const announceHover = (): void => {
    if (hoveredHit?.label) {
      opts.onHover?.({ label: hoveredHit.label, left: hoveredHit.x * SCALE, top: hoveredHit.y * SCALE, width: hoveredHit.w * SCALE, height: hoveredHit.h * SCALE });
      return;
    }
    const c = concepts.find((k) => k.pinned);
    if (!c) {
      opts.onHover?.(null);
      return;
    }
    const p = piece(c.piece);
    opts.onHover?.({ label: c.label, left: c.x * SCALE, top: c.y * SCALE, width: p.w * SCALE, height: p.h * SCALE, pinned: true });
  };

  const onUp = (e: PointerEvent): void => {
    if (!lay) return;
    const L = lay;
    if (drag) {
      if (drag.kind === "carrot") {
        const c = L.carrots[drag.index];
        const r = opts.getPetRect();
        if (r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
          c.stage = "gone";
          c.at = performance.now();
          feed();
        } else {
          c.stage = "grown";
        }
      } else if (scrub) {
        scrub.heldUntil = performance.now() + SCRUB_HOLD_MS;
      }
      drag = null;
      pressed = null;
      setCursor("arrow");
      return;
    }
    if (pressed && !pressed.moved && pressed.hit) react(pressed.hit);
    pressed = null;
  };

  const onLeave = (): void => {
    overPetSince = 0;
    stroke = 0;
  };

  /* ---------- ticks ---------- */

  const setTod = async (next: Tod): Promise<void> => {
    if (!man) return;
    const image = atlases[next] ?? (await loadImage(`scene/${man.atlas.files[next]}`));
    atlases[next] = image;
    if (stopped || tod === next) return;
    // Not the first light: keep the picture as it is and dither it away over the new one, so a
    // dragged sun crossing into day does not snap the hills and the grass.
    if (tod && lay && motion) {
      old.width = lay.sw;
      old.height = lay.sh;
      octx.clearRect(0, 0, old.width, old.height);
      octx.drawImage(src, 0, 0);
      fade = { at: performance.now() };
    }
    img = image;
    tod = next;
    canvas.dataset.tod = next;
    const gc = man.palettes[next].g;
    opts.onPalette?.(next, `rgb(${gc[0]},${gc[1]},${gc[2]})`);
  };

  let timer = 0;
  let loadingTod: Tod | null = null;
  const tick = (): void => {
    if (stopped || !lay) return;
    const now = performance.now();
    // Ease the scrubbed light back to the real hour, one whole hour at a time.
    if (scrub && now > scrub.heldUntil && now > easeAt) {
      easeAt = now + 350;
      const target = opts.hour();
      const d = ((target - scrub.hour + 36) % 24) - 12;
      if (Math.abs(d) < 1) scrub = null;
      else scrub.hour = (scrub.hour + Math.sign(d) + 24) % 24;
    }
    const want = todFor(shownHour());
    if (want !== tod && want !== loadingTod) {
      loadingTod = want;
      void setTod(want).then(() => {
        loadingTod = null;
      });
    }
    // Resting on him long enough is a pat.
    if (overPetSince && now - overPetSince >= PET_HOLD_MS) pet();
    // Carrots regrow: a sprout at ten seconds, the whole carrot at twenty.
    for (const c of lay.carrots) {
      if (c.stage === "gone" && now - c.at > REGROW_MS / 2) c.stage = "sprout";
      else if (c.stage === "sprout" && now - c.at > REGROW_MS) c.stage = "grown";
    }
    if (motion && opts.getBoot().done) {
      // The inhabitants keep their own time: ducks paddle, the fish jumps, the flamingo shifts, the cards
      // patrol, the cat smiles, the caterpillar puffs, the balloon and the cloud shadow cross, gusts blow.
      const dt = Math.floor(now / 450);
      if (dt !== duck.tick) {
        duck.tick = dt;
        duck.x += duck.dir;
        if (duck.x >= 54) duck.dir = -1;
        if (duck.x <= 12) duck.dir = 1;
      }
      if (now >= fishAt) {
        fishStart = now;
        fishAt = now + between(20_000, 40_000);
      }
      if (now >= flamingoAt) {
        flamingoLeg = 1 - flamingoLeg;
        flamingoAt = now + between(6000, 12_000);
      }
      if (!cards.start && now >= cards.nextAt) {
        cards.start = now;
        cards.dir = chance() < 0.5 ? 1 : -1;
        cards.nextAt = now + between(180_000, 300_000);
      }
      if (!cheshireAt && now >= cheshireNext) {
        cheshireAt = now;
        cheshireNext = now + between(50_000, 90_000);
      }
      if (now >= ringsAt) {
        smokeRing(lay.giant.x + 19, lay.giant.y - 6);
        ringsAt = now + 5000;
      }
      if (now >= gustAt) {
        gust();
        gustAt = now + between(30_000, 50_000);
      }
      if (now - balloonStart > 200 * (lay.sw + 30) + 240_000) balloonStart = now;
      if (now - shadowStart > 70 * (lay.sw + 84) + 30_000) shadowStart = now;
      if (rainUntil && now >= rainUntil) {
        rainUntil = 0;
        rainbowUntil = now + RAINBOW_MS;
      }
    }
    if (document.hidden) return;
    render();
  };

  const onResize = (): void => {
    if (ensureSize()) {
      announceHover();
      render();
    }
  };

  const rectOf = (x: number, y: number, w: number, h: number): Rect => ({ x: x * SCALE, y: y * SCALE, width: w * SCALE, height: h * SCALE });
  const api: MeadowApi = {
    particles: () => particles.length,
    particleXY: () => particles.map((p) => [p.x, p.y] as [number, number]),
    carrots: () => lay?.carrots.filter((c) => c.stage === "grown").length ?? 0,
    concepts: () => concepts.filter((c) => !c.pinned).length,
    reactions: () => (lay?.ground.filter((it) => it.fx && it.fx.until > performance.now()).length ?? 0) + (doorOpenUntil > performance.now() ? 1 : 0),
    carrotRect: (i) => {
      const c = lay?.carrots[i];
      return c && c.stage === "grown" ? rectOf(c.x, c.y, 7, 6) : null;
    },
    conceptRect: (i) => {
      const c = concepts[i];
      if (!c || !man) return null;
      const p = piece(c.piece);
      return rectOf(c.x, c.y, p.w, p.h);
    },
    sunRect: () => {
      const b = man && lay ? skyBody("sun", shownHour()) : null;
      return b ? rectOf(b.x, b.y, b.w, b.h) : null;
    },
    moonRect: () => {
      const b = man && lay ? skyBody("moon", shownHour()) : null;
      return b ? rectOf(b.x, b.y, b.w, b.h) : null;
    },
    oakRect: () => (lay ? rectOf(lay.oak.x, lay.oak.y, 47, 40) : null),
    shownHour,
    bootElapsed: () => opts.getBoot().elapsed,
    weather: () => (rainUntil > performance.now() ? "rain" : "clear"),
    event: (name) => {
      if (lay && man) happen(name);
    },
    cheshireFrame: () => cheshireFrame(performance.now()),
    cardsX: () => (cards.start ? (cards.dir > 0 ? -14 + Math.floor((performance.now() - cards.start) / 120) : (lay?.sw ?? 0) + 14 - Math.floor((performance.now() - cards.start) / 120)) * SCALE : null),
  };

  void fetch("scene/manifest.json")
    .then((r) => r.json())
    .then(async (m: SceneManifest) => {
      if (stopped) return;
      man = m;
      ensureSize();
      await setTod(todFor(shownHour()));
      // The other palettes load in the background so dragging the sun never waits.
      for (const k of Object.keys(m.atlas.files) as Tod[]) if (!atlases[k]) void loadImage(`scene/${m.atlas.files[k]}`).then((im) => (atlases[k] = im)).catch(() => undefined);
      announceHover();
      window.addEventListener("resize", onResize);
      canvas.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      document.addEventListener("pointerleave", onLeave);
      setCursor("arrow");
      timer = window.setInterval(tick, motion ? 50 : 100);
      render();
    })
    .catch((e) => console.warn("[newtab] scene failed to load", e));

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerleave", onLeave);
    },
    setGraph: (g) => {
      graphSnapshot = g;
      if (man && lay) {
        plantConcepts();
        hoveredHit = null;
        announceHover();
        render();
      }
    },
    api,
  };
}
