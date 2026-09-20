import { useEffect, useRef, useState } from "react";
import { plainCopy } from "./copy";
import { useStore } from "../content/store";
import type { CompanionController } from "../content/controller";

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill={active ? "currentColor" : "none"} />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function Panel({ controller }: { controller: CompanionController }) {
  const conversation = useStore((s) => s.conversation);
  const interim = useStore((s) => s.interimTranscript);
  const voice = useStore((s) => s.voice);
  const status = useStore((s) => s.status);
  const busy = useStore((s) => s.busy);
  const settings = useStore((s) => s.settings);
  const characterState = useStore((s) => s.characterState);
  const [text, setText] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length, interim]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void controller.handleUserText(t, "text");
  };

  const listening = voice.mode === "listening";
  const statusText = status || (characterState === "speaking" ? "Speaking…" : busy ? "Thinking…" : listening ? "Listening…" : "Here if you need me");

  return (
    <section className="pip-panel" role="dialog" aria-label={`${settings.characterName} conversation`}>
      <header className="pip-panel-head">
        <div className="pip-panel-title">
          <strong>{settings.characterName}</strong>
          <span className={`pip-status${listening ? " live" : ""}`} aria-live="polite">
            {listening && <span className="pip-live-dot" aria-hidden="true" />}
            {statusText}
          </span>
        </div>
        <div className="pip-panel-tools">
          {characterState === "speaking" && (
            <button type="button" className="pip-icon-btn" title="Stop speaking" aria-label="Stop speaking" onClick={() => controller.stopSpeaking()}>
              ■
            </button>
          )}
          <button type="button" className="pip-icon-btn" title="Settings" aria-label="Settings" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
            ⚙
          </button>
          <button type="button" className="pip-icon-btn" title="Minimize" aria-label="Minimize companion" onClick={() => controller.minimize()}>
            –
          </button>
          <button type="button" className="pip-icon-btn" title="Close" aria-label="Close panel" onClick={() => controller.closePanel()}>
            ×
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="pip-settings">
          <label className="pip-toggle">
            <input type="checkbox" checked={settings.proactiveEnabled} onChange={(e) => void controller.updateSetting({ proactiveEnabled: e.target.checked })} />
            <span>Notice when I'm stuck and offer help</span>
          </label>
          <label className="pip-toggle">
            <input type="checkbox" checked={settings.ttsEnabled} onChange={(e) => void controller.updateSetting({ ttsEnabled: e.target.checked })} />
            <span>Speak replies out loud</span>
          </label>
          <label className="pip-toggle">
            <input type="checkbox" checked={settings.debugMode} onChange={(e) => void controller.updateSetting({ debugMode: e.target.checked })} />
            <span>Developer panel</span>
          </label>
          <div className="pip-settings-links">
            <button type="button" className="pip-link" onClick={() => controller.openOnboarding()}>
              Microphone & privacy setup
            </button>
            <button type="button" className="pip-link" onClick={() => controller.openDemo()}>
              Open demo pages
            </button>
          </div>
        </div>
      )}

      <div className="pip-messages" ref={listRef} aria-live="polite" aria-relevant="additions">
        {conversation.length === 0 && (
          <div className="pip-empty">
            <p>Hi! I can see this page. Try:</p>
            <ul>
              <li>“What’s on this page?”</li>
              <li>“Where’s the sign in button?”</li>
              <li>“Give me a hint.”</li>
            </ul>
          </div>
        )}
        {conversation.map((t, i) => (
          <div key={`${t.at}-${i}`} className={`pip-msg ${t.role}${t.kind ? ` kind-${t.kind}` : ""}`}>
            <div className="pip-msg-text">{plainCopy(t.text)}</div>
            {t.detail && t.detail !== t.text && (
              <details className="pip-msg-detail" onToggle={(e) => e.currentTarget.open && e.currentTarget.scrollIntoView({ block: "nearest" })}>
                <summary>More</summary>
                <pre>{plainCopy(t.detail)}</pre>
              </details>
            )}
          </div>
        ))}
        {interim && (
          <div className="pip-msg user interim">
            <div className="pip-msg-text">{interim}</div>
          </div>
        )}
      </div>

      {voice.mode === "error" && voice.error && <div className="pip-offline">{voice.error}</div>}

      <form
        className="pip-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          className={`pip-mic${listening ? " on" : ""}${voice.mode === "starting" ? " starting" : ""}`}
          aria-pressed={listening}
          aria-label={listening ? "Turn off voice mode" : "Turn on voice mode"}
          title={listening ? "Voice mode is on (click to mute)" : "Start voice mode"}
          onClick={() => void controller.toggleVoice()}
        >
          <MicIcon active={listening} />
        </button>
        <input
          ref={inputRef}
          className="pip-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={listening ? "Listening, or type" : "Ask me anything"}
          aria-label="Message"
          autoComplete="off"
        />
        <button type="submit" className="pip-send" aria-label="Send" disabled={!text.trim()}>
          ➤
        </button>
      </form>
    </section>
  );
}
