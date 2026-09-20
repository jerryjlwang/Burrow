/**
 * Photo to pixel sprite. Pure functions over RGBA rasters, no DOM, so the maker page and the tests
 * share them. `makeCharacter` takes a cut-out photo and returns a manifest plus one strip per state,
 * built from a single base sprite with whole-pixel moves: shifts, squashes, leans, a hole, a few glyphs.
 * The rabbit's contract states are all there (docs/frontend/CHARACTER_MANIFEST.md), so the player,
 * the hops and the hole trips work unchanged.
 */

import type { CharacterManifest, StateDef } from "./manifest";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row major. */
  data: Uint8ClampedArray;
}

export type RGB = [number, number, number];

/** Same cell and feet line as the rabbit, so the dock, bubble and hole line up. */
export const CELL: [number, number] = [64, 58];
/** Last row the rim may touch is 54; feet end at row 53 like the rabbit's. */
const FLOOR = 55;
/** Hole pixels stay in rows 50 to 55, as the rabbit's audit requires. */
const HOLE_TOP = 50;
const HOLE_CY = 53;
const HOLE_RX = 13;
const HOLE_RY = 2;
/** Room to lean sideways and hop up without leaving the cell. */
export const MAX_SPRITE_W = 44;
export const MAX_SPRITE_H = 44;

export const INK: RGB = [59, 42, 35];
/** Below this luminance a source pixel counts as drawn ink when shrinking. */
const INK_LUMA = 90;
export const CREAM: RGB = [255, 250, 240];
const HOLE_DARK: RGB = [38, 26, 22];
const HOLE_EDGE: RGB = [110, 78, 52];

export function raster(width: number, height: number): Raster {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function clone(r: Raster): Raster {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

function px(r: Raster, x: number, y: number): number {
  return (y * r.width + x) * 4;
}

function opaque(r: Raster, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < r.width && y < r.height && r.data[px(r, x, y) + 3] > 0;
}

function set(r: Raster, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = px(r, x, y);
  r.data[i] = c[0];
  r.data[i + 1] = c[1];
  r.data[i + 2] = c[2];
  r.data[i + 3] = a;
}

/* ---------- 1. background cut ---------- */

function dist2(a: Uint8ClampedArray, i: number, c: RGB): number {
  const dr = a[i] - c[0];
  const dg = a[i + 1] - c[1];
  const db = a[i + 2] - c[2];
  return dr * dr + dg * dg + db * db;
}

/** Mean colour of the outer ring of pixels: what the photo's background most likely is. */
export function borderColor(r: Raster): RGB {
  let n = 0;
  const sum = [0, 0, 0];
  const add = (x: number, y: number) => {
    const i = px(r, x, y);
    sum[0] += r.data[i];
    sum[1] += r.data[i + 1];
    sum[2] += r.data[i + 2];
    n++;
  };
  for (let x = 0; x < r.width; x++) {
    add(x, 0);
    if (r.height > 1) add(x, r.height - 1);
  }
  for (let y = 1; y < r.height - 1; y++) {
    add(0, y);
    if (r.width > 1) add(r.width - 1, y);
  }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : [255, 255, 255];
}

/**
 * Clears everything reachable from the edges that is within `tolerance` (0..255 colour distance)
 * of the border colour, then keeps only the largest blob so specks of background do not become
 * floating pixels. Returns a copy.
 */
export function cutBackground(src: Raster, tolerance: number, bg: RGB = borderColor(src)): Raster {
  const r = clone(src);
  const { width: w, height: h, data } = r;
  const tol2 = tolerance * tolerance;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const k = y * w + x;
    if (seen[k]) return;
    seen[k] = 1;
    if (dist2(data, k * 4, bg) > tol2) return;
    stack.push(k);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const k = stack.pop()!;
    data[k * 4 + 3] = 0;
    const x = k % w;
    const y = (k - x) / w;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return keepLargestBlob(r);
}

/** Keeps the biggest 4-connected opaque region and clears the rest. In place; returns `r`. */
export function keepLargestBlob(r: Raster): Raster {
  const { width: w, height: h, data } = r;
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] >= 0 || data[start * 4 + 3] === 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k % w;
      const y = (k - x) / w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (label[nk] >= 0 || data[nk * 4 + 3] === 0) continue;
        label[nk] = id;
        stack.push(nk);
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return r;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  for (let k = 0; k < w * h; k++) if (label[k] >= 0 && label[k] !== best) data[k * 4 + 3] = 0;
  return r;
}

/* ---------- 2. crop and shrink ---------- */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Bounding box of the opaque pixels (right and bottom exclusive), or null when there are none. */
export function opaqueBox(r: Raster): Box | null {
  let left = r.width;
  let top = r.height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[px(r, x, y) + 3] === 0) continue;
      if (x < left) left = x;
      if (x >= right) right = x + 1;
      if (y < top) top = y;
      if (y >= bottom) bottom = y + 1;
    }
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

