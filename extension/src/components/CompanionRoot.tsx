import { useCallback, useEffect, useRef, useState } from "react";
import { store, useStore } from "../content/store";
import type { CompanionController } from "../content/controller";
import { Character } from "./Character";
import { besidePoint, type PetBox, type PetController } from "./pet";
import { Panel } from "./Panel";
import { Bubble } from "./Bubble";
import { TeachCard } from "./TeachCard";
import { Overlay } from "./Overlay";
import { Board } from "./Board";
import { PlanMap } from "./PlanMap";
import { DebugPanel } from "./DebugPanel";
import { escort, pageRole, readArrival, startHandoff, type Arrival } from "./handoff";
import { armSounds, playCue, setSoundsEnabled } from "./sounds";

/** Must match .pip-dock right/bottom/gap and .pip-panel width in styles.css. */
const DOCK_EDGE = 18;
const DOCK_GAP = 10;
const PANEL_WIDTH = 351;
/** When this page took over. Replies older than this were shown on the page before; they don't type again here. */
const LOADED_AT = Date.now();

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

  // Arriving from a page he escorted? Then he starts in the hole and pops out with a line.
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const arrivalRef = useRef<Arrival | null>(null);
  useEffect(() => {
    void readArrival().then((a) => {
      if (!a) return;
      arrivalRef.current = a;
      setArrival(a);
      try {
        chrome.storage.local.remove("burrow.arrive");
      } catch {
        /* ignore */
      }
    });
  }, []);
  // The new tab page draws its world first and then says "burrow:enter"; he stays in the hole until then
  // (or 3.5 s at most, so a broken page never hides him).
  const bootPage = useRef(/\/newtab\.html$/.test(location.pathname));
  const enterWaiters = useRef<(() => void)[]>([]);
  const entered = useRef(false);
  useEffect(() => {
    if (!bootPage.current) return;
    const go = () => {
      if (entered.current) return;
      entered.current = true;
      const w = enterWaiters.current;
      enterWaiters.current = [];
      for (const f of w) f();
    };
    window.addEventListener("burrow:enter", go);
    const fallback = window.setTimeout(go, 3500);
    return () => {
      window.removeEventListener("burrow:enter", go);
      window.clearTimeout(fallback);
    };
  }, []);
  const onControllerWithArrival = useCallback(
    (c: PetController | null) => {
      onController(c);
      if (!c) return;
      const a = arrivalRef.current;
      if (a) {
        arrivalRef.current = null;
        void c.jumpIn(new Promise((r) => setTimeout(r, 500))).then(() => {
          controller.showBubble({ id: `arrive-${a.at}`, text: a.line ?? "Here we are!", kind: "info", expiresAt: Date.now() + 6000 });
        });
        return;
      }
      if (bootPage.current) {
        const ready = entered.current ? Promise.resolve() : new Promise<void>((r) => enterWaiters.current.push(r));
        void c.jumpIn(ready);
      }
    },
    [onController, controller],
  );

  // Pages can ask the rabbit for things: "burrow:goto" {x, y} hops or hole-travels him so his body
  // center lands there, "burrow:play" {state} plays a manifest state, "burrow:leave" {url, line?,
  // arriveLine?} makes him dive before the page navigates. Used by the new tab scene.
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent<{ x: number; y: number }>).detail;
      if (d && Number.isFinite(d.x) && Number.isFinite(d.y)) void petRef.current?.goTo(d.x, d.y);
    };
    const onPlay = (e: Event) => {
      const d = (e as CustomEvent<{ state: string }>).detail;
      if (d?.state) petRef.current?.play(d.state);
    };
    const onLeave = (e: Event) => {
      const d = (e as CustomEvent<{ url: string; line?: string; arriveLine?: string }>).detail;
      if (d?.url) void escort(controller, petRef.current, d.url, d.line ?? "Let's go find out!", d.arriveLine ?? "Here's what I found. Want me to read it?");
    };
    window.addEventListener("burrow:goto", onGoto);
    window.addEventListener("burrow:play", onPlay);
    window.addEventListener("burrow:leave", onLeave);
    return () => {
      window.removeEventListener("burrow:goto", onGoto);
      window.removeEventListener("burrow:play", onPlay);
      window.removeEventListener("burrow:leave", onLeave);
    };
  }, [controller]);
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

  // Push to talk: one press starts listening, the next stops it.
  const talkRight = !!petBox && petBox.left < 90;
  const listening = voice.mode === "listening";

  // A new highlight under the open panel closes the panel so the ring can be seen; a new "point"
  // highlight while the panel is closed sends him to stand beside it.
  const seenHighlights = useRef(new Set<string>());
  useEffect(() => {
    const key = (h: (typeof highlights)[number]) => `${h.id}:${h.kind}:${h.expiresAt}`;
    const fresh = highlights.filter((h) => !seenHighlights.current.has(key(h)));
    seenHighlights.current = new Set(highlights.map(key));
    if (!fresh.length) return;
    if (panelOpen) {
      const panel = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-panel")?.getBoundingClientRect();
      const under = !!panel && fresh.some((h) => h.rect.x < panel.right && panel.left < h.rect.x + h.rect.width && h.rect.y < panel.bottom && panel.top < h.rect.y + h.rect.height);
      if (under) controller.closePanel();
      return;
    }
    const points = fresh.filter((h) => h.kind === "point");
    if (!points.length) return;
    const pet = petRef.current;
    const body = pet?.getBodyRect();
    if (!pet || !body) return;
    const target = besidePoint(points[points.length - 1].rect, body.width, body.height, window.innerWidth);
    if (Math.hypot(target.x - (body.left + body.width / 2), target.y - (body.top + body.height / 2)) < 60) return;
    void pet.goTo(target.x, target.y);
  }, [highlights, panelOpen, controller]);

  // Show the latest short companion reply as a bubble while the panel is closed. A reply is shown
  // once: one that arrived while the panel was open was read there, and one from before this page
  // loaded was typed out on the page before, so neither types again.
  const seenReplyAt = useRef(LOADED_AT);
  useEffect(() => {
    const last = conversation[conversation.length - 1];
    if (!last || last.role !== "companion" || last.kind === "offer" || last.kind === "confirmation") return;
    if (last.at <= seenReplyAt.current) return;
    if (panelOpen) {
      seenReplyAt.current = last.at;
      return;
    }
    const s = store.getState();
    if (s.bubble && (s.bubble.kind === "offer" || s.bubble.kind === "confirmation")) return;
    seenReplyAt.current = last.at;
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
      <Board />
      <PlanMap controller={controller} />
      {settings.debugMode && <DebugPanel pet={petRef} />}
      <div className={`pip-dock${below ? " below" : ""}`} style={dockStyle}>
        <div className="pip-dock-stack" style={stackStyle}>
          {bubble && !panelOpen && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          {bubble && panelOpen && (bubble.kind === "offer" || bubble.kind === "confirmation" || bubble.kind === "error") && <Bubble bubble={bubble} onAction={(v) => controller.bubbleAction(v)} />}
          <TeachCard controller={controller} />
          {panelOpen && <Panel controller={controller} />}
        </div>
        <div className="pip-char-wrap">
          <button
            type="button"
            className={`pip-talk${listening ? " on" : ""}${voice.mode === "starting" ? " starting" : ""}${talkRight ? " right" : ""}`}
            aria-label={listening ? "Listening. Press to stop." : "Talk to him"}
            aria-pressed={listening}
            title={listening ? "Listening. Press to stop." : "Talk"}
            onClick={() => void controller.toggleVoice()}
          >
            <span className="pip-talk-meter" style={{ height: listening ? Math.round(level * 8) * 3 : 0 }} aria-hidden="true" />
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3M9 21h6" />
            </svg>
          </button>
          {voice.mode === "listening" && <span className="pip-mic-badge" title="Microphone is on" aria-hidden="true" />}
          {unread > 0 && !panelOpen && bubble?.kind !== "reply" && <span className="pip-unread" aria-hidden="true">{unread}</span>}
          <button type="button" className={`pip-char-btn${busy ? " busy" : ""}`} onClick={() => controller.charClicked()} aria-label={label} aria-expanded={panelOpen} title={panelOpen ? "Close" : `Talk to ${settings.characterName}`}>
            <Character state={characterState} level={level} lookAt={lookAt} attention={attention} reducedMotion={reduced} scale={petScale} onAnchor={onAnchor} onPosition={onPosition} onController={onControllerWithArrival} quiet={quiet} onShown={onShown} startHidden={!!arrival || bootPage.current} />
          </button>
        </div>
      </div>
    </div>
  );
}
