/**
 * Colour by numbers for a black and white drawing. The dark lines of the cut-out picture are the
 * fences; the paper between them splits into regions. The page numbers those regions on a picture,
 * a vision model says what colour each one should be, and `paintRegions` fills them in. Pure
 * functions over rasters, shared with the tests.
 */

import { clone, type Raster } from "./pixelize";

export interface Region {
  /** 1-based, in order of size, as printed on the numbered picture. */
  id: number;
  size: number;
  /** Centre of mass, for the label. */
  cx: number;
  cy: number;
}

export interface Split {
  /** Per pixel: region id, 0 for a line, transparent or an unlabelled speck. */
  labels: Int32Array;
  regions: Region[];
}

/** Below this luminance a pixel is a line (a fence between regions) and keeps its own colour. */
export const LINE_LUMA = 100;
/** At most this many regions get numbers; the rest are specks that keep their paper colour. */
export const MAX_REGIONS = 40;
const MIN_SIZE = 6;
/**
 * A pixel joins a region only while it is within this colour distance of the region's mean, so a
 * cheek with no outline stays its own region and a soft edge cannot creep from one colour to the next.
 */
const SAME_COLOUR = 70;

function luma(d: Uint8ClampedArray, i: number): number {
  return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
}

/** Whether a pixel is a line: opaque and dark. */
export function isLine(r: Raster, x: number, y: number, threshold = LINE_LUMA): boolean {
  const i = (y * r.width + x) * 4;
  return r.data[i + 3] > 0 && luma(r.data, i) < threshold;
}

/** Splits the opaque, non-line pixels into 4-connected regions of one colour, biggest first. */
export function splitRegions(r: Raster, threshold = LINE_LUMA, maxRegions = MAX_REGIONS): Split {
  const { width: w, height: h, data } = r;
  const labels = new Int32Array(w * h);
  const found: { size: number; sx: number; sy: number; pixels: number[] }[] = [];
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== 0 || data[start * 4 + 3] === 0 || luma(data, start * 4) < threshold) continue;
    const id = found.length + 1;
    const pixels: number[] = [];
    let sx = 0;
    let sy = 0;
    const sum = [0, 0, 0];
    const stack = [start];
    labels[start] = id;
    const near = (i: number) => {
      const n = pixels.length;
      const dr = data[i] - sum[0] / n;
      const dg = data[i + 1] - sum[1] / n;
      const db = data[i + 2] - sum[2] / n;
      return dr * dr + dg * dg + db * db < SAME_COLOUR * SAME_COLOUR;
    };
    while (stack.length) {
      const k = stack.pop()!;
      pixels.push(k);
      sum[0] += data[k * 4];
      sum[1] += data[k * 4 + 1];
      sum[2] += data[k * 4 + 2];
      const x = k % w;
      const y = (k - x) / w;
      sx += x;
      sy += y;
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
        if (labels[nk] !== 0 || data[nk * 4 + 3] === 0 || luma(data, nk * 4) < threshold || !near(nk * 4)) continue;
        labels[nk] = id;
        stack.push(nk);
      }
    }
    found.push({ size: pixels.length, sx, sy, pixels });
  }
  // Renumber by size, biggest first, and drop specks and anything past the cap.
  const order = found.map((f, i) => ({ f, i })).sort((a, b) => b.f.size - a.f.size);
  const remap = new Int32Array(found.length + 1);
  const regions: Region[] = [];
  for (const { f, i } of order) {
    if (f.size < MIN_SIZE || regions.length >= maxRegions) continue;
    const id = regions.length + 1;
    remap[i + 1] = id;
    regions.push({ id, size: f.size, cx: f.sx / f.size, cy: f.sy / f.size });
  }
  for (let k = 0; k < labels.length; k++) labels[k] = remap[labels[k]];
  return { labels, regions };
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Fills every region that has a colour; lines and unnamed regions keep their pixels. Returns a copy. */
export function paintRegions(r: Raster, labels: Int32Array, colors: Record<string, string>): Raster {
  const out = clone(r);
  const rgb = new Map<number, [number, number, number]>();
  for (const [id, hex] of Object.entries(colors)) {
    const c = parseHex(hex);
    if (c) rgb.set(Number(id), c);
  }
  for (let k = 0; k < labels.length; k++) {
    const c = rgb.get(labels[k]);
    if (!c) continue;
    out.data[k * 4] = c[0];
    out.data[k * 4 + 1] = c[1];
    out.data[k * 4 + 2] = c[2];
  }
  return out;
}

/** Whether the picture is mostly grey: a drawing that wants colouring in. */
export function looksBlackAndWhite(r: Raster): boolean {
  let n = 0;
  let grey = 0;
  for (let i = 0; i < r.data.length; i += 16) {
    if (r.data[i + 3] === 0) continue;
    n++;
    const mx = Math.max(r.data[i], r.data[i + 1], r.data[i + 2]);
    const mn = Math.min(r.data[i], r.data[i + 1], r.data[i + 2]);
    if (mx - mn < 28) grey++;
  }
  return n > 0 && grey / n > 0.8;
}
