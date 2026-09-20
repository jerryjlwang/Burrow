import { useEffect, useRef, useState } from "react";
import { assetUrl } from "./pet";
import { useStore } from "../content/store";

/**
 * The guest: a character a judge named, scanned from a sketch and dropped into the extension as
 * `characters/guest/`. Nothing here is built into the bundle. The folder is written next to the
 * running extension and this polls for it, so a guest can arrive without a rebuild or a reload
 * (`characters/*` is already web accessible). When the manifest appears he walks in from the edge,
 * waves once and then stands beside the rabbit.
 */
const FOLDER = "characters/guest/";
const POLL_MS = 2000;
const SCALE = 3;

interface GuestManifest {
  character?: string;
  subject?: string;
  cell: [number, number];
  body?: [number, number, number, number];
  states: Record<string, { file: string; frames?: number }>;
}

export function GuestPet() {
  const reduced = useStore((s) => s.reducedMotion);
  const [art, setArt] = useState<{ img: HTMLImageElement; man: GuestManifest } | null>(null);
  const [phase, setPhase] = useState<"in" | "wave" | "idle">("in");
  const canvas = useRef<HTMLCanvasElement>(null);

  // Poll until the folder is there. A missing guest is the normal case, so a 404 is not a problem.
  useEffect(() => {
    let live = true;
    let timer = 0;
    const look = async () => {
      if (!live) return;
      try {
        const res = await fetch(assetUrl(`${FOLDER}manifest.json`), { cache: "no-store" });
        if (res.ok) {
          const man = (await res.json()) as GuestManifest;
          const file = man?.states?.idle?.file;
          if (file) {
            const img = new Image();
            img.onload = () => {
              if (live) setArt({ img, man });
            };
            img.src = assetUrl(FOLDER + file) + `?v=${Date.now()}`;
            return;
          }
        }
      } catch {
        // Not there yet, or not readable: look again in a moment.
      }
      timer = window.setTimeout(look, POLL_MS);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);

  // Draw the idle frame once the art is in, cropped to what the sprite actually uses.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !art) return;
    const [cw, ch] = art.man.cell;
    const b = art.man.body ?? [0, 0, cw - 1, ch - 1];
    const w = b[2] - b[0] + 1;
    const h = b[3] - b[1] + 1;
    c.width = w * SCALE;
    c.height = h * SCALE;
    const g = c.getContext("2d");
    if (!g) return;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(art.img, b[0], b[1], w, h, 0, 0, w * SCALE, h * SCALE);
  }, [art]);

  useEffect(() => {
    if (!art || reduced) {
      if (art) setPhase("idle");
      return;
    }
    const a = window.setTimeout(() => setPhase("wave"), 1500);
    const b = window.setTimeout(() => setPhase("idle"), 2600);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [art, reduced]);

  if (!art) return null;
  const label = art.man.subject || art.man.character || "your character";
  return (
    <div className={`pip-guest ${phase}${reduced ? " still" : ""}`} aria-label={`${label}, drawn for you`}>
      <canvas ref={canvas} className="pip-guest-art" />
    </div>
  );
}