export function crop(r: Raster, b: Box): Raster {
  const out = raster(b.right - b.left, b.bottom - b.top);
  for (let y = 0; y < out.height; y++) {
    const from = px(r, b.left, b.top + y);
    out.data.set(r.data.subarray(from, from + out.width * 4), y * out.width * 4);
  }
  return out;
}

/**
 * Majority-vote shrink. A target pixel is opaque when at least half of its source box is, and takes
 * the most common colour among the opaque source pixels, so a pupil or an outline survives instead
 * of being averaged into its surroundings. Meant for an already quantized raster.
 */
export function shrink(r: Raster, width: number, height: number): Raster {
  const out = raster(width, height);
  const sx = r.width / width;
  const sy = r.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let n = 0;
      let on = 0;
      let dark = 0;
      let darkest = -1;
      let darkestLuma = 256;
      const votes = new Map<number, number>();
      for (let yy = y0; yy < y1 && yy < r.height; yy++) {
        for (let xx = x0; xx < x1 && xx < r.width; xx++) {
          n++;
          const i = px(r, xx, yy);
          if (r.data[i + 3] === 0) continue;
          on++;
          const key = (r.data[i] << 16) | (r.data[i + 1] << 8) | r.data[i + 2];
          votes.set(key, (votes.get(key) ?? 0) + 1);
          const l = r.data[i] * 0.299 + r.data[i + 1] * 0.587 + r.data[i + 2] * 0.114;
          if (l < INK_LUMA) {
            dark++;
            if (l < darkestLuma) {
              darkestLuma = l;
              darkest = key;
            }
          }
        }
      }
      if (!n || on * 2 < n) continue;
      let best = -1;
      let count = 0;
      // A drawn line thinner than a source box would lose a fair vote; ink wins from a quarter.
      if (dark * 4 >= on && darkest >= 0) best = darkest;
      else
        for (const [key, c] of votes) {
          if (c > count) {
            count = c;
            best = key;
          }
        }
      set(out, x, y, [(best >> 16) & 255, (best >> 8) & 255, best & 255]);
    }
  }
  return out;
}

/* ---------- 3. palette ---------- */

/** Median-cut palette of the opaque pixels, at most `count` colours. */
export function palette(r: Raster, count: number): RGB[] {
  const pts: RGB[] = [];
  // Every pixel up to about 20k of them, then a regular sample: the cut is what matters, not each pixel.
  const stride = Math.max(1, Math.floor((r.width * r.height) / 20000));
  for (let i = 0; i < r.data.length; i += 4 * stride) if (r.data[i + 3] > 0) pts.push([r.data[i], r.data[i + 1], r.data[i + 2]]);
  if (!pts.length) return [];
  let boxes: RGB[][] = [pts];
  while (boxes.length < count) {
    let pick = -1;
    let range = -1;
    let axis = 0;
    for (let b = 0; b < boxes.length; b++) {
      if (boxes[b].length < 2) continue;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const p of boxes[b]) {
          if (p[c] < lo) lo = p[c];
          if (p[c] > hi) hi = p[c];
        }
        if (hi - lo > range) {
          range = hi - lo;
          pick = b;
          axis = c;
        }
      }
    }
    if (pick < 0 || range < 8) break;
    const box = boxes[pick].sort((a, b) => a[axis] - b[axis]);
    const mid = box.length >> 1;
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => {
    const s = [0, 0, 0];
    for (const p of box) {
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
    }
    return [Math.round(s[0] / box.length), Math.round(s[1] / box.length), Math.round(s[2] / box.length)] as RGB;
  });
}

