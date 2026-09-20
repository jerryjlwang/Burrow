import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSettings, setSettings, type Settings } from "../shared/settings";
import type { ServerHealth, VoiceState } from "../shared/messages";

/* The toolbar card: his face, one status line, the actions, and the same toggles as his panel. */
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
  const openTab = (u: string) => {
    void chrome.tabs.create({ url: u });
  };

  if (!settings) return null;

  // One status line on the band: the server. The dot carries the voice state, and anything that needs
  // a sentence goes in a note under the band.
  const listening = voice?.mode === "listening";
  const voiceError = voice?.mode === "error" ? voice.error || "Voice trouble. Try again." : "";
  let dot = "wait";
  let line = "Checking my server";
  if (health && !health.ok) {
    dot = "bad";
    line = "Server not running";
  } else if (health) {
    dot = voiceError ? "bad" : listening ? "live" : "ok";
    line = "Server connected";
  }
  const notes: string[] = [];
  if (health && !health.ok) notes.push("Start it with npm run dev, then open this again.");
  if (voiceError) notes.push(voiceError);
  else if (listening) notes.push("Listening right now.");
  else if (health?.ok && !health.deepgram) notes.push("No Deepgram key on the server, so no voice.");
  if (!tabOk) notes.push("He can't run on this page. Chrome's own pages are protected.");

  return (
    <div className="card px-frame">
      <div className="head">
        <img className="face" src="icons/icon48.png" width={48} height={48} alt="" />
        <div className="who">
          <strong>{settings.characterName}</strong>
          <span className="line">
            <span className={`dot ${dot}`} aria-hidden="true" />
            <span aria-live="polite">{line}</span>
          </span>
        </div>
      </div>
      <div className="body">
        {notes.map((n) => (
          <p key={n} className="note">
            {n}
          </p>
        ))}
        <div className="actions">
          <button className="px-btn primary" disabled={!tabOk} onClick={() => void sendCommand("toggle-companion")}>
            Open his panel
          </button>
          <button className="px-btn" disabled={!tabOk} onClick={() => void sendCommand("toggle-voice")}>
            {listening ? "Mute voice" : "Start voice"}
          </button>
          <div className="links">
            <button className="link" onClick={() => openTab(chrome.runtime.getURL("onboarding.html"))}>
              Setup
            </button>
            <button className="link" onClick={() => openTab(`${settings.serverUrl}/demo/`)}>
              Demo
            </button>
            <button className="link" onClick={() => openTab(chrome.runtime.getURL("parent.html"))}>
              Parent view
            </button>
          </div>
        </div>
        <div className="settings">
          <label className="px-toggle">
            <input className="px-check" type="checkbox" checked={settings.proactiveEnabled} onChange={(e) => void update({ proactiveEnabled: e.target.checked })} />
            <span>Offer help when I'm stuck</span>
          </label>
          <label className="px-toggle">
            <input className="px-check" type="checkbox" checked={settings.ttsEnabled} onChange={(e) => void update({ ttsEnabled: e.target.checked })} />
            <span>Speak replies out loud</span>
          </label>
          <label className="px-toggle">
            <input className="px-check" type="checkbox" checked={settings.debugMode} onChange={(e) => void update({ debugMode: e.target.checked })} />
            <span>Developer panel</span>
          </label>
        </div>
        <label className="server">
          <span className="px-muted">Local server</span>
          <input className="px-input" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => void update({ serverUrl: url.trim().replace(/\/$/, "") || "http://localhost:8787" })} />
          {health?.ok && <span className="px-muted model">Model: {health.llm}</span>}
        </label>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
