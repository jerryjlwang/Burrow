import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSettings, setSettings, type Settings } from "../shared/settings";
import type { ServerHealth, VoiceState } from "../shared/messages";

function Popup() {
  const [settings, setLocal] = useState<Settings | null>(null);
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const [tabOk, setTabOk] = useState(true);
  const [url, setUrl] = useState("");

  useEffect(() => {
    void getSettings().then((s) => {
      setLocal(s);
      setUrl(s.serverUrl);
    });
    chrome.runtime.sendMessage({ type: "server.health" }, (h: ServerHealth) => setHealth(h ?? { ok: false }));
    chrome.runtime.sendMessage({ type: "voice.status" }, (v: VoiceState) => setVoice(v ?? null));
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTabOk(!!t?.url && /^https?:|^file:/.test(t.url)));
  }, []);

  const update = async (patch: Partial<Settings>) => {
    const next = await setSettings(patch);
    setLocal(next);
  };
  const sendCommand = async (name: "toggle-companion" | "toggle-voice") => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (t?.id) chrome.tabs.sendMessage(t.id, { type: "command", name }, () => void chrome.runtime.lastError);
    window.close();
  };

  if (!settings) return null;
  return (
    <>
      <h1>{settings.characterName}</h1>
      <p className="sub">Learning companion</p>
      <div className="status">
        <span className={`dot ${health ? (health.ok ? "ok" : "bad") : ""}`} />
        <span>{health ? (health.ok ? `Server connected · ${health.llm}${health.deepgram ? " · voice ready" : " · no Deepgram key"}` : "Server not reachable — start it with npm run dev") : "Checking server…"}</span>
      </div>
      {voice && (
        <div className="status">
          <span className={`dot ${voice.mode === "listening" ? "ok" : voice.mode === "error" ? "bad" : ""}`} />
          <span>{voice.mode === "listening" ? "Microphone is live" : voice.mode === "error" ? voice.error ?? "Voice error" : "Voice mode off"}</span>
        </div>
      )}
      {!tabOk && <p className="muted">{settings.characterName} can't run on this page (Chrome pages and the Web Store are protected).</p>}
      <label className="t">
        <input type="checkbox" checked={settings.proactiveEnabled} onChange={(e) => void update({ proactiveEnabled: e.target.checked })} /> Notice when I'm stuck and offer help
      </label>
      <label className="t">
        <input type="checkbox" checked={settings.ttsEnabled} onChange={(e) => void update({ ttsEnabled: e.target.checked })} /> Speak replies out loud
      </label>
      <label className="t">
        <input type="checkbox" checked={settings.debugMode} onChange={(e) => void update({ debugMode: e.target.checked })} /> Developer panel
      </label>
      <label className="t" style={{ display: "block" }}>
        <span className="muted">Server URL</span>
        <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void update({ serverUrl: url.trim().replace(/\/$/, "") || "http://localhost:8787" })} />
      </label>
      <div className="row">
        <button className="btn primary" disabled={!tabOk} onClick={() => void sendCommand("toggle-companion")}>
          Open panel
        </button>
        <button className="btn" disabled={!tabOk} onClick={() => void sendCommand("toggle-voice")}>
          {voice?.mode === "listening" ? "Mute voice" : "Start voice"}
        </button>
        <button className="btn" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") })}>
          Setup
        </button>
        <button className="btn" onClick={() => void chrome.tabs.create({ url: `${settings.serverUrl}/demo/` })}>
          Demo
        </button>
        <button className="btn" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("parent.html") })}>
          Parent view
        </button>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
