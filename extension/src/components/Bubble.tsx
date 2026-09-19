import type { Bubble as BubbleModel, BubbleAction } from "../content/store";

export function Bubble({ bubble, onAction }: { bubble: BubbleModel; onAction: (value: BubbleAction["value"]) => void }) {
  return (
    <div className={`pip-bubble kind-${bubble.kind}`} role={bubble.kind === "confirmation" ? "alertdialog" : "status"} aria-live="polite">
      <p className="pip-bubble-text">{bubble.text}</p>
      {bubble.actions && bubble.actions.length > 0 && (
        <div className="pip-bubble-actions">
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
