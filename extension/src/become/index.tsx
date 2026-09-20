import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SpritePet, assembleCharacter, registerCharacter, CUSTOM_KEY, CUSTOM_PREFIX, DEFAULT_CHARACTER, type LoadedCharacter, type PetController, type StoredCharacter } from "../components/pet";
import { DEFAULT_OPTIONS, makeCharacter, makeSprite, type MakeOptions, type Raster } from "../components/pet/pixelize";
import styles from "../components/styles.css";
import { getSettings, setSettings } from "../shared/settings";

/** Photos are worked on at this size at most: the flood fill and sliders stay instant. */
const WORK_SIZE = 360;
/** Part of the camera picture the guide frame covers (of the shorter side). */
const GUIDE = 0.64;
const STATES = ["idle", "listening", "thinking", "confused", "celebrate", "wave", "hop", "sleepy", "panic"] as const;

function rasterFromCanvas(canvas: HTMLCanvasElement): Raster {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

function canvasFromRaster(r: Raster, canvas = document.createElement("canvas")): HTMLCanvasElement {
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
  return canvas;
}

/** Draws a source (video frame or image) into a square work raster, cropped to the middle `part` of it. */
function grab(source: CanvasImageSource, sw: number, sh: number, part: number, mirror: boolean): Raster {
  const side = Math.min(sw, sh) * part;
  const sx = (sw - side) / 2;
  const sy = (sh - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = WORK_SIZE;
  canvas.height = WORK_SIZE;
  const ctx = canvas.getContext("2d")!;
  if (mirror) {
    ctx.translate(WORK_SIZE, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, sx, sy, side, side, 0, 0, WORK_SIZE, WORK_SIZE);
  return rasterFromCanvas(canvas);
}

function loadFile(file: File): Promise<Raster> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // A whole photo: fit it inside the work square without cropping.
      const scale = Math.min(1, WORK_SIZE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(rasterFromCanvas(canvas));
    };
    img.onerror = () => reject(new Error("That file is not a picture"));
    img.src = url;
  });
}

let previewCount = 0;

