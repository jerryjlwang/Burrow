/**
 * Pixel art for the hands set pieces, drawn with CSS instead of image files: a glyph is a grid of
 * letters (one per palette colour, "." for nothing) and comes out as one box-shadow list of 3px cells
 * on a 3px element, the way the panel's button glyphs are 7 x 7 cells drawn at 3x. Pixel circles for
 * the tap rings come from the midpoint algorithm so every radius is one cell thick and symmetric.
 */

/** One source pixel on the page. */
export const CELL = 3;

/** The Burrow palette by letter: ink, cream, paper, teal, gold, red. */
const PALETTE: Record<string, string> = {
  i: "#3b2a23",
  c: "#fff8e7",
  p: "#fffdf5",
  t: "#2f8f83",
  g: "#f2c14e",
  r: "#d9534f",
};

export interface Glyph {
  /** Size in px. */
  w: number;
  h: number;
  /** Every cell but the first as a box-shadow list. */
  shadow: string;
  /** The colour of the top left cell, which is the element itself. */
  own: string;
}

/** Turn rows of palette letters into a glyph. Rows may differ in length; short ones are padded. */
export function glyph(rows: string[]): Glyph {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cells: string[] = [];
  let own = "transparent";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const colour = PALETTE[row[x]];
      if (!colour) continue;
      if (x === 0 && y === 0) own = colour;
      else cells.push(`${x * CELL}px ${y * CELL}px 0 0 ${colour}`);
    }
  });
  return { w: width * CELL, h: rows.length * CELL, shadow: cells.join(", "), own };
}

/** Paint a glyph onto an element: the element is the first cell, the rest are its shadow. */
export function paint(el: HTMLElement, g: Glyph): void {
  el.style.width = `${CELL}px`;
  el.style.height = `${CELL}px`;
  el.style.background = g.own;
  el.style.boxShadow = g.shadow;
}

/** Cells on a circle of radius `r` cells around (0, 0), one cell thick (midpoint circle). */
export function ringCells(r: number): [number, number][] {
  const out = new Set<string>();
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    for (const [a, b] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) out.add(`${a},${b}`);
    y++;
    if (err < 0) err += 2 * y + 1;
    else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
  return Array.from(out, (s) => s.split(",").map(Number) as [number, number]);
}

/**
 * A pixel ring as a box-shadow list around a 3px element sitting on the circle's centre cell: the
 * colour one cell thick, with a cream ring just outside it so it still shows on teal and dark pages.
 */
export function ringShadow(r: number, colour: string): string {
  const inner = ringCells(r).map(([x, y]) => `${x * CELL}px ${y * CELL}px 0 0 ${colour}`);
  const outer = ringCells(r + 1).map(([x, y]) => `${x * CELL}px ${y * CELL}px 0 0 ${PALETTE.c}`);
  return inner.concat(outer).join(", ");
}

/** Lean a glyph to the right: rows are shifted by whole cells, more towards the top. */
function lean(rows: string[]): string[] {
  const last = rows.length - 1;
  return rows.map((row, y) => ".".repeat(Math.floor((last - y) / 4)) + row);
}

const PENCIL_UP = [
  ".iii.",
  "irrri",
  "irrri",
  "iiiii",
  "igggi",
  "igggi",
  "igggi",
  "igggi",
  "igggi",
  "igggi",
  "iccci",
  ".ici.",
  "..i..",
];

/** The pencil that writes the letters: upright, and leaning as it moves to the next one. */
export const PENCIL: [Glyph, Glyph] = [glyph(PENCIL_UP), glyph(lean(PENCIL_UP))];

/** The return arrow on the Enter key, 7 x 8 cells. */
export const ENTER_ARROW: Glyph = glyph([
  "......i",
  "......i",
  "......i",
  "..i...i",
  ".ii...i",
  "iiiiiii",
  ".ii....",
  "..i....",
]);

/** A four point sparkle for the glint: gold arms, a cream heart. */
export const SPARKLE: Glyph = glyph([
  "..g..",
  "..g..",
  "ggcgg",
  "..g..",
  "..g..",
]);

/** The right-click menu: a cream card with three short lines of ink. */
export const MENU: Glyph = glyph([
  "iiiiiiiiiiiiii",
  "icccccccccccci",
  "iciiiiiiiiccci",
  "icccccccccccci",
  "iciiiiiiccccci",
  "icccccccccccci",
  "iciiiiiiicccci",
  "icccccccccccci",
  "iiiiiiiiiiiiii",
]);
