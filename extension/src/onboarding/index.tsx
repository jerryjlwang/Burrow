import { useEffect, useState, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Character } from "../components/Character";
import type { PetController } from "../components/pet";
import styles from "../components/styles.css";
import { getSettings, setSettings } from "../shared/settings";

type MicState = "idle" | "asking" | "granted" | "denied";

function Onboarding() {
  const [step, setStep] = useState(0);
  const [mic, setMic] = useState<MicState>("idle");
  const [name, setName] = useState("White Rabbit");
  const [serverUrl, setServerUrl] = useState("http://localhost:8787");
  const [character, setCharacter] = useState<string | undefined>(undefined);
  // He pops out of his hole once, when the art loads, then waves hello. The player re-hands its
  // controller on every render, so this must not be a fresh closure that dives him again at each step.
  const arrived = useRef(false);
  const onPet = useCallback((c: PetController | null) => {
    if (!c || arrived.current) return;
    arrived.current = true;
    void c.jumpIn(new Promise((r) => setTimeout(r, 600))).then(() => c.play("wave"));
  }, []);

  useEffect(() => {
    void getSettings().then((s) => {
      setName(s.characterName);
      setServerUrl(s.serverUrl);
      setCharacter(s.character);
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
    <div className="card px-frame">
      <div className="steps" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i <= Math.min(step, 2) ? "on" : ""} />
        ))}
      </div>
      <div className="char">
        <div className="pip-root" style={{ position: "static", pointerEvents: "auto" }}>
          <Character state={step === 3 ? "celebrating" : step === 1 ? "listening" : "idle"} level={0} lookAt={null} attention={0} reducedMotion={false} size={110} startHidden onController={onPet} character={character} />
        </div>
      </div>
      {step === 0 && (
        <>
          <h1>Meet the {name}.</h1>
          <p>He lives in your browser. A small rabbit in the corner of every page.</p>
          <ul>
            <li>Ask him about what's on the screen.</li>
            <li>He can point at things for you.</li>
            <li>If you get stuck, he offers a hint. He never does the work for you.</li>
          </ul>
          <div className="row">
            <button className="px-btn primary" onClick={() => setStep(1)}>
              Next
            </button>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <h1>Let him hear you</h1>
          <p>With the microphone on, you can just talk to him. Chrome asks once: choose "Allow while visiting the site". "Allow this time" only covers this tab, and he won't hear you anywhere else. You can mute him any time from his panel.</p>
          {mic === "granted" && <p className="ok">Microphone enabled. Turn voice on from his panel.</p>}
          {mic === "denied" && <p className="err">Chrome blocked the microphone. You can allow it later from the lock icon. Typing works either way.</p>}
          <div className="row">
            {mic !== "granted" && (
              <button className="px-btn primary" onClick={() => void requestMic()} disabled={mic === "asking"}>
                {mic === "asking" ? "Waiting for Chrome" : "Enable microphone"}
              </button>
            )}
            <button className="px-btn" onClick={() => setStep(2)}>
              {mic === "granted" ? "Next" : "Skip for now"}
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <h1>What he does with your data</h1>
          <div className="privacy">
            <p>With voice on, your microphone audio goes to your own local server, then to Deepgram to turn it into words. Nothing is recorded or kept.</p>
            <p>He reads the page only when he needs it to help you. He never reads or types passwords or payment details.</p>
            <p>A green dot on him means the microphone is live. One click mutes it.</p>
          </div>
          <p className="server">
            Local server: <code>{serverUrl}</code>. Change it from the toolbar popup.
          </p>
          <div className="row">
            <button className="px-btn primary" onClick={() => void finish()}>
              Got it
            </button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <h1>All set.</h1>
          <p>Open any page and look for him in the bottom right corner. The demo course shows the whole flow.</p>
          <div className="row">
            <button className="px-btn primary" onClick={() => void chrome.tabs.create({ url: `${serverUrl.replace(/\/$/, "")}/demo/` })}>
              Open the demo pages
            </button>
            <button className="px-btn" onClick={() => window.close()}>
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
