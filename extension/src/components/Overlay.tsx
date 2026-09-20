import { useEffect, useMemo, useState } from "react";
import { useStore, type HighlightBox } from "../content/store";
import { assetUrl } from "./pet";

/**
 * The guide: how the rabbit shows you something. A hop of pawprints is laid along an arc from his feet
 * to the target one print at a time, the oldest fading behind, so the eye follows a trail. At the
 * target four pixel brackets snap in like a viewfinder locking on, then breathe. A spotlight dims the
 * rest of the page through a Bayer dither with a window that closes in on the target. A label hangs
 * from the top bracket on a small plank. A target off the screen gets a pawprint at the nearest edge,
 * pointing the way. Purely visual; never intercepts input. The store contract (highlights, pointer,
 * lookAt) is unchanged, and the .pip-hl and .pip-beam names the checks look for stay.
 */
const PAD = 6;
const PRINT_MS = 70;
const PRINT_GAP = 54;
const TRAIL_KEEP = 7;
const TRAIL_HOLD_MS = 1300;
const RELAY_PX = 24;
const IRIS_STEPS = 6;
const IRIS_STEP_MS = 60;
const EDGE_INSET = 24;

type Pt = { x: number; y: number };

/** Point on the arc from `from` to `to` at t in [0, 1], and the direction of travel there. */
function onArc(from: Pt, to: Pt, t: number): { x: number; y: number; angle: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const mx = from.x + dx * 0.5 - dy * 0.18;
  const my = from.y + dy * 0.5 + dx * 0.18;
  const u = 1 - t;
  const x = u * u * from.x + 2 * u * t * mx + t * t * to.x;
  const y = u * u * from.y + 2 * u * t * my + t * t * to.y;
  const tx = 2 * u * (mx - from.x) + 2 * t * (to.x - mx);
  const ty = 2 * u * (my - from.y) + 2 * t * (to.y - my);
  return { x, y, angle: Math.atan2(ty, tx) };
}

interface Print {
  x: number;
  y: number;
  deg: number;
  side: number;
}

/** The prints of one hop: left and right paws a little either side of the arc, on whole pixels. */
function planTrail(from: Pt, to: Pt): Print[] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(3, Math.min(14, Math.round(len / PRINT_GAP)));
  const out: Print[] = [];
  for (let i = 0; i < n; i++) {
    const p = onArc(from, to, (i + 0.5) / n);
    const side = i % 2 === 0 ? -1 : 1;
    out.push({ x: Math.round(p.x - Math.sin(p.angle) * 5 * side), y: Math.round(p.y + Math.cos(p.angle) * 5 * side), deg: Math.round((p.angle * 180) / Math.PI + 90), side });
  }
  return out;
}

const bucket = (p: Pt): string => `${Math.round(p.x / RELAY_PX)},${Math.round(p.y / RELAY_PX)}`;

