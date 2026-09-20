import { useCallback, useEffect, useRef, useState } from "react";
import { store, useStore } from "../content/store";
import type { CompanionController } from "../content/controller";
import { Character } from "./Character";
import { besidePoint, type PetBox, type PetController } from "./pet";
import { Panel } from "./Panel";
import { Bubble } from "./Bubble";
import { Overlay } from "./Overlay";
import { DebugPanel } from "./DebugPanel";
import { pageRole, startHandoff } from "./handoff";
import { armSounds, playCue, setSoundsEnabled } from "./sounds";

/** Must match .pip-dock right/bottom/gap and .pip-panel width in styles.css. */
const DOCK_EDGE = 18;
const DOCK_GAP = 10;
const PANEL_WIDTH = 350;
/** A press shorter than this is a tap: it leaves voice on until the next tap. */
const TAP_MS = 350;
/** After a held press ends, wait this long before stopping so the last words land. */
const RELEASE_GRACE_MS = 800;

function assetUrl(path: string): string {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) return chrome.runtime.getURL(path);
  } catch {
    /* not an extension context */
  }
  return path;
}

/** The pixel UI pieces, handed to the stylesheet as url() variables. */
const UI_VARS = {
  "--ui-bubble": `url("${assetUrl("ui/bubble.png")}")`,
  "--ui-bubble-teal": `url("${assetUrl("ui/bubble_teal.png")}")`,
  "--ui-tail": `url("${assetUrl("ui/bubble_tail.png")}")`,
  "--ui-btn": `url("${assetUrl("ui/button.png")}")`,
  "--ui-btn-primary": `url("${assetUrl("ui/button_primary.png")}")`,
  "--ui-btn-quiet": `url("${assetUrl("ui/button_quiet.png")}")`,
  "--ui-btn-alert": `url("${assetUrl("ui/button_alert.png")}")`,
  "--ui-ear": `url("${assetUrl("ui/ear.png")}")`,
} as React.CSSProperties;

