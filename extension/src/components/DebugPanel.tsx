import type { RefObject } from "react";
import { judgeInkMock, type InkReason } from "@shared/ink";
import { store, useStore, type CharacterState } from "../content/store";
import { besidePoint, type PetController } from "./pet";
import { grant, requestJump } from "./handoff";

/** A scripted tablet verdict, delivered the way the watcher's broadcast is, so the coach and the nudge rehearse without a tablet. */
function judgeOut(reason: InkReason, seq: number, rung: number): void {
  const task = { title: document.title, url: location.href };
  const judgement = judgeInkMock({ frame: "", context: null, contextTitle: task.title, contextUrl: task.url, previousLines: [], seq, reason, rung, lastWrongLine: null });
  window.dispatchEvent(new CustomEvent("burrow:judge", { detail: { judgement, meta: { reason, rung, task } } }));
}

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

/** Synthetic "burrow:act" and "burrow:video" events, shaped as the executor and the video watcher send them. */
function actOut(action: string, target: string | null, extra: { url?: string; text?: string; direction?: "up" | "down" } = {}): void {
  const r = target ? document.querySelector(target)?.getBoundingClientRect() ?? null : null;
  const rect = r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  window.dispatchEvent(new CustomEvent("burrow:act", { detail: { action, elementId: null, rect, point: null, url: extra.url ?? null, text: extra.text ?? null, direction: extra.direction ?? null } }));
}
function videoOut(kind: "pause" | "play" | "seek", by: "us" | "them" = "us"): void {
  const r = document.querySelector("video")?.getBoundingClientRect();
  const rect = r ? { x: r.x, y: r.y, width: r.width, height: r.height } : { x: Math.round(window.innerWidth * 0.2), y: Math.round(window.innerHeight * 0.15), width: Math.round(window.innerWidth * 0.5), height: Math.round(window.innerHeight * 0.4) };
  window.dispatchEvent(new CustomEvent("burrow:video", { detail: { kind, by, rect } }));
}

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
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("burrow:point", { detail: { selector: "header a.btn, main h1, h1, main a, a", label: "Look here" } }))}>point: here</button>
        <button type="button" onClick={() => actOut("open_tab", null, { url: "https://example.com" })}>act: open tab</button>
        <button type="button" onClick={() => actOut("switch_tab", null)}>act: switch tab</button>
        <button type="button" onClick={() => actOut("navigate", null, { url: "https://example.com" })}>act: navigate</button>
        <button type="button" onClick={() => actOut("go_back", null)}>act: go back</button>
        <button type="button" onClick={() => actOut("click", "main button, main a, button, a, h1")}>act: click</button>
        <button type="button" onClick={() => actOut("type", "input:not([type=hidden]), textarea", { text: "castles" })}>act: type</button>
        <button type="button" onClick={() => actOut("press_enter", "input:not([type=hidden]), textarea")}>act: enter</button>
        <button type="button" onClick={() => actOut("scroll", null, { direction: "down" })}>act: scroll</button>
        <button type="button" onClick={() => actOut("drag", "main button, button, h1")}>act: drag</button>
        <button type="button" onClick={() => videoOut("pause")}>video: pause</button>
        <button type="button" onClick={() => videoOut("play")}>video: play</button>
        <button type="button" onClick={() => videoOut("seek", "them")}>video: seek</button>
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
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("burrow:teach", { detail: { heard: "So a moat is a ditch with water?", concept: "moats" } }))}>teach card</button>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("burrow:forget", { detail: { concept: "moats" } }))}>forget</button>
        <button
          type="button"
          onClick={() =>
            store.setState({
              board: { id: `debug-${Date.now()}`, title: "Solve 3x + 5 = 20", items: ["3x + 5 = 20", "3x = 15", "x = 5"].map((text) => ({ kind: "text" as const, text })), anchor: null },
              planView: null,
            })
          }
        >
          chalkboard
        </button>
      </div>
      <div className="pip-debug-pet">
        <button type="button" onClick={() => judgeOut("ink", 1, 1)}>ink: slip</button>
        <button type="button" onClick={() => judgeOut("ink", 1, 2)}>ink: slip, rung 2</button>
        <button type="button" onClick={() => judgeOut("stall", 1, 2)}>ink: stall note</button>
        <button type="button" onClick={() => judgeOut("ink", 2, 1)}>ink: solved</button>
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
