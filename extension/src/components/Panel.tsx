import { useEffect, useRef, useState, type ReactElement } from "react";
import { plainCopy } from "./copy";
import { useStore } from "../content/store";
import type { CompanionController } from "../content/controller";

/* Glyphs for the panel's buttons, hand-placed on a 7 x 7 grid and drawn at 3x so they sit on the same
   pixel grid as the frames. No font symbols: Pixelify Sans has none of these and the fallback would not
   match the rest of the panel. */
const GLYPHS = {
  gear: ["#.###.#", ".#####.", "##...##", "##...##", "##...##", ".#####.", "#.###.#"],
  minus: [".......", ".......", ".......", "#######", ".......", ".......", "......."],
  close: ["##...##", ".##.##.", "..###..", "...#...", "..###..", ".##.##.", "##...##"],
  stop: [".......", ".#####.", ".#####.", ".#####.", ".#####.", ".#####.", "......."],
  mic: ["..###..", "..###..", "..###..", "#.###.#", ".#####.", "...#...", ".#####."],
  send: ["...#...", "...##..", "...###.", "#######", "...###.", "...##..", "...#..."],
  bang: ["..###..", "..###..", "..###..", "..###..", ".......", "..###..", "..###.."],
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  const rows = GLYPHS[name];
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === "#") x += 1;
      rects.push(<rect key={`${y}-${start}`} x={start} y={y} width={x - start} height={1} />);
    }
  });
  return (
    <svg className="pip-glyph" width={rows[0].length * 3} height={rows.length * 3} viewBox={`0 0 ${rows[0].length} ${rows.length}`} shapeRendering="crispEdges" fill="currentColor" aria-hidden="true">
      {rects}
    </svg>
  );
}

/* Three things he can do on any page. A tap fills the input so the kid can change the words first. */
const STARTERS = ["What's on this page?", "Where's the sign in button?", "Give me a hint"];

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

  const pick = (starter: string) => {
    setText(starter);
    inputRef.current?.focus({ preventScroll: true });
  };

  const listening = voice.mode === "listening";
  const speaking = characterState === "speaking";
  const statusText = status || (speaking ? "Speaking" : busy ? "Thinking" : listening ? "Listening" : "Here if you need me");
  const statusClass = `pip-status${listening ? " live" : busy || speaking ? " busy" : ""}`;

  return (
    <section className="pip-panel" role="dialog" aria-label={`${settings.characterName} conversation`}>
      <header className="pip-panel-head">
        <div className="pip-panel-title">
          <strong>{settings.characterName}</strong>
          <span className={statusClass} aria-live="polite">
            <span className="pip-status-dot" aria-hidden="true" />
            <span className="pip-status-text">{statusText}</span>
          </span>
        </div>
        <div className="pip-panel-tools">
          {speaking && (
            <button type="button" className="pip-icon-btn" title="Stop speaking" aria-label="Stop speaking" onClick={() => controller.stopSpeaking()}>
              <Glyph name="stop" />
            </button>
          )}
          <button type="button" className={`pip-icon-btn${showSettings ? " on" : ""}`} title="Settings" aria-label="Settings" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
            <Glyph name="gear" />
          </button>
          <button type="button" className="pip-icon-btn" title="Minimize" aria-label="Minimize companion" onClick={() => controller.minimize()}>
            <Glyph name="minus" />
          </button>
          <button type="button" className="pip-icon-btn" title="Close" aria-label="Close panel" onClick={() => controller.closePanel()}>
            <Glyph name="close" />
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="pip-settings">
          <label className="pip-toggle">
            <input type="checkbox" checked={settings.proactiveEnabled} onChange={(e) => void controller.updateSetting({ proactiveEnabled: e.target.checked })} />
            <span>Offer help when I'm stuck</span>
          </label>
          <label className="pip-toggle">
            <input type="checkbox" checked={settings.videoCompanion === "on"} onChange={(e) => void controller.updateSetting({ videoCompanion: e.target.checked ? "on" : "off" })} />
            <span>Watch videos along with me (may pause for what really matters)</span>
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
              Microphone and privacy
            </button>
            <button type="button" className="pip-link" onClick={() => controller.openDemo()}>
              Demo pages
            </button>
          </div>
        </div>
      )}

      <div className="pip-messages" ref={listRef} aria-live="polite" aria-relevant="additions">
        {conversation.length === 0 && (
          <div className="pip-empty">
            <p className="pip-empty-hi">Hi! I can see this page too.</p>
            <p className="pip-empty-sub">Tap one, or ask me anything.</p>
            <div className="pip-chips">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="pip-chip" onClick={() => pick(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {conversation.map((t, i) => (
          <div key={`${t.at}-${i}`} className={`pip-msg ${t.role}${t.kind ? ` kind-${t.kind}` : ""}`}>
            <div className="pip-msg-text">{plainCopy(t.text)}</div>
            {t.detail && t.detail !== t.text && (
              <details className="pip-msg-detail" onToggle={(e) => e.currentTarget.open && e.currentTarget.scrollIntoView({ block: "nearest" })}>
                <summary>More</summary>
                <div className="pip-msg-more">
                  {plainCopy(t.detail)
                    .split(/\n+/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line, j) => (
                      <p key={j}>{line}</p>
                    ))}
                </div>
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


      {voice.mode === "error" && voice.error && (
        <div className="pip-offline">
          <Glyph name="bang" />
          <span>{plainCopy(voice.error)}</span>
        </div>
      )}

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
          <Glyph name="mic" />
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
          <Glyph name="send" />
        </button>
      </form>
    </section>
  );
}
