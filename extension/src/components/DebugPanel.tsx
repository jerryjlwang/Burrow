import { useStore } from "../content/store";

export function DebugPanel() {
  const page = useStore((s) => s.page);
  const debug = useStore((s) => s.debug);
  const signals = useStore((s) => s.signals);
  const characterState = useStore((s) => s.characterState);
  const voice = useStore((s) => s.voice);
  const logs = useStore((s) => s.logs);
  const offline = useStore((s) => s.offline);
  return (
    <aside className="pip-debug" aria-label="Developer panel">
      <h4>Pip dev</h4>
      <div className="pip-debug-grid">
        <span>character</span><b>{characterState}</b>
        <span>voice</span><b>{voice.mode}{voice.ttsPlaying ? " · tts" : ""}{voice.serverOk === false || offline ? " · server ✗" : voice.serverOk ? " · server ✓" : ""}</b>
        <span>goal</span><b>{debug.goal ?? "—"}</b>
        <span>transcript</span><b>{debug.lastTranscript ?? "—"}</b>
        <span>provider</span><b>{debug.provider ?? "—"}{debug.degraded ? " (degraded)" : ""}{debug.latencyMs != null ? ` · ${debug.latencyMs}ms` : ""}</b>
        <span>decision</span><b>{debug.lastDecision ? `${debug.lastDecision.action}${debug.lastDecision.elementId != null ? ` #${debug.lastDecision.elementId}` : ""} — ${debug.lastDecision.reason}` : "—"}</b>
        <span>result</span><b>{debug.lastResult ? `${debug.lastResult.ok ? "ok" : "fail"}: ${debug.lastResult.message}` : "—"}</b>
        <span>proactive</span><b>L{debug.proactiveLevel} · s={signals.strength.toFixed(2)} · {signals.summary.join("; ") || "quiet"}</b>
        <span>page</span><b>{page ? `${page.elements.length} elements (${page.truncatedElements} dropped) · ${page.errors.length} errors · quiz=${page.hasQuizUi ? "y" : "n"}${page.isPdf ? " · pdf" : ""}` : "—"}</b>
      </div>
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
