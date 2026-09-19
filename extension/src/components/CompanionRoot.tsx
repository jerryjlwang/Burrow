import { useCallback, useEffect } from "react";
import { store, useStore } from "../content/store";
import type { CompanionController } from "../content/controller";
import { Character } from "./Character";
import { Panel } from "./Panel";
import { Bubble } from "./Bubble";
import { Overlay } from "./Overlay";
import { DebugPanel } from "./DebugPanel";

export function CompanionRoot({ controller }: { controller: CompanionController }) {
  const characterState = useStore((s) => s.characterState);
  const level = useStore((s) => s.audioLevel);
  const lookAt = useStore((s) => s.lookAt);
  const attention = useStore((s) => s.attention);
  const reduced = useStore((s) => s.reducedMotion);
  const panelOpen = useStore((s) => s.panelOpen);
  const minimized = useStore((s) => s.minimized);
  const hidden = useStore((s) => s.hidden);
  const bubble = useStore((s) => s.bubble);
  const conversation = useStore((s) => s.conversation);
  const unread = useStore((s) => s.unread);
  const settings = useStore((s) => s.settings);
  const voice = useStore((s) => s.voice);
  const busy = useStore((s) => s.busy);

  const onAnchor = useCallback((getCenter: () => { x: number; y: number }) => {
    controller.overlay.characterAnchor = getCenter;
  }, [controller]);

  // Show the latest short companion reply as a bubble while the panel is closed.
  useEffect(() => {
    if (panelOpen) return;
    const last = conversation[conversation.length - 1];
    if (!last || last.role !== "companion" || last.kind === "offer" || last.kind === "confirmation") return;
    const s = store.getState();
    if (s.bubble && (s.bubble.kind === "offer" || s.bubble.kind === "confirmation")) return;
    controller.showBubble({ id: `reply-${last.at}`, text: last.text.length > 220 ? last.text.slice(0, 217) + "…" : last.text, kind: "reply", expiresAt: Date.now() + Math.min(14000, 4000 + last.text.length * 60) });
  }, [conversation, panelOpen, controller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && store.getState().panelOpen) controller.closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [controller]);

  if (hidden) return null;

  if (minimized) {
    return (
      <div className="pip-root">
        <button type="button" className="pip-mini" onClick={() => controller.restore()} aria-label={`Show ${settings.characterName}`} title={`Show ${settings.characterName}`}>
          <span className="pip-mini-dot" />
        </button>
      </div>
    );
  }

  const label = `${settings.characterName}: ${characterState}${voice.mode === "listening" ? ", listening" : ""}${unread ? `, ${unread} new` : ""}`;

  return (
    <div className={`pip-root${reduced ? " reduced" : ""}`}>
      <Overlay />
      {settings.debugMode && <DebugPanel />}
      <div className="pip-dock">
        {bubble && !panelOpen && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
        {bubble && panelOpen && (bubble.kind === "offer" || bubble.kind === "confirmation" || bubble.kind === "error") && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
        {panelOpen && <Panel controller={controller} />}
        <div className="pip-char-wrap">
          {voice.mode === "listening" && <span className="pip-mic-badge" title="Microphone is on" aria-hidden="true" />}
          {unread > 0 && !panelOpen && <span className="pip-unread" aria-hidden="true">{unread}</span>}
          <button type="button" className={`pip-char-btn${busy ? " busy" : ""}`} onClick={() => controller.togglePanel()} aria-label={label} aria-expanded={panelOpen} title={panelOpen ? "Close" : `Talk to ${settings.characterName}`}>
            <Character state={characterState} level={level} lookAt={lookAt} attention={attention} reducedMotion={reduced} onAnchor={onAnchor} />
          </button>
        </div>
      </div>
    </div>
  );
}