/** Snaps every opaque pixel to its nearest palette colour, with a mild contrast lift so it reads as pixel art. */
export function quantize(r: Raster, colors: RGB[]): Raster {
  const out = clone(r);
  if (!colors.length) return out;
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < colors.length; c++) {
      const d = dist2(out.data, i, colors[c]);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    out.data[i] = colors[best][0];
    out.data[i + 1] = colors[best][1];
    out.data[i + 2] = colors[best][2];
  }
  return out;
}

/* ---------- 4. outline and rim ---------- */

/** Adds a one pixel ring of `color` around every opaque pixel (grows the raster by one on each side). */
export function ring(r: Raster, color: RGB): Raster {
  const out = raster(r.width + 2, r.height + 2);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (opaque(r, x, y)) out.data.set(r.data.subarray(px(r, x, y), px(r, x, y) + 4), px(out, x + 1, y + 1));
  const grown = clone(out);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      if (opaque(out, x, y)) continue;
      if (opaque(out, x - 1, y) || opaque(out, x + 1, y) || opaque(out, x, y - 1) || opaque(out, x, y + 1)) set(grown, x, y, color);
    }
  }
  return grown;
}

/* ---------- 5. whole-pixel moves ---------- */

/** Draws `src` into `dst` with its top left at (x, y); rows below `clipY` are skipped (the hole swallows them). */
export function blit(dst: Raster, src: Raster, x: number, y: number, clipY = Infinity): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height || dy >= clipY) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const i = px(src, sx, sy);
      if (src.data[i + 3] === 0) continue;
      dst.data.set(src.data.subarray(i, i + 4), px(dst, dx, dy));
    }
  }
}

/** Nearest-neighbour resample to an exact size (a squash or a stretch). */
export function resample(r: Raster, width: number, height: number): Raster {
  const out = raster(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(r.height - 1, Math.floor(((y + 0.5) * r.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(r.width - 1, Math.floor(((x + 0.5) * r.width) / width));
      const i = px(r, sx, sy);
      if (r.data[i + 3] > 0) out.data.set(r.data.subarray(i, i + 4), px(out, x, y));
    }
  }
  return out;
}

/** Leans the sprite: each row slides sideways in proportion to its height above the feet. Positive leans right. */
export function lean(r: Raster, amount: number): Raster {
  const pad = Math.abs(amount);
  const out = raster(r.width + pad * 2, r.height);
  for (let y = 0; y < r.height; y++) {
    const shift = Math.round((amount * (r.height - 1 - y)) / Math.max(1, r.height - 1));
    for (let x = 0; x < r.width; x++) {
      const i = px(r, x, y);
      if (r.data[i + 3] > 0) out.data.set(r.data.subarray(i, i + 4), px(out, x + pad + shift, y));
    }
  }
  return out;
}

export function flip(r: Raster): Raster {
  const out = raster(r.width, r.height);
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) out.data.set(r.data.subarray(px(r, x, y), px(r, x, y) + 4), px(out, r.width - 1 - x, y));
  return out;
}

/* ---------- 6. hole and glyphs ---------- */

function hole(cell: Raster, open: number): void {
  if (open <= 0) return;
  const rx = Math.max(1, Math.round(HOLE_RX * open));
  const ry = Math.max(1, Math.round(HOLE_RY * open));
  const cx = Math.floor(cell.width / 2);
  for (let y = -ry - 1; y <= ry + 1; y++) {
    for (let x = -rx - 1; x <= rx + 1; x++) {
      const inside = (x * x) / (rx * rx) + (y * y) / (ry * ry);
      const yy = HOLE_CY + y;
      if (yy < HOLE_TOP || yy > FLOOR) continue;
      if (inside <= 1) set(cell, cx + x, yy, HOLE_DARK);
      else if ((x * x) / ((rx + 1) * (rx + 1)) + (y * y) / ((ry + 1) * (ry + 1)) <= 1) set(cell, cx + x, yy, HOLE_EDGE);
    }
  }
}

const GLYPHS: Record<string, string[]> = {
  "?": ["0110", "1001", "0001", "0010", "0100", "0000", "0100"],
  "!": ["1", "1", "1", "1", "1", "0", "1"],
  z: ["1111", "0001", "0010", "0100", "1111"],
  ".": ["1"],
};

/** Draws a glyph with a one pixel cream halo so it reads on light and dark pages. */
function glyph(cell: Raster, ch: string, x: number, y: number, color: RGB = INK): void {
  const rows = GLYPHS[ch];
  if (!rows) return;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== "1") continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!opaque(cell, x + c + dx, y + r + dy)) set(cell, x + c + dx, y + r + dy, CREAM);
    }
  }
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r].length; c++) if (rows[r][c] === "1") set(cell, x + c, y + r, color);
}

