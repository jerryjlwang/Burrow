import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { parseSketch, type Stroke } from "@shared/sketch";
import { store, useStore, type SketchBoard } from "../content/store";
import { assetUrl } from "./pet";
import { playCue } from "./sounds";

/**
 * The rabbit's chalkboard: a worked example he writes out line by line on a board that stands
 * beside him, the way a teacher does. Items are chalk text lines and freeform strokes (lines,
 * arrows, circles, labels) on a 100 x 100 canvas. Content arrives through the agent's `sketch`
 * action (leak-checked server-side like any other text), the developer panel's "chalkboard"
 * button, or a `burrow:board` window event {title?, lines[]}.
 *
 * The frame is the hand-placed 9-slice in public/ui/board.png (wooden edge, chalk tray, dark
 * green slate) and the chalk is VT323 loaded through the FontFace API. The board rises from the
 * floor in pixel steps, sits on the rabbit's side of the hold to talk button with its tray on his
 * feet line, follows him, and never covers him. While he writes he thinks; when the last line lands
 * he has his "aha". Dismiss with the x, Escape, or a new sketch, which replaces the old one.
 */

/** Chalk letters per second. Slower than his voice: he is writing, not talking. */
const CHARS_PER_SECOND = 26;
/** The board rises first; writing starts once it has landed. */
const FIRST_LINE_DELAY_MS = 420;
/** A breath after a finished line, and how long a drawn shape takes including its pause. */
const LINE_PAUSE_MS = 340;
const STROKE_MS = 700;
/** Must match pip-board-sink in styles.css. */
const LEAVE_MS = 300;
/** Gap to the rabbit (or his hold to talk button) and to the viewport edge, in whole 3px steps. */
const GAP = 12;
const EDGE = 12;
const WIDTH = 384;
const MIN_WIDTH = 246;

const CHALK = "#fff8e7";

