import { describe, expect, it } from "vitest";
import { raster, type Raster } from "../pixelize";
import { looksBlackAndWhite, paintRegions, parseHex, splitRegions } from "../regions";

function fill(r: Raster, x0: number, y0: number, x1: number, y1: number, c: [number, number, number], a = 255): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = c[0];
      r.data[i + 1] = c[1];
      r.data[i + 2] = c[2];
      r.data[i + 3] = a;
    }
  }
}

/** A cut-out drawing: a white square with a black border and a black line across the middle (two rooms), on transparent. */
function drawing(): Raster {
  const r = raster(40, 40);
  fill(r, 5, 5, 35, 35, [20, 20, 20]);
  fill(r, 7, 7, 33, 33, [250, 250, 250]);
  fill(r, 7, 19, 33, 21, [20, 20, 20]);
  fill(r, 10, 10, 13, 13, [20, 20, 20]);
  fill(r, 11, 11, 12, 12, [250, 250, 250]);
  return r;
}

describe("splitRegions", () => {
  it("finds the rooms between the lines, biggest first, and drops specks", () => {
    const { labels, regions } = splitRegions(drawing());
    expect(regions.length).toBe(2);
    expect(regions[0].size).toBeGreaterThanOrEqual(regions[1].size);
    expect(labels[15 * 40 + 20]).toBe(regions.find((r) => r.cy < 20)!.id);
    expect(labels[25 * 40 + 20]).toBe(regions.find((r) => r.cy > 20)!.id);
    // Lines and the transparent outside are 0; the one pixel "eye" is a speck.
    expect(labels[5 * 40 + 20]).toBe(0);
    expect(labels[0]).toBe(0);
    expect(labels[11 * 40 + 11]).toBe(0);
  });
});

describe("paintRegions", () => {
  it("fills only the coloured rooms and keeps the lines", () => {
    const d = drawing();
    const { labels, regions } = splitRegions(d);
    const top = regions.find((r) => r.cy < 20)!.id;
    const out = paintRegions(d, labels, { [top]: "#f2c14e", nonsense: "blue" });
    const i = (15 * 40 + 20) * 4;
    expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([242, 193, 78]);
    const j = (25 * 40 + 20) * 4;
    expect(out.data[j]).toBe(250);
    const k = (5 * 40 + 20) * 4;
    expect(out.data[k]).toBe(20);
    // The input is untouched.
    expect(d.data[i]).toBe(250);
  });

  it("reads hex with or without the hash", () => {
    expect(parseHex("#FF0000")).toEqual([255, 0, 0]);
    expect(parseHex("00ff00")).toEqual([0, 255, 0]);
    expect(parseHex("red")).toBeNull();
  });
});

describe("looksBlackAndWhite", () => {
  it("is true for a pencil drawing and false for a coloured one", () => {
    expect(looksBlackAndWhite(drawing())).toBe(true);
    const d = drawing();
    fill(d, 7, 7, 33, 19, [240, 200, 40]);
    expect(looksBlackAndWhite(d)).toBe(false);
  });
});
