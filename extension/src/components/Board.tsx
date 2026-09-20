import { useEffect, useState } from "react";
import { store, useStore } from "../content/store";

/**
 * The rabbit's chalkboard: a worked example revealed line by line, like someone writing it out.
 * Content arrives via the agent's `sketch` action (leak-checked server-side like any other text).
 * Dismiss with the ✕ or Escape; a new sketch replaces the old one.
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
};

export function Board() {
  const board = useStore((s) => s.board);
  const reduced = useStore((s) => s.reducedMotion);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (!board) return;
    if (reduced) {
      setRevealed(board.lines.length);
      return;
    }
    setRevealed(1);
    const timer = window.setInterval(() => {
      setRevealed((r) => {
        if (r >= board.lines.length) {
          window.clearInterval(timer);
          return r;
        }
        return r + 1;
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [board, reduced]);

  if (!board) return null;
  return (
    <div className="pip-board" role="figure" aria-label="worked example" style={wrap}>
      {board.title && <div className="pip-board-title" style={{ fontWeight: 700, marginBottom: 6, opacity: 0.85 }}>{board.title}</div>}
      {board.lines.slice(0, revealed).map((line, i) => (
        <div key={`${board.id}-${i}`} className="pip-board-line" style={{ whiteSpace: "pre-wrap" }}>
          {line}
        </div>
      ))}
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
