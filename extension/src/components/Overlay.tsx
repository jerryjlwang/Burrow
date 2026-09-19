import { useStore } from "../content/store";

/** Highlight rings, optional spotlight and the pointer beam. Purely visual; never intercepts input. */
export function Overlay() {
  const highlights = useStore((s) => s.highlights);
  const pointer = useStore((s) => s.pointer);
  const reduced = useStore((s) => s.reducedMotion);
  if (!highlights.length && !pointer) return null;
  const pad = 6;
  return (
    <div className="pip-overlay" aria-hidden="true">
      {highlights.map((h) => (
        <div
          key={h.id}
          className={`pip-hl kind-${h.kind}${h.spotlight ? " spotlight" : ""}${reduced ? " reduced" : ""}`}
          style={{ left: h.rect.x - pad, top: h.rect.y - pad, width: h.rect.width + pad * 2, height: h.rect.height + pad * 2 }}
        >
          {h.label && <span className="pip-hl-label">{h.label}</span>}
        </div>
      ))}
      {pointer && (
        <svg className="pip-beam" width="100%" height="100%">
          <defs>
            <marker id="pipArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c5cff" />
            </marker>
          </defs>
          <path
            d={curve(pointer.from, pointer.to)}
            className={`pip-beam-path${reduced ? " reduced" : ""}`}
            markerEnd="url(#pipArrow)"
          />
          <circle cx={pointer.to.x} cy={pointer.to.y} r="6" className="pip-beam-dot" />
        </svg>
      )}
    </div>
  );
}

function curve(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Gentle arc: control point offset perpendicular to the line.
  const mx = from.x + dx * 0.5 - dy * 0.18;
  const my = from.y + dy * 0.5 + dx * 0.18;
  return `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;
}
