import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Character } from "../components/Character";
import styles from "../components/styles.css";
import { getSettings, setSettings } from "../shared/settings";

type MicState = "idle" | "asking" | "granted" | "denied";

function Onboarding() {
  const [step, setStep] = useState(0);
  const [mic, setMic] = useState<MicState>("idle");
  const [name, setName] = useState("White Rabbit");
  const [serverUrl, setServerUrl] = useState("http://localhost:8787");

  useEffect(() => {
    void getSettings().then((s) => {
      setName(s.characterName);
      setServerUrl(s.serverUrl);
      if (s.micGranted) setMic("granted");
    });
  }, []);

  const requestMic = async () => {
    setMic("asking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await setSettings({ micGranted: true });
      setMic("granted");
    } catch {
      setMic("denied");
    }
  };

  const finish = async () => {
    await setSettings({ onboarded: true });
    setStep(3);
  };

  return (
    <div className="card">
      <div className="steps" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i <= Math.min(step, 2) ? "on" : ""} />
        ))}
      </div>
      <div className="char">
        <div className="pip-root" style={{ position: "static", pointerEvents: "auto" }}>
          <Character state={step === 3 ? "celebrating" : step === 1 ? "listening" : "idle"} level={0} lookAt={null} attention={0} reducedMotion={false} size={110} />
        </div>
      </div>
      {step === 0 && (
        <>
          <h1>Meet the {name}.</h1>
          <p>Your learning companion lives right in your browser—a tiny character in the corner of every page.</p>
          <ul>
            <li>Ask it questions about what's on screen.</li>
            <li>Let it show you where things are (it points!).</li>
            <li>If you get stuck, it can notice and offer a hint—without doing the work for you.</li>
          </ul>
          <div className="row">
            <button className="btn primary" onClick={() => setStep(1)}>
              Next
            </button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <h1>Enable your microphone</h1>
          <p>Voice mode lets you just talk to {name}. Chrome will ask once; you can always mute from the panel.</p>
          {mic === "granted" && <p className="ok">Microphone enabled. You can turn voice mode on from {name}'s panel.</p>}
          {mic === "denied" && <p className="err">Microphone was blocked. You can allow it from the site permissions (lock icon) later—text chat works either way.</p>}
          <div className="row">
            {mic !== "granted" && (
              <button className="btn primary" onClick={() => void requestMic()} disabled={mic === "asking"}>
                {mic === "asking" ? "Waiting for Chrome…" : "Enable microphone"}
              </button>
            )}
            <button className="btn" onClick={() => setStep(2)}>
              {mic === "granted" ? "Next" : "Skip for now"}
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <h1>How {name} treats your data</h1>
          <div className="privacy">
            <p>When voice mode is on, your microphone audio is streamed to your own local server and on to Deepgram to understand what you're saying. Nothing is recorded or stored.</p>
            <p>{name} reads the current page only when it needs context to help you. Passwords and payment fields are never read, and {name} will never type them.</p>
            <p style={{ marginBottom: 0 }}>A green dot on the character always means the microphone is live. One click mutes it.</p>
          </div>
          <p style={{ marginTop: 14 }}>
            Local server: <code>{serverUrl}</code> (change in the extension popup if needed).
          </p>
          <div className="row">
            <button className="btn primary" onClick={() => void finish()}>
              Got it
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <h1>You're all set.</h1>
          <p>Open any webpage and look for {name} in the bottom-right corner. Try the demo course to see the whole flow.</p>
          <div className="row">
            <button className="btn primary" onClick={() => void chrome.tabs.create({ url: `${serverUrl.replace(/\/$/, "")}/demo/` })}>
              Open demo pages
            </button>
            <button className="btn" onClick={() => window.close()}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const style = document.createElement("style");
style.textContent = styles;
document.head.appendChild(style);
createRoot(document.getElementById("root")!).render(<Onboarding />);