/** A cream thought bubble with an ink outline holding `dots` dots (1 to 3). */
function thoughtBubble(cell: Raster, x: number, y: number, dots: number): void {
  const w = 14;
  const h = 9;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const edge = yy === 0 || yy === h - 1 || xx === 0 || xx === w - 1;
      const corner = (xx === 0 || xx === w - 1) && (yy === 0 || yy === h - 1);
      if (corner) continue;
      set(cell, x + xx, y + yy, edge ? INK : CREAM);
    }
  }
  for (let d = 0; d < dots; d++) set(cell, x + 3 + d * 4, y + 4, INK);
  // Two trailing puffs toward the head.
  set(cell, x + 1, y + h + 1, INK);
  set(cell, x - 1, y + h + 3, INK);
}

/* ---------- 7. the base sprite ---------- */

export interface MakeOptions {
  /** 0..255 colour distance from the border colour that still counts as background. */
  tolerance: number;
  /** Sprite height in pixels before outline and rim. */
  height: number;
  /** Palette size. */
  colors: number;
  /** Trims the photo to this box first (the guide frame). Whole photo when missing. */
  frame?: Box;
}

export const DEFAULT_OPTIONS: MakeOptions = { tolerance: 60, height: 38, colors: 12 };

/**
 * Cuts the background, shrinks to the wanted height, snaps to a palette and adds the ink outline and
 * cream rim. Returns null when nothing is left after the cut.
 */
export function makeSprite(photo: Raster, opts: MakeOptions): Raster | null {
  const framed = opts.frame ? crop(photo, opts.frame) : photo;
  const cut = cutBackground(framed, opts.tolerance);
  const box = opaqueBox(cut);
  if (!box) return null;
  const subject = crop(cut, box);
  const h = Math.max(8, Math.min(MAX_SPRITE_H - 4, Math.round(opts.height)));
  let w = Math.max(4, Math.round((subject.width * h) / subject.height));
  let hh = h;
  if (w > MAX_SPRITE_W - 4) {
    w = MAX_SPRITE_W - 4;
    hh = Math.max(8, Math.round((subject.height * w) / subject.width));
  }
  const colors = palette(subject, Math.max(2, Math.min(32, opts.colors)));
  const small = keepLargestBlob(shrink(quantize(subject, colors), w, hh));
  const box2 = opaqueBox(small);
  if (!box2) return null;
  const quant = crop(small, box2);
  return ring(ring(quant, INK), CREAM);
}

/* ---------- 8. frames ---------- */

interface Pose {
  /** Sideways lean in pixels. */
  lean?: number;
  /** Lift above the floor. */
  up?: number;
  /** Width and height change in pixels (a squash is +w, -h). */
  dw?: number;
  dh?: number;
  flip?: boolean;
  /** How open the hole is, 0..1. */
  hole?: number;
  /** Rows at and below this are swallowed by the hole. */
  clipY?: number;
  /** Hide the body (hole only). */
  gone?: boolean;
  glyph?: { ch: string; dx: number; dy: number };
  dots?: number;
}

