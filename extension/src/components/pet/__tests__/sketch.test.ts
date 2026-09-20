import { describe, expect, it } from "vitest";
import { INK, raster, type Raster } from "../pixelize";
import { cutSketch, cutSubject, floodOutside, inkMask } from "../sketch";

function set(r: Raster, x: number, y: number, c: [number, number, number]): void {
  const i = (y * r.width + x) * 4;
  r.data[i] = c[0];
  r.data[i + 1] = c[1];
  r.data[i + 2] = c[2];
  r.data[i + 3] = 255;
}

function at(r: Raster, x: number, y: number): [number, number, number, number] {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
}

/**
 * A photo of a pencil drawing: paper that darkens to the left, a dark desk edge along the left
 * side, a rectangle drawn in faint grey with a small gap in its top edge, and a filled eye inside.
 */
function drawingPhoto(gap = 3): Raster {
  const W = 160;
  const H = 160;
  const r = raster(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const paper = 150 + Math.round((x / W) * 70);
      set(r, x, y, [paper, paper - 4, paper - 12]);
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < 18; x++) set(r, x, y, [60, 50, 45]);
  const pencil = (x: number, y: number) => {
    const paper = 150 + Math.round((x / W) * 70);
    set(r, x, y, [Math.round(paper * 0.55), Math.round(paper * 0.55), Math.round(paper * 0.55)]);
  };
  for (let x = 50; x < 130; x++) {
    for (let t = 0; t < 2; t++) {
      if (x < 88 || x >= 88 + gap) pencil(x, 40 + t);
      pencil(x, 120 + t);
    }
  }
  for (let y = 40; y < 122; y++) {
    for (let t = 0; t < 2; t++) {
      pencil(50 + t, y);
      pencil(128 + t, y);
    }
  }
  for (let y = 70; y < 78; y++) for (let x = 70; x < 78; x++) set(r, x, y, [40, 38, 36]);
  return r;
}

describe("inkMask", () => {
  it("finds faint pencil on unevenly lit paper and ignores the dark desk", () => {
    const r = drawingPhoto();
    const ink = inkMask(r, 0.8);
    expect(ink[41 * r.width + 60]).toBe(1);
    expect(ink[73 * r.width + 73]).toBe(1);
    expect(ink[80 * r.width + 8]).toBe(0);
    expect(ink[80 * r.width + 90]).toBe(0);
  });
});

describe("floodOutside", () => {
  it("cannot cross a diagonal line", () => {
    const w = 8;
    const fence = new Uint8Array(w * w);
    for (let i = 0; i < w; i++) fence[i * w + i] = 1;
    const out = floodOutside(fence, w, w);
    expect(out[1 * w + 6]).toBe(1);
    expect(out[6 * w + 1]).toBe(1);
    expect(out[3 * w + 3]).toBe(0);
  });
});

describe("cutSketch", () => {
  it("keeps the inside of the outline, closes the gap, drops the desk and paints ink dark and paper white", () => {
    const cut = cutSketch(drawingPhoto(), { threshold: 0.8 });
    expect(at(cut, 90, 80)).toEqual([255, 255, 255, 255]);
    expect(at(cut, 60, 40)).toEqual([INK[0], INK[1], INK[2], 255]);
    expect(at(cut, 73, 73)).toEqual([INK[0], INK[1], INK[2], 255]);
    expect(at(cut, 8, 80)[3]).toBe(0);
    expect(at(cut, 140, 20)[3]).toBe(0);
    expect(at(cut, 30, 30)[3]).toBe(0);
  });

  it("widens the closing on its own when the gap is bigger", () => {
    const cut = cutSketch(drawingPhoto(9), { threshold: 0.8 });
    expect(at(cut, 90, 80)[3]).toBe(255);
    expect(at(cut, 140, 20)[3]).toBe(0);
  });

  it("returns an empty raster for a blank page", () => {
    const r = raster(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) set(r, x, y, [200, 200, 200]);
    const cut = cutSketch(r, { threshold: 0.8 });
    expect(cut.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
  });
});

describe("cutSubject", () => {
  it("routes a drawing to the sketch cut and a coloured picture to the background cut", () => {
    const sketch = cutSubject(drawingPhoto(), { sketch: true, tolerance: 100 });
    expect(at(sketch, 90, 80)).toEqual([255, 255, 255, 255]);
    const photo = drawingPhoto();
    const colour = cutSubject(photo, { sketch: false, tolerance: 60 });
    expect(colour.width).toBe(photo.width);
  });
});
