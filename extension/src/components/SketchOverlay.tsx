import { useEffect, useRef, useState } from "react";
import type { Stroke } from "@shared/sketch";
import type { Rect } from "@shared/types";
import { store, useStore } from "../content/store";

/**
 * The rabbit's drawing surface: text lines and freeform strokes overlaid directly on the page —
 * white chalk with drop shadows, no box, so the content underneath stays visible. Anchored
 * sketches wrap their 100×100 stroke space onto a page element (a video, the problem text) and
 * track it as it moves; unanchored ones float in the corner. `add` sketches extend the drawing
 * and the staged reveal continues instead of restarting. Dismiss with the ✕ or Escape.
 */
const INK = "#fff";
const TEXT_SHADOW = "0 1px 2px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.55)";
const STROKE_FILTER = "drop-shadow(0 1px 1.5px rgba(0,0,0,.9)) drop-shadow(0 0 4px rgba(0,0,0,.45))";

const textStyle: React.CSSProperties = { whiteSpace: "pre-wrap", color: INK, textShadow: TEXT_SHADOW, fontWeight: 600, fontSize: 17, lineHeight: 1.5 };

/** One stroke as SVG. pathLength=100 makes the draw-in uniform; non-scaling strokes survive anchored stretch. */
function StrokeShape({ stroke, animate }: { stroke: Stroke; animate: boolean }) {
  const s = { stroke: INK, strokeWidth: 3, fill: "none", strokeLinecap: "round" as const, vectorEffect: "non-scaling-stroke" as const };
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
      return <circle cx={a} cy={b} r={1.3} fill={INK} stroke="none" />;
    default:
      return null;
  }
}

/** Tracks an anchor element's viewport rect every frame; null when unanchored or the element is gone. */
function useAnchorRect(anchor: Element | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      if (!anchor.isConnected) {
        setRect(null);
        return;
      }
      const r = anchor.getBoundingClientRect();
      setRect((old) => (old && Math.abs(old.x - r.x) < 0.5 && Math.abs(old.y - r.y) < 0.5 && Math.abs(old.width - r.width) < 0.5 && Math.abs(old.height - r.height) < 0.5 ? old : { x: r.x, y: r.y, width: r.width, height: r.height }));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [anchor]);
  return rect;
}

/** Chalk drawn over a page element (a video, a problem). Unanchored sketches are the framed Board's. */
export function SketchOverlay() {
  const board = useStore((s) => s.board);
  const reduced = useStore((s) => s.reducedMotion);
  const [revealed, setRevealed] = useState(0);
  // Reveal position survives `add` extensions (same board id): only the new items stage in.
  const prevReveal = useRef({ id: "", count: 0 });

  useEffect(() => {
    if (!board) return;
    const from = prevReveal.current.id === board.id ? Math.min(prevReveal.current.count, board.items.length) : 0;
    prevReveal.current = { id: board.id, count: from };
    if (reduced) {
      setRevealed(board.items.length);
      prevReveal.current.count = board.items.length;
      return;
    }
    setRevealed(Math.max(from, 1));
    prevReveal.current.count = Math.max(from, 1);
    const timer = window.setInterval(() => {
      setRevealed((r) => {
        const next = r >= board.items.length ? r : r + 1;
        prevReveal.current.count = next;
        if (next >= board.items.length) window.clearInterval(timer);
        return next;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [board, reduced]);

  const rect = useAnchorRect(board?.anchor ?? null);
  if (!board || !board.anchor) return null;

  const shown = board.items.slice(0, revealed);
  const hasShapes = shown.some((it) => it.kind === "stroke" && it.stroke.kind !== "label");
  const hasStrokeItems = shown.some((it) => it.kind === "stroke");
  const anchored = rect !== null;

  const canvas = (
    <svg
      className="pip-board-canvas"
      viewBox="0 0 100 100"
      preserveAspectRatio={anchored ? "none" : "xMidYMid meet"}
      style={anchored ? { position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", filter: STROKE_FILTER } : { display: "block", width: "100%", aspectRatio: "1 / 1", marginTop: 6, overflow: "visible", filter: STROKE_FILTER }}
      aria-hidden="true"
    >
      {shown.map((item, i) => (item.kind === "stroke" && item.stroke.kind !== "label" ? <StrokeShape key={`${board.id}-s${i}`} stroke={item.stroke} animate={!reduced} /> : null))}
    </svg>
  );

  // Labels render as HTML at percentage positions: crisp text, no stretch under anchored mapping.
  const labels = (host: React.CSSProperties) => (
    <div style={{ ...host, pointerEvents: "none" }}>
      {shown.map((item, i) =>
        item.kind === "stroke" && item.stroke.kind === "label" ? (
          <div key={`${board.id}-l${i}`} className="pip-board-label" style={{ position: "absolute", left: `${item.stroke.n[0]}%`, top: `${item.stroke.n[1]}%`, transform: "translateY(-50%)", ...textStyle, fontSize: 15, fontWeight: 700, animation: reduced ? undefined : "pip-chalk-fade 400ms ease-out both" }}>
            {item.stroke.text}
          </div>
        ) : null,
      )}
    </div>
  );

  const textLines = shown.filter((it) => it.kind === "text");
  const textBlock = (textLines.length > 0 || board.title) && (
    <div style={{ pointerEvents: "none" }}>
      {board.title && <div className="pip-board-title" style={{ ...textStyle, fontWeight: 700, opacity: 0.9, marginBottom: 2 }}>{board.title}</div>}
      {shown.map((item, i) => (item.kind === "text" ? <div key={`${board.id}-${i}`} className="pip-board-line" style={textStyle}>{item.text}</div> : null))}
    </div>
  );

  const close = (
    <button
      type="button"
      aria-label="Close the board"
      onClick={() => store.setState({ board: null })}
      style={{ position: "absolute", top: -10, right: -10, width: 22, height: 22, borderRadius: 11, background: "rgba(0,0,0,.55)", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: "22px", padding: 0, pointerEvents: "auto" }}
    >
      ✕
    </button>
  );

  if (anchored) {
    // Wrapped to the page region: strokes span its rect; words sit just below it.
    return (
      <div className="pip-board" role="figure" aria-label="drawing" style={{ position: "fixed", left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 2147483000, pointerEvents: "none" }}>
        {hasShapes && canvas}
        {labels({ position: "absolute", inset: 0 })}
        {textBlock && <div style={{ position: "absolute", left: 0, top: "100%", paddingTop: 8, maxWidth: Math.max(rect.width, 320) }}>{textBlock}</div>}
        {close}
      </div>
    );
  }

  return (
    <div className="pip-board" role="figure" aria-label="drawing" style={{ position: "fixed", left: 20, bottom: 20, width: 380, zIndex: 2147483000, pointerEvents: "none", fontFamily: "inherit" }}>
      {textBlock}
      {hasStrokeItems && <div style={{ position: "relative" }}>{canvas}{labels({ position: "absolute", inset: 0 })}</div>}
      {close}
    </div>
  );
}
