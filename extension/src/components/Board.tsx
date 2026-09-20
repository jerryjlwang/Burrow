import { useEffect, useState } from "react";
import type { Stroke } from "@shared/sketch";
import { store, useStore } from "../content/store";

/**
 * The rabbit's chalkboard: a worked example revealed piece by piece, like someone writing it out.
 * Items are chalk text lines and freeform strokes (lines, arrows, circles, labels) on a 100×100
 * canvas. Content arrives via the agent's `sketch` action (leak-checked server-side like any
 * other text). Dismiss with the ✕ or Escape; a new sketch replaces the old one.
 */
const wrap: React.CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  maxWidth: 440,
  padding: "14px 40px 14px 18px",
  background: "#1d2430",
  color: "#eaf3e6",
  border: "3px solid #3c4a5c",
  borderRadius: 10,
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  fontFamily: "inherit",
  fontSize: 18,
  lineHeight: 1.55,
  zIndex: 2147483000,
  // The companion host ignores pointer events so pages stay clickable; interactive surfaces opt back in.
  pointerEvents: "auto",
};

const CHALK = "#eaf3e6";

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
      return (
        <text x={a} y={b} fill={CHALK} stroke="none" fontSize={5.5} style={animate ? { animation: "pip-chalk-fade 400ms ease-out both" } : undefined}>
          {stroke.text}
        </text>
      );
  }
}

export function Board() {
  const board = useStore((s) => s.board);
  const reduced = useStore((s) => s.reducedMotion);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (!board) return;
    if (reduced) {
      setRevealed(board.items.length);
      return;
    }
    setRevealed(1);
    const timer = window.setInterval(() => {
      setRevealed((r) => {
        if (r >= board.items.length) {
          window.clearInterval(timer);
          return r;
        }
        return r + 1;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [board, reduced]);

  if (!board) return null;
  const shown = board.items.slice(0, revealed);
  const strokes = shown.filter((it) => it.kind === "stroke");
  return (
    <div className="pip-board" role="figure" aria-label="worked example" style={wrap}>
      {board.title && <div className="pip-board-title" style={{ fontWeight: 700, marginBottom: 6, opacity: 0.85 }}>{board.title}</div>}
      {shown.map((item, i) =>
        item.kind === "text" ? (
          <div key={`${board.id}-${i}`} className="pip-board-line" style={{ whiteSpace: "pre-wrap" }}>
            {item.text}
          </div>
        ) : null,
      )}
      {strokes.length > 0 && (
        <svg className="pip-board-canvas" viewBox="0 0 100 100" style={{ display: "block", width: "100%", aspectRatio: "1 / 1", marginTop: 8 }} aria-hidden="true">
          {shown.map((item, i) => (item.kind === "stroke" ? <StrokeShape key={`${board.id}-s${i}`} stroke={item.stroke} animate={!reduced} /> : null))}
        </svg>
      )}
      <button
        type="button"
        aria-label="Close the board"
        onClick={() => store.setState({ board: null })}
        style={{ position: "absolute", top: 6, right: 8, background: "none", border: "none", color: "#eaf3e6", cursor: "pointer", fontSize: 16, opacity: 0.7 }}
      >
        ✕
      </button>
    </div>
  );
}
