import { useEffect, useRef, useState } from "react";
import type { Bubble as BubbleModel, BubbleAction } from "../content/store";
import { voiceBlip } from "./sounds";

/** Characters revealed per second while the rabbit "talks". */
const CHARS_PER_SECOND = 42;

/**
 * Types the text out with a small voice blip every other letter, the way game characters talk.
 * The full text is always in the DOM (the rest is just invisible) so screen readers and tests
 * see the whole sentence at once; only the picture types.
 */
function useTypewriter(text: string, id: string): { shown: number; done: boolean; skip: () => void } {
  const [shown, setShown] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    setShown(0);
    const start = performance.now();
    let last = 0;
    const tick = (t: number) => {
      const n = Math.min(text.length, Math.floor(((t - start) / 1000) * CHARS_PER_SECOND));
      if (n !== last) {
        for (let i = last; i < n; i++) {
          const ch = text[i];
          if (/[a-z]/i.test(ch) && i % 2 === 0) voiceBlip(ch.charCodeAt(0));
        }
        last = n;
        setShown(n);
      }
      if (n < text.length) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [text, id]);
  return { shown, done: shown >= text.length, skip: () => setShown(text.length) };
}

export function Bubble({ bubble, onAction }: { bubble: BubbleModel; onAction: (value: BubbleAction["value"]) => void }) {
  const { shown, done, skip } = useTypewriter(bubble.text, bubble.id);
  const head = bubble.text.slice(0, shown);
  const tail = bubble.text.slice(shown);
  return (
    <div className={`pip-bubble kind-${bubble.kind}${done ? "" : " typing"}`} role={bubble.kind === "confirmation" ? "alertdialog" : "status"} aria-live="polite" onClick={done ? undefined : skip}>
      <p className="pip-bubble-text">
        {head}
        {tail && <span className="pip-bubble-rest">{tail}</span>}
      </p>
      {bubble.actions && bubble.actions.length > 0 && (
        <div className={`pip-bubble-actions${done ? "" : " pending"}`}>
          {bubble.actions.map((a) => (
            <button key={a.value} type="button" className={`pip-btn${a.primary ? " primary" : ""}`} onClick={() => onAction(a.value)} autoFocus={!!a.primary}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {!bubble.actions?.length && (
        <button type="button" className="pip-bubble-close" aria-label="Dismiss" onClick={() => onAction("dismiss")}>
          ×
        </button>
      )}
    </div>
  );
}