/** Composes one cell: the hole under, the posed sprite on top, then any glyph. */
export function frame(sprite: Raster, pose: Pose = {}): Raster {
  const cell = raster(CELL[0], CELL[1]);
  hole(cell, pose.hole ?? 0);
  let body = sprite;
  if (pose.dw || pose.dh) body = resample(body, Math.max(2, body.width + (pose.dw ?? 0)), Math.max(2, body.height + (pose.dh ?? 0)));
  if (pose.flip) body = flip(body);
  if (pose.lean) body = lean(body, pose.lean);
  const x = Math.floor((cell.width - body.width) / 2);
  const y = FLOOR - body.height - (pose.up ?? 0);
  if (!pose.gone) blit(cell, body, x, y, pose.clipY ?? Infinity);
  const top = y;
  const right = x + body.width;
  if (pose.dots) thoughtBubble(cell, Math.min(cell.width - 15, right - 4), Math.max(0, top - 14), pose.dots);
  if (pose.glyph) glyph(cell, pose.glyph.ch, Math.min(cell.width - 5, right - 3 + pose.glyph.dx), Math.max(0, top - 8 + pose.glyph.dy));
  return cell;
}

export function strip(frames: Raster[]): Raster {
  const out = raster(CELL[0] * frames.length, CELL[1]);
  frames.forEach((f, i) => blit(out, f, i * CELL[0], 0));
  return out;
}

export interface MadeCharacter {
  manifest: CharacterManifest;
  /** One strip per state, in manifest order. */
  strips: Record<string, Raster>;
}

