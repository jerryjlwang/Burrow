import type { RefObject } from "react";
import { store, useStore, type CharacterState } from "../content/store";
import { besidePoint, type PetController } from "./pet";
import { grant, requestJump } from "./handoff";

const STATES: { label: string; state: CharacterState; level?: number }[] = [
  { label: "idle", state: "idle" },
  { label: "listening", state: "listening" },
  { label: "thinking", state: "thinking" },
  { label: "speaking loud", state: "speaking", level: 0.9 },
  { label: "speaking soft", state: "speaking", level: 0.3 },
  { label: "celebrating", state: "celebrating" },
  { label: "confused", state: "confused" },
  { label: "sleeping", state: "sleeping" },
  { label: "error", state: "error" },
  { label: "pointing", state: "pointing" },
];

/** Buttons that drive the pet without voice or a server. Only the pet ref reaches the sprite player. */
function PetControls({ pet }: { pet?: RefObject<PetController | null> }) {
  const attention = useStore((s) => s.attention);
  const reduced = useStore((s) => s.reducedMotion);
  const setChar = (state: CharacterState, level?: number) => store.setState({ characterState: state, ...(level !== undefined ? { audioLevel: level } : {}) });
  const hop = () => {
    const c = pet?.current;
    const r = c?.getBodyRect();
    if (!c || !r) return;
    const onRight = r.left + r.width / 2 > window.innerWidth / 2;
    void c.moveTo(onRight ? 160 : window.innerWidth - 160, window.innerHeight - 150);
  };
  const jumpIn = () => void pet?.current?.jumpIn(new Promise((r) => setTimeout(r, 1500)));
  const hopBy = (dx: number) => {
    const c = pet?.current;
    const r = c?.getBodyRect();
    if (c && r) void c.hopTo(r.left + r.width / 2 + dx);
  };
  const toHeadline = () => {
    const c = pet?.current;
    const body = c?.getBodyRect();
    const h = document.querySelector("h1, h2, h3");
    if (!c || !body || !h) return;
    const t = besidePoint(h.getBoundingClientRect(), body.width, body.height, window.innerWidth);
    void c.goTo(t.x, t.y);
  };
  return (
    <details open>
      <summary>Pet</summary>
      <div className="pip-debug-pet">
        {STATES.map((s) => (
          <button key={s.label} type="button" onClick={() => setChar(s.state, s.level)}>{s.label}</button>
        ))}
      </div>
      <div className="pip-debug-pet">
        {([0, 1, 2] as const).map((a) => (
          <button key={a} type="button" className={attention === a ? "on" : ""} onClick={() => store.setState({ attention: a })}>attention {a}</button>
        ))}
        <button type="button" className={reduced ? "on" : ""} onClick={() => store.setState({ reducedMotion: !reduced })}>reduced motion</button>
      </div>
      <div className="pip-debug-pet">
        <button type="button" onClick={hop}>hop across</button>
        <button type="button" onClick={() => void pet?.current?.jumpOut()}>jump out</button>
        <button type="button" onClick={jumpIn}>jump in (1.5 s)</button>
        <button type="button" onClick={() => pet?.current?.play("wave")}>wave</button>
        <button
          type="button"
          onClick={() =>
            store.setState({
              bubble: {
                id: `debug-${Date.now()}`,
                text: "So a moat is a ditch full of water around a castle? Did I get that right?",
                kind: "offer",
                actions: [
                  { label: "Yes!", value: "accept", primary: true },
                  { label: "Not quite", value: "decline" },
                ],
              },
            })
          }
        >
          show bubble
        </button>
        <button type="button" onClick={() => store.setState({ bubble: null })}>hide bubble</button>
      </div>
      <div className="pip-debug-pet">
        <button type="button" onClick={() => void grant("use_voice")}>grant voice</button>
        <button type="button" onClick={() => void grant("use_voice", false)}>revoke voice</button>
        <button type="button" onClick={() => void requestJump("parent")}>call to parent</button>
        <button type="button" onClick={() => void requestJump("kid")}>send to kid</button>
      </div>
      <div className="pip-debug-pet">
        <button type="button" onClick={() => hopBy(-150)}>hop left</button>
        <button type="button" onClick={() => hopBy(150)}>hop right</button>
        <button type="button" onClick={() => void pet?.current?.fling(-900, -700)}>throw</button>
        <button type="button" onClick={toHeadline}>go to headline</button>
        <button type="button" onClick={() => void pet?.current?.wanderNow()}>wander now</button>
      </div>
      <div className="pip-debug-pet">
        <button type="button" onClick={() => void pet?.current?.resize(4)}>grow 4x</button>
        <button type="button" onClick={() => void pet?.current?.resize(2)}>shrink 2x</button>
        <button type="button" onClick={() => void pet?.current?.resize(3)}>normal 3x</button>
      </div>
    </details>
  );
}

