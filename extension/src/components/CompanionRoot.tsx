import { useCallback, useEffect, useRef, useState } from "react";
import { store, useStore } from "../content/store";
import type { CompanionController } from "../content/controller";
import { Character } from "./Character";
import type { PetBox, PetController } from "./pet";
import { Panel } from "./Panel";
import { Bubble } from "./Bubble";
import { Overlay } from "./Overlay";
import { DebugPanel } from "./DebugPanel";

/** Must match .pip-dock right/bottom/gap and .pip-panel width in styles.css. */
const DOCK_EDGE = 18;
const DOCK_GAP = 10;
const PANEL_WIDTH = 350;

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

  // The pet reports where it wants to be; the whole dock (pet, bubble, panel) moves with it.
  const [petBox, setPetBox] = useState<PetBox | null>(null);
  const onPosition = useCallback((box: PetBox) => setPetBox(box), []);
  const petRef = useRef<PetController | null>(null);
  const onController = useCallback((c: PetController | null) => {
    petRef.current = c;
  }, []);

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
  // Bubble and panel stack on whichever side of the pet has more room, hang off its right edge,
  // nudge right when the pet sits too far left for them to fit, and shrink to the room available.
  let dockStyle: React.CSSProperties | undefined;
  let stackStyle: React.CSSProperties | undefined;
  let below = false;
  if (petBox) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const right = vw - (petBox.left + petBox.width);
    const roomAbove = petBox.top;
    const roomBelow = vh - (petBox.top + petBox.height);
    below = roomBelow > roomAbove;
    dockStyle = below ? { right, top: petBox.top, bottom: "auto" } : { right, bottom: vh - (petBox.top + petBox.height) };
    const fits = vw - DOCK_EDGE - PANEL_WIDTH;
    const shift = Math.min(Math.max(0, right - fits), Math.max(0, right - DOCK_EDGE));
    stackStyle = { marginRight: shift ? -shift : undefined, maxHeight: Math.max(0, (below ? roomBelow : roomAbove) - DOCK_GAP - DOCK_EDGE) };
  }

  return (
    <div className={`pip-root${reduced ? " reduced" : ""}`}>
      <Overlay />
      {settings.debugMode && <DebugPanel pet={petRef} />}
      <div className={`pip-dock${below ? " below" : ""}`} style={dockStyle}>
        <div className="pip-dock-stack" style={stackStyle}>
          {bubble && !panelOpen && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          {bubble && panelOpen && (bubble.kind === "offer" || bubble.kind === "confirmation" || bubble.kind === "error") && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          {panelOpen && <Panel controller={controller} />}
        </div>
        <div className="pip-char-wrap">
          {voice.mode === "listening" && <span className="pip-mic-badge" title="Microphone is on" aria-hidden="true" />}
          {unread > 0 && !panelOpen && <span className="pip-unread" aria-hidden="true">{unread}</span>}
          <button type="button" className={`pip-char-btn${busy ? " busy" : ""}`} onClick={() => controller.togglePanel()} aria-label={label} aria-expanded={panelOpen} title={panelOpen ? "Close" : `Talk to ${settings.characterName}`}>
            <Character state={characterState} level={level} lookAt={lookAt} attention={attention} reducedMotion={reduced} onAnchor={onAnchor} onPosition={onPosition} onController={onController} />
          </button>
        </div>
      </div>
    </div>
  );
}
