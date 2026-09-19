import { useEffect, useMemo, useRef, useState } from "react";
import type { CharacterState } from "../content/store";

export interface CharacterProps {
  state: CharacterState;
  /** 0..1 audio level for listening/speaking reactions. */
  level: number;
  /** Viewport point the character should look toward. */
  lookAt: { x: number; y: number } | null;
  attention: 0 | 1 | 2;
  reducedMotion: boolean;
  size?: number;
  /** Reports the character's current center in viewport coordinates (used by the pointer beam). */
  onAnchor?: (getCenter: () => { x: number; y: number }) => void;
}

/**
 * Pip: an original CSS/SVG mascot. Behavioural state is passed in; the artwork is
 * isolated here so it can be swapped for real assets later without touching logic.
 */
export function Character({ state, level, lookAt, attention, reducedMotion, size = 76, onAnchor }: CharacterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [blink, setBlink] = useState(false);
  const [eye, setEye] = useState({ x: 0, y: 0 });
  const [lean, setLean] = useState({ x: 0, y: 0, rot: 0 });

  useEffect(() => {
    onAnchor?.(() => {
      const r = ref.current?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth - 58, y: window.innerHeight - 58 };
    });
  }, [onAnchor]);

  // Blink at organic intervals.
  useEffect(() => {
    if (state === "sleeping") return;
    let t: number;
    const schedule = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 130);
        schedule();
      }, 2600 + Math.random() * 3200);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [state]);

  // Look toward a target: eyes move, body leans slightly.
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!lookAt || !r) {
      setEye(state === "thinking" ? { x: 3, y: -4 } : { x: 0, y: 0 });
      setLean({ x: 0, y: 0, rot: 0 });
      return;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = lookAt.x - cx;
    const dy = lookAt.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    setEye({ x: nx * 6, y: ny * 5 });
    const leanAmount = state === "pointing" || state === "acting" || attention > 0 ? 14 : 6;
    setLean({ x: nx * leanAmount, y: ny * leanAmount * 0.6, rot: nx * -8 });
  }, [lookAt, state, attention]);

  const mouth = useMemo(() => {
    const open = Math.min(1, level * 2.2);
    switch (state) {
      case "speaking":
        return { d: `M 38 62 Q 50 ${62 + 4 + open * 14} 62 62 Q 50 ${62 - 2 - open * 3} 38 62 Z`, fill: true };
      case "celebrating":
        return { d: "M 34 58 Q 50 76 66 58", fill: false };
      case "confused":
        return { d: "M 38 64 Q 44 58 50 64 Q 56 70 62 64", fill: false };
      case "error":
        return { d: "M 40 64 L 60 64", fill: false };
      case "thinking":
        return { d: "M 44 64 Q 50 60 56 64", fill: false };
      case "sleeping":
        return { d: "M 44 63 Q 50 67 56 63", fill: false };
      case "listening":
        return { d: "M 40 60 Q 50 68 60 60", fill: false };
      default:
        return { d: "M 40 60 Q 50 70 60 60", fill: false };
    }
  }, [state, level]);

  const eyesClosed = blink || state === "sleeping";
  const happyEyes = state === "celebrating";
  const wide = state === "listening" || attention > 0;
  const ring = state === "listening" ? 1 + Math.min(0.35, level * 0.8) : 1;

  return (
    <div
      ref={ref}
      className={`pip-char state-${state}${reducedMotion ? " reduced" : ""}`}
      data-attention={attention}
      style={{ width: size, height: size, transform: `translate(${lean.x}px, ${lean.y}px) rotate(${lean.rot}deg)` }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} className="pip-svg">
        <defs>
          <linearGradient id="pipBody" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor="#ffb08a" />
            <stop offset="0.55" stopColor="#e07cff" />
            <stop offset="1" stopColor="#6d5cff" />
          </linearGradient>
          <radialGradient id="pipGlow" cx="0.35" cy="0.3" r="0.6">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <filter id="pipShadow" x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="6" stdDeviation="5" floodColor="#4a2fbf" floodOpacity="0.28" />
          </filter>
        </defs>

        {/* status ring */}
        <g className="pip-ring" style={{ transform: `scale(${ring})`, transformOrigin: "50px 52px" }}>
          <circle cx="50" cy="52" r="46" className="pip-ring-circle" />
        </g>

        <g className="pip-body-group" filter="url(#pipShadow)">
          <path
            className="pip-body"
            d="M 50 8 C 74 8 92 26 92 50 C 92 76 74 94 50 94 C 26 94 8 76 8 50 C 8 26 26 8 50 8 Z"
            fill="url(#pipBody)"
          />
          <ellipse cx="38" cy="30" rx="22" ry="16" fill="url(#pipGlow)" />
        </g>

        {/* eyes */}
        <g className="pip-eyes" style={{ transform: `translate(${eye.x}px, ${eye.y}px)` }}>
          {happyEyes ? (
            <>
              <path d="M 28 44 Q 36 34 44 44" className="pip-happy-eye" />
              <path d="M 56 44 Q 64 34 72 44" className="pip-happy-eye" />
            </>
          ) : (
            <>
              <g className="pip-eye" style={{ transform: `scaleY(${eyesClosed ? 0.08 : wide ? 1.12 : 1})`, transformOrigin: "36px 44px" }}>
                <ellipse cx="36" cy="44" rx="7" ry="8.5" fill="#241f3d" />
                <circle cx="33.5" cy="40.5" r="2.4" fill="#fff" />
              </g>
              <g className="pip-eye" style={{ transform: `scaleY(${eyesClosed ? 0.08 : wide ? 1.12 : 1})`, transformOrigin: "64px 44px" }}>
                <ellipse cx="64" cy="44" rx="7" ry="8.5" fill="#241f3d" />
                <circle cx="61.5" cy="40.5" r="2.4" fill="#fff" />
              </g>
            </>
          )}
          {state === "confused" && <path d="M 56 30 Q 64 26 72 31" className="pip-brow" />}
        </g>

        {/* cheeks */}
        <circle cx="24" cy="56" r="5" fill="#ff7d9a" opacity={state === "celebrating" ? 0.7 : 0.35} />
        <circle cx="76" cy="56" r="5" fill="#ff7d9a" opacity={state === "celebrating" ? 0.7 : 0.35} />

        {/* mouth */}
        <path d={mouth.d} className={`pip-mouth${mouth.fill ? " filled" : ""}`} />

        {/* state badges */}
        {state === "thinking" && (
          <g className="pip-dots">
            <circle cx="80" cy="18" r="3" />
            <circle cx="89" cy="12" r="4" />
            <circle cx="97" cy="4" r="2.5" />
          </g>
        )}
        {state === "sleeping" && (
          <text x="74" y="22" className="pip-z">
            z
          </text>
        )}
        {(attention === 2 || state === "confused") && (
          <g className="pip-badge">
            <circle cx="84" cy="16" r="11" fill="#fff" />
            <text x="84" y="21" textAnchor="middle" className="pip-badge-text">
              ?
            </text>
          </g>
        )}
        {state === "error" && (
          <g className="pip-badge">
            <circle cx="84" cy="16" r="11" fill="#ffe4e6" />
            <text x="84" y="21" textAnchor="middle" className="pip-badge-text err">
              !
            </text>
          </g>
        )}
        {state === "celebrating" && (
          <g className="pip-sparkles">
            <path d="M 14 20 l 2 -6 l 2 6 l 6 2 l -6 2 l -2 6 l -2 -6 l -6 -2 z" />
            <path d="M 86 78 l 1.5 -4.5 l 1.5 4.5 l 4.5 1.5 l -4.5 1.5 l -1.5 4.5 l -1.5 -4.5 l -4.5 -1.5 z" />
            <path d="M 88 30 l 1 -3 l 1 3 l 3 1 l -3 1 l -1 3 l -1 -3 l -3 -1 z" />
          </g>
        )}
      </svg>
    </div>
  );
}
