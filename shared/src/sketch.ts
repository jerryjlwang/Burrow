/**
 * The chalkboard's sketch language. A sketch spec is newline-separated: plain lines are chalk
 * text, and lines starting with a draw command become freeform strokes on a 100×100 board
 * (x right, y down). A command line that doesn't parse falls back to text — a malformed shape
 * can garble one line, never the board.
 *
 *   line x1 y1 x2 y2      arrow x1 y1 x2 y2      circle cx cy r
 *   rect x y w h          dot x y                label x y words…
 */

export type StrokeKind = "line" | "arrow" | "circle" | "rect" | "dot" | "label";

export interface Stroke {
  kind: StrokeKind;
  /** Coordinates/sizes in board units, clamped to 0..100. */
  n: number[];
  /** label only: the words to write at (x, y). */
  text?: string;
}

export type SketchItem = { kind: "text"; text: string } | { kind: "stroke"; stroke: Stroke };

export interface Sketch {
  title?: string;
  /** Reveal-ordered items: chalk text lines and drawn strokes, as the spec listed them. */
  items: SketchItem[];
}

const ARG_COUNT: Record<StrokeKind, number> = { line: 4, arrow: 4, circle: 3, rect: 4, dot: 2, label: 2 };
const MAX_ITEMS = 24;

const clamp = (v: number): number => Math.min(100, Math.max(0, v));

function parseStroke(line: string): Stroke | null {
  const tokens = line.split(/\s+/);
  const kind = tokens[0].toLowerCase() as StrokeKind;
  if (!(kind in ARG_COUNT)) return null;
  const want = ARG_COUNT[kind];
  const n = tokens.slice(1, 1 + want).map(Number);
  if (n.length < want || n.some((v) => !Number.isFinite(v))) return null;
  if (kind === "label") {
    const text = tokens
      .slice(1 + want)
      .join(" ")
      .replace(/^["'“]|["'”]$/g, "")
      .trim();
    if (!text) return null;
    return { kind, n: n.map(clamp), text: text.slice(0, 40) };
  }
  if (tokens.length > 1 + want) return null;
  if (kind === "circle" && n[2] <= 0) return null;
  if (kind === "rect" && (n[2] <= 0 || n[3] <= 0)) return null;
  return { kind, n: n.map(clamp) };
}

export function parseSketch(spec: string): Sketch {
  const raw = spec
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const titled = raw.length > 1 && raw[0].endsWith(":");
  const title = titled ? raw[0].slice(0, -1) : undefined;
  const items: SketchItem[] = [];
  for (const line of (titled ? raw.slice(1) : raw).slice(0, MAX_ITEMS)) {
    const stroke = parseStroke(line);
    items.push(stroke ? { kind: "stroke", stroke } : { kind: "text", text: line });
  }
  return { title, items };
}

/** One item as the spec line that would draw it — what the model wrote, and what it reads back. */
function itemLine(item: SketchItem): string {
  if (item.kind === "text") return item.text;
  const { kind, n, text } = item.stroke;
  return `${kind} ${n.join(" ")}${text ? ` ${text}` : ""}`;
}

/**
 * The drawing on screen as a numbered list, for the agent's context. Without it the model cannot
 * know what is there, so it can neither extend a drawing sensibly nor erase part of one; the
 * numbers are what an erase refers to.
 */
export function describeSketch(sketch: Sketch): string {
  return sketch.items.map((item, i) => `${i + 1}. ${itemLine(item)}`).join("\n");
}

/**
 * Erase by number: "all", or item numbers from {@link describeSketch} in any mix of "2 5", "2,5"
 * and "3-6". Numbers that are not on the board are ignored; `erased` says how many items went.
 */
export function eraseFromSketch(items: SketchItem[], spec: string): { items: SketchItem[]; erased: number } {
  if (/^\s*(all|everything)\s*$/i.test(spec)) return { items: [], erased: items.length };
  const doomed = new Set<number>();
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    for (let n = Math.min(from, to); n <= Math.max(from, to) && n <= items.length; n++) if (n >= 1) doomed.add(n);
  }
  return { items: items.filter((_, i) => !doomed.has(i + 1)), erased: doomed.size };
}