let fontRequested = false;
/** Loads the kid font through the FontFace API. @font-face does not work inside a shadow root, and this path is not subject to page CSP. */
function loadKidFont(): void {
  if (fontRequested || typeof FontFace === "undefined" || !document.fonts) return;
  fontRequested = true;
  try {
    const face = new FontFace("Burrow Pixel", `url("${assetUrl("fonts/PixelifySans.ttf")}")`, { weight: "400 700", display: "swap" });
    face.load().then((f) => document.fonts.add(f)).catch(() => undefined);
  } catch {
    /* font stays on the fallback */
  }
}

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
  const highlights = useStore((s) => s.highlights);

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

  // Nothing going on: the pet may wander now and then.
  const quiet = !panelOpen && !bubble && characterState === "idle" && voice.mode === "off";

  useEffect(() => loadKidFont(), []);

  // Pages can ask the rabbit for things: "burrow:goto" {x, y} hops or hole-travels him so his body
  // center lands there, "burrow:play" {state} plays a manifest state. Used by the new tab scene.
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent<{ x: number; y: number }>).detail;
      if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) void petRef.current?.goTo(d.x, d.y);
    };
    const onPlay = (e: Event) => {
      const d = (e as CustomEvent<{ state: string }>).detail;
      if (d?.state) petRef.current?.play(d.state);
    };
    window.addEventListener("burrow:goto", onGoto);
    window.addEventListener("burrow:play", onPlay);
    return () => {
      window.removeEventListener("burrow:goto", onGoto);
      window.removeEventListener("burrow:play", onPlay);
    };
  }, []);
  useEffect(() => armSounds(), []);
  useEffect(() => setSoundsEnabled(settings.ttsEnabled), [settings.ttsEnabled]);
  const onShown = useCallback((s: string) => playCue(s), []);
  // On the parent's laptop he arrives one size bigger: the hero moment.
  const petScale = pageRole() === "parent" ? 4 : 3;

  // Grants, the jump between laptops, and the "I'm late" vignette. See docs/frontend/HANDOFF.md.
  const quietRef = useRef(quiet);
  quietRef.current = quiet;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  useEffect(
    () => startHandoff({ controller, role: pageRole(), getPet: () => petRef.current, isQuiet: () => quietRef.current, reducedMotion: () => reducedRef.current }),
    [controller],
  );

  // Hold to talk. A tap turns voice on (or off when it was on); a hold listens until release plus a grace period.
  const press = useRef<{ at: number; wasOn: boolean } | null>(null);
  const stopTimer = useRef<number | null>(null);
  const clearStop = () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
  };
  const onTalkDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    clearStop();
    const mode = store.getState().voice.mode;
    const wasOn = mode === "listening" || mode === "starting";
    press.current = { at: Date.now(), wasOn };
    if (!wasOn) void controller.toggleVoice();
  };
  const onTalkUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    const held = Date.now() - p.at;
    const stopIfOn = () => {
      const mode = store.getState().voice.mode;
      if (mode === "listening" || mode === "starting") void controller.toggleVoice();
    };
    if (p.wasOn) {
      if (held < TAP_MS) stopIfOn();
      return;
    }
    if (held >= TAP_MS) stopTimer.current = window.setTimeout(stopIfOn, RELEASE_GRACE_MS);
  };
  const talkRight = !!petBox && petBox.left < 90;
  const listening = voice.mode === "listening";

  // When a new "point" highlight appears while the panel is closed, go stand beside it.
  const seenPoints = useRef(new Set<string>());
  useEffect(() => {
    const points = highlights.filter((h) => h.kind === "point");
    const key = (h: (typeof points)[number]) => `${h.id}:${h.expiresAt}`;
    const fresh = points.filter((h) => !seenPoints.current.has(key(h)));
    seenPoints.current = new Set(points.map(key));
    if (panelOpen || !fresh.length) return;
    const pet = petRef.current;
    const body = pet?.getBodyRect();
    if (!pet || !body) return;
    const target = besidePoint(fresh[fresh.length - 1].rect, body.width, body.height, window.innerWidth);
    if (Math.hypot(target.x - (body.left + body.width / 2), target.y - (body.top + body.height / 2)) < 60) return;
    void pet.goTo(target.x, target.y);
  }, [highlights, panelOpen]);

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
      <div className="pip-root" style={UI_VARS}>
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
    <div className={`pip-root${reduced ? " reduced" : ""}`} style={UI_VARS}>
      <Overlay />
      {settings.debugMode && <DebugPanel pet={petRef} />}
      <div className={`pip-dock${below ? " below" : ""}`} style={dockStyle}>
        <div className="pip-dock-stack" style={stackStyle}>
          {bubble && !panelOpen && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          {bubble && panelOpen && (bubble.kind === "offer" || bubble.kind === "confirmation" || bubble.kind === "error") && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          {panelOpen && <Panel controller={controller} />}
        </div>
        <div className="pip-char-wrap">
          <button
            type="button"
            className={`pip-talk${listening ? " on" : ""}${voice.mode === "starting" ? " starting" : ""}${talkRight ? " right" : ""}`}
            aria-label={listening ? "Listening. Let go or tap to stop." : "Hold to talk"}
            aria-pressed={listening}
            onPointerDown={onTalkDown}
            onPointerUp={onTalkUp}
            onPointerCancel={onTalkUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <span className="pip-talk-meter" style={{ height: listening ? Math.round(level * 14) * 3 : 0 }} aria-hidden="true" />
            <span className="pip-talk-ear" aria-hidden="true" />
            <span className="pip-talk-label" aria-hidden="true">{listening ? "Listening" : "Hold to talk"}</span>
          </button>
          {voice.mode === "listening" && <span className="pip-mic-badge" title="Microphone is on" aria-hidden="true" />}
          {unread > 0 && !panelOpen && <span className="pip-unread" aria-hidden="true">{unread}</span>}
          <button type="button" className={`pip-char-btn${busy ? " busy" : ""}`} onClick={() => controller.togglePanel()} aria-label={label} aria-expanded={panelOpen} title={panelOpen ? "Close" : `Talk to ${settings.characterName}`}>
            <Character state={characterState} level={level} lookAt={lookAt} attention={attention} reducedMotion={reduced} scale={petScale} onAnchor={onAnchor} onPosition={onPosition} onController={onController} quiet={quiet} onShown={onShown} />
          </button>
        </div>
      </div>
    </div>
  );
}
