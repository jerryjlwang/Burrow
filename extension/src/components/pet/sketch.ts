/**
 * Cutting a pencil drawing out of a photo. A drawing is not a patch of colour on a plain wall:
 * the character is paper inside a faint outline, the paper is unevenly lit, and the outline has
 * small gaps. So: estimate the paper brightness locally and treat "darker than the local paper" as
 * ink; thicken the ink a little so small gaps close; flood the outside in from the border through
 * everything that is not ink; what the flood cannot reach is the character. The result is a clean
 * cut-out with ink in one dark colour and the inside white, which the pixel and colour-by-numbers
 * steps then treat like any other picture. Pure functions over rasters, shared with the tests.
 */

import { INK, cutBackground, raster, type Raster } from "./pixelize";

export interface SketchOptions {
  /** A pixel is ink when it is darker than this fraction of the local paper brightness (0.5 to 0.95). */
  threshold: number;
  /** How far the ink is thickened before the flood, in pixels; grows on its own if the outline leaks. */
  close?: number;
}

const WHITE: [number, number, number] = [255, 255, 255];

function luminance(r: Raster): Float32Array {
  const out = new Float32Array(r.width * r.height);
  for (let k = 0; k < out.length; k++) out[k] = r.data[k * 4] * 0.299 + r.data[k * 4 + 1] * 0.587 + r.data[k * 4 + 2] * 0.114;
  return out;
}

/** Separable square max filter. */
function maxFilter(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const v = src[y * w + xx];
        if (v > m) m = v;
      }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        const v = tmp[yy * w + x];
        if (v > m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Separable box blur with clamped edges. */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dx = -radius; dx <= radius; dx++) s += src[y * w + Math.min(w - 1, Math.max(0, x + dx))];
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -radius; dy <= radius; dy++) s += tmp[Math.min(h - 1, Math.max(0, y + dy)) * w + x];
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function morph(mask: Uint8Array, w: number, h: number, radius: number, grow: boolean): Uint8Array {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        const m = xx < 0 || xx >= w ? 0 : mask[y * w + xx];
        if (grow ? m : !m) {
          v = grow ? 1 : 0;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        const m = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
        if (grow ? m : !m) {
          v = grow ? 1 : 0;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export const dilate = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => morph(mask, w, h, r, true);
export const erode = (mask: Uint8Array, w: number, h: number, r: number): Uint8Array => morph(mask, w, h, r, false);

/** Everything reachable from the border without crossing a fence pixel (4-connected, so a diagonal line holds). */
export function floodOutside(fence: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const k = y * w + x;
    if (out[k] || fence[k]) return;
    out[k] = 1;
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
    const x = k % w;
    const y = (k - x) / w;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return out;
}

/** Keeps the biggest 8-connected region of a mask (diagonal pencil strokes stay joined). */
export function largestRegion(mask: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    label[start] = id;
    while (stack.length) {
      const k = stack.pop()!;
      size++;
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (!mask[nk] || label[nk] >= 0) continue;
          label[nk] = id;
          stack.push(nk);
        }
      }
    }
    sizes.push(size);
  }
  const out = new Uint8Array(w * h);
  if (!sizes.length) return out;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  for (let k = 0; k < out.length; k++) if (label[k] === best) out[k] = 1;
  return out;
}

/** Ink: opaque pixels darker than `threshold` times the local paper brightness. Broad dark areas (a desk, a shadow) are not ink. */
export function inkMask(photo: Raster, threshold: number): Uint8Array {
  const { width: w, height: h } = photo;
  const g = luminance(photo);
  const strokes = Math.max(3, Math.round(Math.min(w, h) / 60));
  const paper = boxBlur(maxFilter(g, w, h, strokes), w, h, strokes * 2);
  const out = new Uint8Array(w * h);
  for (let k = 0; k < out.length; k++) out[k] = photo.data[k * 4 + 3] > 0 && g[k] < paper[k] * threshold ? 1 : 0;
  return out;
}

/**
 * The drawing cut out of the photo: ink in one dark colour, the inside white, everything else
 * transparent. Tries a small closing first and widens it while the outline still leaks.
 */
export function cutSketch(photo: Raster, opts: SketchOptions): Raster {
  const { width: w, height: h } = photo;
  const ink = inkMask(photo, Math.min(0.97, Math.max(0.3, opts.threshold)));
  let inkCount = 0;
  for (let k = 0; k < ink.length; k++) inkCount += ink[k];
  const out = raster(w, h);
  if (!inkCount) return out;
  let subject: Uint8Array = new Uint8Array(w * h);
  const first = Math.max(1, Math.round(opts.close ?? 2));
  for (const close of [first, first + 2, first + 4]) {
    const fence = dilate(ink, w, h, close);
    const outside = floodOutside(fence, w, h);
    const inside = new Uint8Array(w * h);
    for (let k = 0; k < inside.length; k++) inside[k] = outside[k] ? 0 : 1;
    // Shrinking the inside by the same amount takes the thickened halo off the outer edge of the lines.
    const core = erode(inside, w, h, close);
    for (let k = 0; k < core.length; k++) core[k] = core[k] || ink[k];
    subject = largestRegion(core, w, h);
    let area = 0;
    for (let k = 0; k < subject.length; k++) area += subject[k];
    // A drawing has far more paper inside its outline than ink; if not, the outline leaked and needs more closing.
    if (area > inkCount * 1.6) break;
  }
  // Lines a pixel thicker read better once the picture is a few dozen pixels tall.
  const inkArt = dilate(ink, w, h, 1);
  for (let k = 0; k < subject.length; k++) {
    if (!subject[k]) continue;
    const c = inkArt[k] ? INK : WHITE;
    out.data[k * 4] = c[0];
    out.data[k * 4 + 1] = c[1];
    out.data[k * 4 + 2] = c[2];
    out.data[k * 4 + 3] = 255;
  }
  return out;
}

/** The cut-out for either kind of picture: a drawing by its ink, a coloured picture by its background. */
export function cutSubject(photo: Raster, opts: { sketch: boolean; tolerance: number }): Raster {
  if (opts.sketch) return cutSketch(photo, { threshold: 0.55 + (Math.min(160, Math.max(0, opts.tolerance)) / 160) * 0.4 });
  return cutBackground(photo, opts.tolerance);
}