/** Lays the prints one by one, holds, and hops again while the pointer stays; re-lays when either end moves. */
function useTrail(pointer: { from: Pt; to: Pt } | null, reduced: boolean): { prints: Print[]; laid: number } {
  const key = pointer ? `${bucket(pointer.from)}>${bucket(pointer.to)}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prints = useMemo(() => (pointer ? planTrail(pointer.from, pointer.to) : []), [key]);
  const [laid, setLaid] = useState(0);
  useEffect(() => {
    if (!key || reduced) {
      setLaid(0);
      return;
    }
    let n = 0;
    let timer = 0;
    const step = () => {
      n += 1;
      setLaid(n);
      if (n < prints.length) timer = window.setTimeout(step, PRINT_MS);
      else
        timer = window.setTimeout(() => {
          n = 0;
          setLaid(0);
          timer = window.setTimeout(step, PRINT_MS * 2);
        }, TRAIL_HOLD_MS);
    };
    setLaid(0);
    timer = window.setTimeout(step, PRINT_MS);
    return () => window.clearTimeout(timer);
  }, [key, reduced, prints.length]);
  return { prints, laid };
}

/** The spotlight's window closes in on the target in steps; a new target starts the iris again. */
function useIris(id: number | null, reduced: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (id === null) return;
    if (reduced) {
      setStep(IRIS_STEPS);
      return;
    }
    let n = 0;
    setStep(0);
    const timer = window.setInterval(() => {
      n += 1;
      setStep(n);
      if (n >= IRIS_STEPS) window.clearInterval(timer);
    }, IRIS_STEP_MS);
    return () => window.clearInterval(timer);
  }, [id, reduced]);
  return id === null ? 0 : step;
}

const offScreen = (r: HighlightBox["rect"]): boolean => r.x + r.width < 0 || r.y + r.height < 0 || r.x > window.innerWidth || r.y > window.innerHeight;

export function Overlay() {
  const highlights = useStore((s) => s.highlights);
  const pointer = useStore((s) => s.pointer);
  const reduced = useStore((s) => s.reducedMotion);
  const { prints, laid } = useTrail(pointer, reduced);
  const spot = highlights.find((h) => h.spotlight) ?? null;
  const iris = useIris(spot ? spot.id : null, reduced);
  if (!highlights.length && !pointer) return null;
  const vars = { "--paw": `url("${assetUrl("ui/guide/paw.png")}")`, "--dim": `url("${assetUrl("ui/guide/dim.png")}")` } as React.CSSProperties;
  let dim: React.CSSProperties | null = null;
  if (spot) {
    const r = spot.rect;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const w1 = r.width + 2 * (PAD + 9);
    const h1 = r.height + 2 * (PAD + 9);
    const w0 = Math.max(window.innerWidth, window.innerHeight) * 2 + w1;
    const k = iris / IRIS_STEPS;
    const w = Math.round(w0 + (w1 - w0) * k);
    const h = Math.round(w0 + (h1 - w0) * k);
    const pos = `${Math.round(cx - w / 2)}px ${Math.round(cy - h / 2)}px, 0 0`;
    const size = `${w}px ${h}px, 100% 100%`;
    dim = { WebkitMaskPosition: pos, maskPosition: pos, WebkitMaskSize: size, maskSize: size } as React.CSSProperties;
  }
  return (
    <div className="pip-overlay" aria-hidden="true" style={vars}>
      {dim && <div className="pip-hl-dim" style={dim} />}
      {highlights.map((h) =>
        offScreen(h.rect) ? (
          <EdgeMark key={h.id} rect={h.rect} />
        ) : (
          <div
            key={h.id}
            className={`pip-hl kind-${h.kind}${h.spotlight ? " spotlight" : ""}${reduced ? " reduced" : ""}`}
            style={{ left: h.rect.x - PAD, top: h.rect.y - PAD, width: h.rect.width + PAD * 2, height: h.rect.height + PAD * 2 }}
          >
            <i className="pip-hl-c tl" />
            <i className="pip-hl-c tr" />
            <i className="pip-hl-c bl" />
            <i className="pip-hl-c br" />
            {h.label && <span className={`pip-hl-label${h.rect.y - PAD < 66 ? " below" : ""}${pointer && pointer.from.x < h.rect.x + h.rect.width / 2 ? " right" : ""}`}>{h.label}</span>}
          </div>
        ),
      )}
      {pointer && (
        <div className="pip-beam">
          {prints.slice(0, laid).map((p, i) => {
            const age = laid - 1 - i;
            if (age >= TRAIL_KEEP) return null;
            return <i key={`${p.x},${p.y}`} className={`pip-paw${age >= 5 ? " a2" : age >= 3 ? " a1" : ""}${p.side < 0 ? " l" : ""}`} style={{ left: p.x, top: p.y, transform: `rotate(${p.deg}deg)` }} />;
          })}
        </div>
      )}
    </div>
  );
}

/** The plank hangs on the side away from the rabbit, so it never sits on him or his trail. A pawprint at the viewport edge nearest a target that is off the screen, pointing the way. */
function EdgeMark({ rect }: { rect: HighlightBox["rect"] }) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const x = Math.max(EDGE_INSET, Math.min(window.innerWidth - EDGE_INSET, cx));
  const y = Math.max(EDGE_INSET, Math.min(window.innerHeight - EDGE_INSET, cy));
  const deg = Math.round((Math.atan2(cy - y, cx - x) * 180) / Math.PI + 90);
  return <i className="pip-hl-edge" style={{ left: Math.round(x), top: Math.round(y), transform: `rotate(${deg}deg)` }} />;
}
