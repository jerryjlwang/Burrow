import { useEffect, useState } from "react";
import type { Bubble as BubbleModel, BubbleAction } from "../content/store";
import { voiceBlip } from "./sounds";

/** Characters revealed per second while the rabbit "talks". */
const CHARS_PER_SECOND = 42;
/** Buttons never wait longer than this, even on a long sentence. */
const MAX_BUTTON_WAIT_MS = 2200;
const TICK_MS = 40;

/**
 * Types the text out with a small voice blip every other letter, the way game characters talk.
 * The full text is always in the DOM (the rest is just invisible) so screen readers and tests
 * see the whole sentence at once; only the picture types. Timing is wall-clock based on a timer,
 * not animation frames, so a tab that goes to the background still finishes; a hidden tab shows
 * everything at once.
 */
function useTypewriter(text: string, id: string): { shown: number; done: boolean; skip: () => void } {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (document.visibilityState === "hidden") {
      setShown(text.length);
      return;
    }
    setShown(0);
    const start = performance.now();
    let last = 0;
    let timer = 0;
    const tick = () => {
      const n = document.visibilityState === "hidden" ? text.length : Math.min(text.length, Math.floor(((performance.now() - start) / 1000) * CHARS_PER_SECOND));
      if (n !== last) {
        for (let i = last; i < Math.min(n, last + 8); i++) {
          const ch = text[i];
          if (/[a-z]/i.test(ch) && i % 2 === 0) voiceBlip(ch.charCodeAt(0));
        }
        last = n;
        setShown(n);
      }
      if (n < text.length) timer = window.setTimeout(tick, TICK_MS);
    };
    timer = window.setTimeout(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [text, id]);
  return { shown, done: shown >= text.length, skip: () => setShown(text.length) };
}

/** Buttons appear when typing ends or after a short cap, whichever comes first. */
function useButtonsReady(done: boolean, id: string): boolean {
  const [capped, setCapped] = useState(false);
  useEffect(() => {
    setCapped(false);
    const t = window.setTimeout(() => setCapped(true), MAX_BUTTON_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [id]);
  return done || capped;
}

export function Bubble({ bubble, onAction }: { bubble: BubbleModel; onAction: (value: BubbleAction["value"]) => void }) {
  const { shown, done, skip } = useTypewriter(bubble.text, bubble.id);
  const buttonsReady = useButtonsReady(done, bubble.id);
  const head = bubble.text.slice(0, shown);
  const tail = bubble.text.slice(shown);
  return (
    <div className={`pip-bubble kind-${bubble.kind}${done ? "" : " typing"}`} role={bubble.kind === "confirmation" ? "alertdialog" : "status"} aria-live="polite" onClick={done ? undefined : skip}>
      <p className="pip-bubble-text">
        {head}
        {!done && <span className="pip-bubble-caret" aria-hidden="true" />}
        {tail && <span className="pip-bubble-rest">{tail}</span>}
      </p>
      {bubble.actions && bubble.actions.length > 0 && (
        <div className={`pip-bubble-actions${buttonsReady ? "" : " pending"}`}>
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