type Side = "left" | "right" | "above";
interface Placement {
  side: Side;
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

const snap = (v: number): number => Math.round(v / 3) * 3;

/**
 * Where the board stands, from the rabbit's body box and his hold to talk button (both in viewport
 * pixels). Beside him on the side with room, tray on his feet line; above his head only when neither
 * side fits. Every edge lands on the 3px grid.
 */
export function placeBoard(body: DOMRect | null, talk: DOMRect | null, vw: number, vh: number, scale = 3): Placement {
  // Before he reports a position: docked bottom right at 3x.
  const b = body && body.width > 0 ? body : new DOMRect(vw - 111, vh - 186, 93, 159);
  const t = talk && talk.width > 0 ? talk : null;
  // The feet end one source pixel above the body box (its last row is the hole's).
  const feet = b.bottom - scale;
  const blockL = t ? Math.min(b.left, t.left) : b.left;
  const blockR = t ? Math.max(b.right, t.right) : b.right;
  const roomL = blockL - GAP - EDGE;
  const roomR = vw - blockR - GAP - EDGE;
  const fitsL = roomL >= MIN_WIDTH;
  const fitsR = roomR >= MIN_WIDTH;
  const side: Side = fitsL && (roomL >= WIDTH || roomL >= roomR) ? "left" : fitsR ? "right" : fitsL ? "left" : "above";
  if (side === "above") {
    const width = snap(Math.max(MIN_WIDTH, Math.min(WIDTH, vw - 2 * EDGE)));
    const left = snap(Math.min(Math.max(EDGE, b.right - width), Math.max(EDGE, vw - EDGE - width)));
    return { side, left, width, bottom: snap(vh - b.top + GAP), maxHeight: Math.max(90, snap(b.top - GAP - EDGE)) };
  }
  const width = snap(Math.min(WIDTH, side === "left" ? roomL : roomR));
  const left = side === "left" ? snap(blockL - GAP - width) : snap(blockR + GAP);
  return { side, left, width, bottom: snap(vh - feet), maxHeight: Math.max(90, snap(feet - EDGE)) };
}

type Entry = { kind: "text"; text: string; title?: boolean } | { kind: "stroke"; stroke: Stroke };

/** The title is written first, then the items in the order the sketch listed them. */
function entriesOf(board: SketchBoard): Entry[] {
  const out: Entry[] = [];
  if (board.title) out.push({ kind: "text", text: board.title, title: true });
  for (const it of board.items) out.push(it.kind === "text" ? { kind: "text", text: it.text } : { kind: "stroke", stroke: it.stroke });
  return out;
}

let chalkFontRequested = false;
/** VT323 for the chalk: clean digits. Loaded like the kid font, through the FontFace API. */
function loadChalkFont(): void {
  if (chalkFontRequested || typeof FontFace === "undefined" || !document.fonts) return;
  chalkFontRequested = true;
  try {
    const face = new FontFace("Burrow Digits", `url("${assetUrl("fonts/VT323.ttf")}")`, { display: "swap" });
    face.load().then((f) => document.fonts.add(f)).catch(() => undefined);
  } catch {
    /* the chalk stays on the fallback font */
  }
}

const play = (state: string): void => {
  window.dispatchEvent(new CustomEvent("burrow:play", { detail: { state } }));
};

/** One stroke as chalk SVG. pathLength=100 makes the draw-in animation uniform across shapes. */
function StrokeShape({ stroke, animate }: { stroke: Stroke; animate: boolean }) {
  const s = { stroke: CHALK, strokeWidth: 0.9, fill: "none", strokeLinecap: "round" as const };
  const anim = animate ? { strokeDasharray: 100, style: { animation: "pip-chalk 500ms ease-out both" } } : {};
  const [a, b, c, d] = stroke.n;
  switch (stroke.kind) {
    case "line":
      return <path d={`M ${a} ${b} L ${c} ${d}`} pathLength={100} {...s} {...anim} />;
    case "arrow": {
      // Head drawn as two short flicks at the tip, angled off the shaft.
      const ang = Math.atan2(d - b, c - a);
      const flick = (off: number) => `M ${c} ${d} L ${c - 4 * Math.cos(ang + off)} ${d - 4 * Math.sin(ang + off)}`;
      return <path d={`M ${a} ${b} L ${c} ${d} ${flick(0.5)} ${flick(-0.5)}`} pathLength={100} {...s} {...anim} />;
    }
    case "circle":
      return <circle cx={a} cy={b} r={c} pathLength={100} {...s} {...anim} />;
    case "rect":
      return <rect x={a} y={b} width={c} height={d} pathLength={100} {...s} {...anim} />;
    case "dot":
      return <circle cx={a} cy={b} r={1.3} fill={CHALK} stroke="none" />;
    case "label":
      return null; // labels are HTML over the canvas, see the drawing in Board
  }
}

export function Board() {
  // Sketches anchored to a page element are drawn over that element by SketchOverlay, not here.
  const board = useStore((s) => (s.board && !s.board.anchor ? s.board : null));
  const reduced = useStore((s) => s.reducedMotion);

  // What is on screen. It lags `board` by one sink animation when the board is dismissed.
  const [shown, setShown] = useState<SketchBoard | null>(board);
  const [leaving, setLeaving] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (board) {
      setShown(board);
      setLeaving(false);
      return;
    }
    if (!shownRef.current) return;
    if (reduced) {
      setShown(null);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, LEAVE_MS + 30);
    return () => window.clearTimeout(t);
  }, [board, reduced]);

  useEffect(() => loadChalkFont(), []);

  // Pages and the extension's own views can put a worked example up: {title?, lines[]}. Lines that
  // start with a draw command become strokes, exactly as the agent's sketch text does. No lines closes it.
  useEffect(() => {
    const onBoard = (e: Event) => {
      const d = (e as CustomEvent<{ title?: string; lines?: string[] }>).detail;
      const lines = Array.isArray(d?.lines) ? d.lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0) : [];
      if (!lines.length) {
        store.setState({ board: null });
        return;
      }
      const title = typeof d.title === "string" ? d.title.trim().replace(/:$/, "") : "";
      const sk = parseSketch((title ? [`${title}:`, ...lines] : lines).join("\n"));
      if (!sk.items.length) return;
      store.setState({ board: { id: `evt-${Date.now()}`, title: sk.title, items: sk.items, anchor: null }, planView: null });
    };
    window.addEventListener("burrow:board", onBoard);
    return () => window.removeEventListener("burrow:board", onBoard);
  }, []);

  // Escape dismisses the board, unless the panel is open and claims the key.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !store.getState().panelOpen) store.setState({ board: null });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown]);

  // The rabbit turns to the board: he thinks while he writes and lights up when the last line lands.
  // Only when he is idle; speaking, pointing and acting draw on the idle strip and would not take the
  // picture back from thinking on their own, so hand it back for those. The other states switch strips themselves.
  const thinking = useRef(false);
  const backToIdle = () => {
    if (!thinking.current) return;
    thinking.current = false;
    play("idle");
  };
  useEffect(() => {
    if (!shown || reduced || store.getState().characterState !== "idle") return;
    thinking.current = true;
    play("thinking");
    const unsub = store.subscribe(() => {
      if (!thinking.current) return;
      const st = store.getState().characterState;
      if (st === "idle") return;
      thinking.current = false;
      if (st === "speaking" || st === "pointing" || st === "acting") play("idle");
    });
    return () => {
      unsub();
      backToIdle();
    };
  }, [shown, reduced]);

  // Writing: one entry at a time, a squeak as each starts, letter by letter for text.
  const [pos, setPos] = useState({ id: "", at: 0, chars: 0 });
  const finishRef = useRef<() => void>(() => undefined);
  /** How far the writing of which board has got, so a changed board (same id) is not rewritten from the top. */
  const written = useRef({ id: "", at: 0, total: 0 });
  useEffect(() => {
    if (!shown) return;
    const id = shown.id;
    const entries = entriesOf(shown);
    const total = entries.length;
    let live = true;
    let timer = 0;
    const mark = (at: number, chars: number) => {
      written.current = { id, at, total };
      setPos({ id, at, chars });
    };
    const settle = () => {
      mark(total, 0);
      backToIdle();
    };
    // Same board with changed items — an `add`, or part of it erased: what is written stays written.
    // A finished board picks up at its old end (new entries write in; after an erase nothing is left to
    // write); one still being written carries on from where it was.
    const prev = written.current;
    const from = prev.id !== id ? 0 : prev.at >= prev.total ? Math.min(prev.total, total) : Math.min(prev.at, total);
    if (reduced) {
      settle();
      return;
    }
    const later = (fn: () => void, ms: number) => {
      timer = window.setTimeout(fn, ms);
    };
    const step = (at: number, chars: number) => {
      if (!live) return;
      if (at >= total) {
        settle();
        return;
      }
      const e = entries[at];
      if (e.kind === "stroke") {
        playCue("chalk");
        mark(at, 0);
        later(() => step(at + 1, 0), STROKE_MS);
        return;
      }
      if (chars === 0 && e.text.length) playCue("chalk");
      const next = Math.min(e.text.length, chars + 1);
      mark(at, next);
      if (next >= e.text.length) later(() => step(at + 1, 0), LINE_PAUSE_MS);
      else later(() => step(at, next), 1000 / CHARS_PER_SECOND);
    };
    finishRef.current = () => {
      live = false;
      window.clearTimeout(timer);
      settle();
    };
    if (from >= total) {
      settle();
      return;
    }
    mark(from, 0);
    later(() => step(from, 0), from ? LINE_PAUSE_MS : FIRST_LINE_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      finishRef.current = () => undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduced]);

  // Stand beside the rabbit and follow him. The pet and the hold to talk button live in the same
  // shadow root, so measure them there; one rect read per frame while the board is up.
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    if (!shown) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const root = ref.current?.getRootNode();
      const scope: ParentNode = root && "querySelector" in root ? (root as ParentNode) : document;
      const body = scope.querySelector(".pet-hit")?.getBoundingClientRect() ?? null;
      const talk = scope.querySelector(".pip-talk")?.getBoundingClientRect() ?? null;
      const scale = Number((scope.querySelector(".pet") as HTMLElement | null)?.dataset.scale) || 3;
      const next = placeBoard(body, talk, window.innerWidth, window.innerHeight, scale);
      const key = `${next.side}:${next.left}:${next.bottom}:${next.width}:${next.maxHeight}`;
      if (key !== last) {
        last = key;
        setPlace(next);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [shown]);

  if (!shown) return null;
  const entries = entriesOf(shown);
  const total = entries.length;
  const at = pos.id === shown.id ? pos.at : 0;
  const chars = pos.id === shown.id ? pos.chars : 0;
  const complete = at >= total;
  let lastText = -1;
  for (let i = total - 1; i >= 0; i--) {
    if (entries[i].kind === "text") {
      lastText = i;
      break;
    }
  }
  const hasStrokes = entries.some((e) => e.kind === "stroke");
  const style = {
    left: place?.left,
    bottom: place?.bottom,
    width: place?.width,
    maxHeight: place?.maxHeight,
    "--ui-board": `url("${assetUrl("ui/board.png")}")`,
    "--ui-chalk": `url("${assetUrl("ui/chalk.png")}")`,
  } as React.CSSProperties;
  return (
    <div
      key={shown.id}
      ref={ref}
      className={`pip-board${leaving ? " leaving" : ""}${complete ? " complete" : " writing"}${place ? ` side-${place.side}` : ""}`}
      role="figure"
      aria-label="worked example"
      style={style}
    >
      <div className="pip-board-slate" onClick={complete ? undefined : () => finishRef.current()}>
        {entries.map((e, i) => {
          if (e.kind !== "text") return null;
          const state = i > at ? "todo" : i === at || (complete && i === lastText) ? "current" : "done";
          const n = i === at ? chars : i < at ? e.text.length : 0;
          const written = n >= e.text.length;
          const rest = e.text.slice(n);
          return (
            <p key={`${shown.id}-${i}`} className={`pip-board-line ${state}${written ? " written" : ""}${e.title ? " pip-board-title" : ""}`}>
              <span className="pip-board-head">{e.text.slice(0, n)}</span>
              {state === "current" && !written && <span className="pip-board-caret" aria-hidden="true" />}
              {rest && <span className="pip-board-rest">{rest}</span>}
            </p>
          );
        })}
        {hasStrokes && (
          <div className="pip-board-drawing">
            <svg className="pip-board-canvas" viewBox="0 0 100 100" aria-hidden="true">
              {entries.map((e, i) => (e.kind === "stroke" && e.stroke.kind !== "label" && i <= at ? <StrokeShape key={`${shown.id}-s${i}`} stroke={e.stroke} animate={!reduced} /> : null))}
            </svg>
            {/* Labels are HTML at percentage positions, as on the page overlay, so the chalk text stays crisp. */}
            {entries.map((e, i) =>
              e.kind === "stroke" && e.stroke.kind === "label" && i <= at ? (
                <span key={`${shown.id}-l${i}`} className="pip-board-label" style={{ left: `${e.stroke.n[0]}%`, top: `${e.stroke.n[1]}%`, animation: reduced ? undefined : "pip-chalk-fade 400ms ease-out both" }}>
                  {e.stroke.text}
                </span>
              ) : null,
            )}
          </div>
        )}
      </div>
      <span className="pip-board-chalk" aria-hidden="true" />
      <button
        type="button"
        className="pip-board-close"
        aria-label="Close the board"
        onClick={() => {
          // The ✕ takes the board down in the same event, no sink: a click handler flushes at once, so
          // the page's checks (and the kid) see it gone on the click, not after a render or two.
          setShown(null);
          setLeaving(false);
          store.setState({ board: null });
        }}
      >
        ×
      </button>
    </div>
  );
}