export function DebugPanel({ pet }: { pet?: RefObject<PetController | null> }) {
  const page = useStore((s) => s.page);
  const debug = useStore((s) => s.debug);
  const signals = useStore((s) => s.signals);
  const characterState = useStore((s) => s.characterState);
  const voice = useStore((s) => s.voice);
  const logs = useStore((s) => s.logs);
  return (
    <aside className="pip-debug" aria-label="Developer panel">
      <h4>Burrow dev</h4>
      <div className="pip-debug-grid">
        <span>character</span><b>{characterState}</b>
        <span>voice</span><b>{voice.mode}{voice.ttsPlaying ? " · tts" : ""}{voice.serverOk === false ? " · server ✗" : voice.serverOk ? " · server ✓" : ""}</b>
        <span>goal</span><b>{debug.goal ?? "none"}</b>
        <span>transcript</span><b>{debug.lastTranscript ?? "none"}</b>
        <span>provider</span><b>{debug.provider ?? "none"}{debug.degraded ? " (degraded)" : ""}{debug.latencyMs != null ? ` · ${debug.latencyMs}ms` : ""}</b>
        <span>decision</span><b>{debug.lastDecision ? `${debug.lastDecision.action}${debug.lastDecision.elementId != null ? ` #${debug.lastDecision.elementId}` : ""}: ${debug.lastDecision.reason}` : "none"}</b>
        <span>result</span><b>{debug.lastResult ? `${debug.lastResult.ok ? "ok" : "fail"}: ${debug.lastResult.message}` : "none"}</b>
        <span>proactive</span><b>L{debug.proactiveLevel} · s={signals.strength.toFixed(2)} · {signals.summary.join("; ") || "quiet"}</b>
        <span>page</span><b>{page ? `${page.elements.length} elements (${page.truncatedElements} dropped) · ${page.errors.length} errors · quiz=${page.hasQuizUi ? "y" : "n"}${page.isPdf ? " · pdf" : ""}` : "none"}</b>
      </div>
      <PetControls pet={pet} />
      <details>
        <summary>Elements</summary>
        <ol className="pip-debug-els">
          {page?.elements.map((e) => (
            <li key={e.id} value={e.id}>
              <code>{e.role}</code> {e.name}
              {e.disabled ? " [disabled]" : ""}
              {e.checked ? " [checked]" : ""}
              {e.sensitive ? " [sensitive]" : ""}
              {!e.inViewport ? " (offscreen)" : ""}
            </li>
          ))}
        </ol>
      </details>
      <details>
        <summary>Page text</summary>
        <pre>{page?.textSummary}</pre>
      </details>
      <details open>
        <summary>Log</summary>
        <ul className="pip-debug-log">
          {logs.slice(-25).map((l, i) => (
            <li key={i} className={`lvl-${l.level}`}>
              <code>[{l.ns}]</code> {l.message}
              {l.data !== undefined ? <span> {JSON.stringify(l.data).slice(0, 160)}</span> : null}
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
