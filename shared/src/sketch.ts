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
