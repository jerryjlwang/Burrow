import { describe, expect, it } from "vitest";
import { CELL, cutBackground, frame, lean, makeCharacter, makeSprite, opaqueBox, palette, quantize, raster, ring, shrink, type RGB, type Raster } from "../pixelize";

function fill(r: Raster, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = c[0];
      r.data[i + 1] = c[1];
      r.data[i + 2] = c[2];
      r.data[i + 3] = 255;
    }
  }
}

function alphaAt(r: Raster, x: number, y: number): number {
  return r.data[(y * r.width + x) * 4 + 3];
}

/** A "photo": a beige wall, a red and blue character in the middle, and a speck of dirt in a corner. */
function photo(): Raster {
  const r = raster(120, 120);
  fill(r, 0, 0, 120, 120, [220, 205, 180]);
  fill(r, 40, 20, 80, 100, [200, 40, 40]);
  fill(r, 50, 30, 70, 50, [40, 60, 200]);
  fill(r, 5, 5, 8, 8, [10, 10, 10]);
  return r;
}

describe("cutBackground", () => {
  it("clears the wall, keeps the character and drops the speck", () => {
    const cut = cutBackground(photo(), 40);
    expect(alphaAt(cut, 0, 0)).toBe(0);
    expect(alphaAt(cut, 60, 60)).toBe(255);
    expect(alphaAt(cut, 6, 6)).toBe(0);
    expect(opaqueBox(cut)).toEqual({ left: 40, top: 20, right: 80, bottom: 100 });
  });

  it("with a tiny tolerance nothing on a textured wall is cut", () => {
    const r = photo();
    fill(r, 0, 0, 120, 1, [0, 0, 0]);
    const cut = cutBackground(r, 1);
    // The top row seeds the fill but is far from the mean border colour, so the fill never starts.
    expect(alphaAt(cut, 60, 110)).toBe(255);
  });
});

describe("shrink and palette", () => {
  it("shrinks by vote and keeps edges clean", () => {
    const cut = cutBackground(photo(), 40);
    const small = shrink(cut, 30, 30);
    expect(alphaAt(small, 0, 0)).toBe(0);
    expect(alphaAt(small, 15, 15)).toBe(255);
    // The blue patch (50..70, 30..50 of 120) lands on 12..17, 7..12 of 30 and stays blue, not a red and blue mix.
    const i = (9 * small.width + 15) * 4;
    expect([small.data[i], small.data[i + 1], small.data[i + 2]]).toEqual([40, 60, 200]);
  });

  it("finds the two colours and snaps to them", () => {
    const cut = cutBackground(photo(), 40);
    const p = palette(cut, 4);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p.length).toBeLessThanOrEqual(4);
    const q = quantize(cut, p);
    const i = (60 * q.width + 60) * 4;
    expect(p.some((c) => c[0] === q.data[i] && c[1] === q.data[i + 1] && c[2] === q.data[i + 2])).toBe(true);
  });
});

describe("ring and lean", () => {
  it("adds one pixel all round", () => {
    const r = raster(3, 3);
    fill(r, 1, 1, 2, 2, [1, 2, 3]);
    const out = ring(r, [9, 9, 9]);
    expect(out.width).toBe(5);
    expect(alphaAt(out, 2, 2)).toBe(255);
    expect(alphaAt(out, 1, 2)).toBe(255);
    expect(alphaAt(out, 2, 1)).toBe(255);
    expect(alphaAt(out, 1, 1)).toBe(0);
  });

  it("keeps the feet still and moves the head", () => {
    const r = raster(3, 10);
    fill(r, 1, 0, 2, 10, [1, 1, 1]);
    const out = lean(r, 3);
    expect(alphaAt(out, 4, 9)).toBe(255);
    expect(alphaAt(out, 7, 0)).toBe(255);
  });
});

describe("makeSprite and makeCharacter", () => {
  it("builds a sprite of the asked height with outline and rim, inside the cell", () => {
    const s = makeSprite(photo(), { tolerance: 40, height: 30, colors: 8 });
    expect(s).not.toBeNull();
    expect(s!.height).toBe(34);
    expect(s!.width).toBeLessThanOrEqual(44);
    expect(s!.height).toBeLessThanOrEqual(44);
    expect(alphaAt(s!, 0, 0)).toBe(0);
  });

  it("returns null when the cut leaves nothing", () => {
    const r = raster(20, 20);
    fill(r, 0, 0, 20, 20, [100, 100, 100]);
    expect(makeSprite(r, { tolerance: 50, height: 30, colors: 8 })).toBeNull();
  });

  it("puts the feet on the rabbit's floor and keeps every frame in the cell", () => {
    const s = makeSprite(photo(), { tolerance: 40, height: 30, colors: 8 })!;
    const f = frame(s);
    expect(f.width).toBe(CELL[0]);
    const box = opaqueBox(f)!;
    expect(box.bottom).toBe(55);
    const made = makeCharacter(s, "test");
    for (const [state, def] of Object.entries(made.manifest.states)) {
      expect(made.strips[state].width).toBe(CELL[0] * def.frames);
      expect(made.strips[state].height).toBe(CELL[1]);
    }
    // A hop goes up and never leaves the cell.
    expect(opaqueBox(made.strips.hop)!.top).toBeGreaterThanOrEqual(0);
    // Every contract state is present.
    for (const name of ["idle", "listening", "thinking", "confused", "celebrate", "wave", "hop", "settle", "land", "dragged", "sleepy", "hole_only", "hole_open", "dive", "hole_wait"]) expect(made.manifest.states[name]).toBeDefined();
    expect(made.manifest.body![3]).toBe(55);
  });
});