function Maker() {
  const [phase, setPhase] = useState<"camera" | "tune" | "done">("camera");
  const [camError, setCamError] = useState("");
  const [photo, setPhoto] = useState<Raster | null>(null);
  const [opts, setOpts] = useState<MakeOptions>(DEFAULT_OPTIONS);
  const [name, setName] = useState("");
  const [current, setCurrent] = useState(DEFAULT_CHARACTER);
  const [preview, setPreview] = useState<LoadedCharacter | null>(null);
  const [petState, setPetState] = useState<string>("idle");
  const [saving, setSaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const spriteCanvas = useRef<HTMLCanvasElement>(null);
  const photoCanvas = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const petRef = useRef<PetController | null>(null);
  const petDarkRef = useRef<PetController | null>(null);

  useEffect(() => {
    void getSettings().then((s) => setCurrent(s.character));
  }, []);

  // The camera runs only on the first step and is released as soon as a picture is taken.
  useEffect(() => {
    if (phase !== "camera") return;
    let alive = true;
    setCamError("");
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
      })
      .catch((e: unknown) => {
        const err = e as { name?: string };
        setCamError(err?.name === "NotAllowedError" ? "Chrome did not let the page use the camera. Allow it in the address bar, or use a photo instead." : "No camera found. Use a photo instead.");
      });
    return () => {
      alive = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [phase]);

  const sprite = useMemo(() => (photo ? makeSprite(photo, opts) : null), [photo, opts]);
  const made = useMemo(() => (sprite ? makeCharacter(sprite, name.trim() || "friend") : null), [sprite, name]);

  // Show the photo and the sprite.
  useEffect(() => {
    if (photo && photoCanvas.current) canvasFromRaster(photo, photoCanvas.current);
  }, [photo]);
  useEffect(() => {
    const c = spriteCanvas.current;
    if (!c || !made) return;
    // Idle frame 0 alone: the first cell of the strip.
    const full = canvasFromRaster(made.strips.idle);
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(full, 0, 0, c.width, c.height, 0, 0, c.width, c.height);
  }, [made]);

  // Build a live character for the stage each time the sliders settle.
  useEffect(() => {
    if (!made) {
      setPreview(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      const strips: Record<string, string> = {};
      for (const [state, r] of Object.entries(made.strips)) strips[state] = canvasFromRaster(r).toDataURL("image/png");
      const id = `preview:${++previewCount}`;
      void assembleCharacter(id, made.manifest, strips).then((c) => {
        if (!alive) return;
        registerCharacter(id, c);
        setPreview(c);
      });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [made]);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    setPhoto(grab(v, v.videoWidth, v.videoHeight, GUIDE, false));
    setPhase("tune");
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPhoto(await loadFile(file));
      setPhase("tune");
    } catch (e) {
      setCamError(String((e as Error).message ?? e));
    }
  };

  const onPet = useCallback((c: PetController | null) => {
    petRef.current = c;
  }, []);
  const onPetDark = useCallback((c: PetController | null) => {
    petDarkRef.current = c;
  }, []);
  const pets = () => [petRef.current, petDarkRef.current].filter((c): c is PetController => !!c);
  const show = (s: (typeof STATES)[number]) => {
    setPetState(s);
    for (const c of pets()) c.play(s);
  };
  const dive = () => {
    for (const c of pets()) void c.jumpOut().then(() => c.jumpIn(new Promise((r) => setTimeout(r, 700))));
  };

  const become = async () => {
    if (!made) return;
    setSaving(true);
    const strips: Record<string, string> = {};
    for (const [state, r] of Object.entries(made.strips)) strips[state] = canvasFromRaster(r).toDataURL("image/png");
    const label = name.trim() || "My character";
    const stored: StoredCharacter = { id: Date.now().toString(36), label, manifest: { ...made.manifest, character: label }, strips };
    await chrome.storage.local.set({ [CUSTOM_KEY]: stored });
    await setSettings({ character: `${CUSTOM_PREFIX}${stored.id}`, characterName: label });
    setCurrent(`${CUSTOM_PREFIX}${stored.id}`);
    setSaving(false);
    setPhase("done");
  };
  const backToRabbit = async () => {
    await setSettings({ character: DEFAULT_CHARACTER, characterName: "White Rabbit" });
    setCurrent(DEFAULT_CHARACTER);
  };

  const knob = (label: string, key: keyof MakeOptions, min: number, max: number, step = 1) => (
    <>
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={opts[key] as number} onChange={(e) => setOpts({ ...opts, [key]: Number(e.target.value) })} aria-label={label} />
      <span className="val px-digits">{opts[key] as number}</span>
    </>
  );

  return (
    <div className="card px-frame">
      {phase === "camera" && (
        <>
          <h1>Become someone new</h1>
          <p>Hold a toy, a drawing or your own face inside the frame on a plain background. He turns it into a few frames of pixel art and wears it on every page.</p>
          {camError ? (
            <div className="cam off">{camError}</div>
          ) : (
            <div className="cam">
              <video ref={videoRef} muted playsInline autoPlay />
              <div className="guide" />
              <div className="hint">Plain wall behind, character inside the square</div>
            </div>
          )}
          <div className="row">
            <button className="px-btn primary" onClick={snap} disabled={!!camError}>
              Take the picture
            </button>
            <button className="px-btn" onClick={() => fileRef.current?.click()}>
              Use a photo instead
            </button>
            <input ref={fileRef} className="file" type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} />
            {current !== DEFAULT_CHARACTER && (
              <button className="px-btn quiet" onClick={() => void backToRabbit()}>
                Back to the rabbit
              </button>
            )}
          </div>
        </>
      )}
      {phase === "tune" && (
        <>
          <h1>Tune the pixels</h1>
          <p>Cut the background until only the character is left, then pick a size and how many colours he gets.</p>
          <div className="pair">
            <canvas ref={photoCanvas} className="photo" width={WORK_SIZE} height={WORK_SIZE} aria-label="Your photo" />
            <canvas ref={spriteCanvas} className="sprite" width={64} height={58} aria-label="The pixel sprite" />
          </div>
          {!sprite && <p className="err">Nothing is left after the cut. Lower the background cut, or take the picture on a plainer wall.</p>}
          <div className="knobs">
            {knob("Background cut", "tolerance", 10, 160)}
            {knob("Size", "height", 20, 40)}
            {knob("Colours", "colors", 3, 24)}
          </div>
          <label className="name">
            <span className="px-muted">Name</span>
            <input className="px-input" value={name} placeholder="Captain Carrot" onChange={(e) => setName(e.target.value)} />
          </label>
          <h2>On a page</h2>
          <div className="stage">
            {(["light", "dark"] as const).map((side) => (
              <div key={side} className={`half ${side}`}>
                {preview && (
                  <div className="pip-root">
                    <SpritePet character={preview.name} state={petState} scale={3} onController={side === "light" ? onPet : onPetDark} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="states">
            {STATES.map((s) => (
              <button key={s} className={`px-btn${petState === s ? " on" : ""}`} onClick={() => show(s)}>
                {s}
              </button>
            ))}
            <button className="px-btn" onClick={dive}>
              dive
            </button>
          </div>
          <div className="row">
            <button className="px-btn primary" onClick={() => void become()} disabled={!made || saving}>
              {saving ? "Saving" : "Become this character"}
            </button>
            <button className="px-btn" onClick={() => setPhase("camera")}>
              Retake
            </button>
          </div>
        </>
      )}
      {phase === "done" && (
        <>
          <h1>Done</h1>
          <div className="done">
            <p className="ok">
              {name.trim() || "Your character"} is in the corner of every page now. Open a tab to see.
            </p>
          </div>
          <div className="row">
            <button className="px-btn" onClick={() => setPhase("camera")}>
              Make another
            </button>
            <button className="px-btn quiet" onClick={() => void backToRabbit().then(() => setPhase("camera"))}>
              Back to the rabbit
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
createRoot(document.getElementById("root")!).render(<Maker />);