/** Every state the rabbit's contract names, built from the one sprite. */
export function makeCharacter(sprite: Raster, name: string): MadeCharacter {
  const strips: Record<string, Raster> = {};
  const states: Record<string, StateDef> = {};
  const def = (state: string, frames: Pose[], fps: number, loop: boolean, extra: Partial<StateDef> = {}) => {
    strips[state] = strip(frames.map((p) => frame(sprite, p)));
    states[state] = { file: `${state}.png`, frames: frames.length, fps, loop, ...extra };
  };
  const rest: Pose = {};
  const breath: Pose = { dh: -1 };
  const crouch: Pose = { dw: 2, dh: -3 };
  const stretch: Pose = { dw: -1, dh: 2 };

  def("idle", [rest, rest, breath, breath], 3, true, {
    notes: "Base frame and a one pixel breath.",
    variants: [
      { state: "idle_look", weight: 3 },
      { state: "idle_bounce", weight: 2 },
    ],
  });
  def("idle_look", [rest, { flip: true }, { flip: true }, { flip: true }, rest, rest], 5, false, { notes: "Idle variant: turns round and back." });
  def("idle_bounce", [crouch, { up: 3, ...stretch }, { up: 1 }, { dw: 1, dh: -1 }, rest], 10, false, { notes: "Idle variant: a small bounce." });
  def("to_listening", [{ lean: 1 }, { lean: 2 }, { lean: 3, up: 1 }], 12, false);
  def("listening", [{ lean: 3, up: 1 }], 8, false, { hold: true, enter: "to_listening", exit: "from_listening", notes: "Leans in." });
  def("from_listening", [{ lean: 2 }, { lean: 1 }, rest], 12, false);
  def("to_thinking", [rest, { dots: 1 }, { dots: 2 }], 8, false);
  def("thinking", [{ dots: 1, dh: -1 }, { dots: 2, dh: -1 }, { dots: 3 }, { dots: 3 }], 3, true, { enter: "to_thinking", exit: "aha", notes: "Thought bubble with dots." });
  def("aha", [{ glyph: { ch: "!", dx: 0, dy: -2 }, up: 2, ...stretch }, { glyph: { ch: "!", dx: 0, dy: -3 }, up: 1 }, { glyph: { ch: "!", dx: 0, dy: -3 } }, rest], 6, false);
  def("to_confused", [{ lean: -1 }, { lean: -2, glyph: { ch: "?", dx: 1, dy: 0 } }], 8, false);
  def("confused", [{ lean: -2, glyph: { ch: "?", dx: 1, dy: 0 } }, { lean: 0, glyph: { ch: "?", dx: 1, dy: -1 } }, { lean: 2, glyph: { ch: "?", dx: 1, dy: 0 } }, { lean: 0, glyph: { ch: "?", dx: 1, dy: 1 } }], 4, true, { enter: "to_confused", exit: "from_confused" });
  def("from_confused", [{ lean: -1 }, rest], 8, false);
  def("celebrate", [crouch, { up: 3, ...stretch }, { up: 7, flip: true }, { up: 8, flip: true, glyph: { ch: "!", dx: 2, dy: -2 } }, { up: 6 }, { up: 2, ...stretch }, { dw: 3, dh: -3 }, rest], 10, false);
  def("hop", [{ dw: 1, dh: -2 }, { up: 3, ...stretch }, { up: 5, dw: -1, dh: 1 }, { up: 2 }, { dw: 2, dh: -2 }], 12, true, { move: [0, 4, 6, 4, 0], notes: "Travel loop; move is source pixels per frame." });
  def("panic", [{ lean: -3, up: 1, glyph: { ch: "!", dx: 0, dy: -2 } }, { lean: 3, up: 1, glyph: { ch: "!", dx: 0, dy: -2 } }, { lean: -3, up: 1, glyph: { ch: "!", dx: 0, dy: -2 } }], 6, false);
  def("settle", [{ dw: 1, dh: -1 }, rest], 12, false);
  def("land", [{ dw: 3, dh: -3 }, { dw: 1, dh: -1 }, rest], 10, false);
  def("wave", [{ lean: 2 }, { lean: 4, up: 1 }, { lean: 2 }, { lean: -2 }, { lean: -4, up: 1 }, { lean: -2 }, { lean: 1 }, rest], 10, false);
  def("to_sleepy", [{ dh: -1 }, { lean: 1, dh: -2 }, { lean: 2, dh: -3 }], 6, false);
  def("sleepy", [{ lean: 2, dh: -3, glyph: { ch: "z", dx: 2, dy: -2 } }, { lean: 2, dh: -3, glyph: { ch: "z", dx: 3, dy: -5 } }, { lean: 2, dh: -2, glyph: { ch: "z", dx: 4, dy: -8 } }, { lean: 2, dh: -3 }], 2, true, { enter: "to_sleepy", exit: "from_sleepy" });
  def("from_sleepy", [{ lean: 1, dh: -2 }, { up: 1, ...stretch }, rest], 8, false);
  def("dragged", [{ up: 2, lean: 1, dh: 1 }, { up: 2, lean: -1, dh: 1 }], 4, true);
  def("hole_only", [{ gone: true, hole: 0.3 }, { gone: true, hole: 0.7 }, { gone: true, hole: 1 }], 10, false, { notes: "Hole opening; reversed to close it." });
  def("hole_open", [{ hole: 0.3 }, { hole: 0.7 }, { hole: 1 }], 10, false);
  def("dive", [{ hole: 1, up: 2, ...stretch }, { hole: 1, up: -6, clipY: HOLE_TOP + 1 }, { hole: 1, up: -14, clipY: HOLE_TOP + 1 }, { hole: 1, up: -24, clipY: HOLE_TOP + 1 }, { hole: 1, up: -36, clipY: HOLE_TOP + 1 }, { hole: 1, up: -48, clipY: HOLE_TOP + 1 }, { gone: true, hole: 1 }], 12, false);
  def("hole_wait", [{ gone: true, hole: 1 }, { gone: true, hole: 0.95 }, { gone: true, hole: 1 }, { gone: true, hole: 1 }], 4, true);

  const idleBox = opaqueBox(strips.idle.width > CELL[0] ? crop(strips.idle, { left: 0, top: 0, right: CELL[0], bottom: CELL[1] }) : strips.idle) ?? { left: 0, top: 0, right: CELL[0], bottom: CELL[1] };
  const manifest: CharacterManifest = {
    character: name,
    cell: [...CELL],
    anchor: "bottom center, feet end at row 53",
    body: [idleBox.left, idleBox.top, idleBox.right, idleBox.bottom],
    jump_sequence: {
      sending: [{ state: "hole_open" }, { state: "dive" }, { state: "hole_only", reverse: true }],
      receiving: [{ state: "hole_only" }, { state: "hole_wait", loop: true }, { state: "dive", reverse: true }, { state: "hole_open", reverse: true }, { state: "idle" }],
    },
    idle_variant_gap: [4, 9],
    wander_gap: [75, 150],
    wander_hops: [2, 3],
    states,
  };
  return { manifest, strips };
}
