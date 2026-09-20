import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GraphSnapshot } from "@shared/graph";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";
import { createAmbience } from "./ambience";
import { armBlip, audioContext, blip, blipFor } from "./blip";
import { BOOT_FULL_MS, BOOT_QUICK_MS, ENTER_DEADLINE_MS, bootLabel, decideBootMode, dropClass, enter, type BootMode } from "./boot";
import { clockScale, clockText, drawClock, loadDigits, type Digits, type Reveal } from "./clock";
import { startScene, todFor, type BootView, type HoverSign, type SceneHandle } from "./scene";

interface Site {
  title: string;
  url: string;
}

const params = new URLSearchParams(location.search);
/** `?hour=19` forces the light (and the clock's hour) so screenshots are repeatable. */
const forcedHour = (() => {
  const v = params.get("hour");
  const n = v === null ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n < 24 ? n : null;
})();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Rain on one load in six, never when the hour is forced unless asked for.
const rain = params.has("rain") ? params.get("rain") !== "0" : forcedHour === null && Math.random() < 1 / 6;
const GRAPH_KEY = "burrow.graph";
const SOUND_KEY = "burrow.newtab.sound";
const ambience = createAmbience();
// Whatever the scene does, the rabbit is asked in before three seconds.
window.setTimeout(enter, ENTER_DEADLINE_MS);

function faviconFor(url: string): string {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "32");
  return u.toString();
}

function greeting(h: number): string {
  return h < 5 ? "Burning the midnight oil?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Late night session";
}

/** The rabbit's body box, read from the companion's open shadow root. */
function petBody(): DOMRect | null {
  const r = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet-hit")?.getBoundingClientRect();
  return r && r.width > 0 ? r : null;
}

function send(name: string, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function isGraph(v: unknown): v is GraphSnapshot {
  return !!v && typeof v === "object" && (v as GraphSnapshot).version === 1 && Array.isArray((v as GraphSnapshot).nodes);
}

function soundWanted(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Sound starts on the first click or key, never before. */
function startSound(): void {
  armBlip();
  const ctx = audioContext();
  if (ctx) ambience.start(ctx);
}

/* ---------- boot ---------- */

interface Boot {
  mode: BootMode | null;
  elapsed: number;
  done: boolean;
}

function useBoot(): Boot {
  const [boot, setBoot] = useState<Boot>(() => (reducedMotion ? { mode: "none", elapsed: 0, done: true } : { mode: null, elapsed: 0, done: false }));
  useEffect(() => {
    if (reducedMotion) {
      enter();
      return;
    }
    let mode: BootMode | null = null;
    let start = 0;
    let finished = false;
    let timer = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearInterval(timer);
      setBoot({ mode: mode ?? "full", elapsed: Infinity, done: true });
      const c = document.querySelector<HTMLCanvasElement>("canvas.scene");
      if (c) c.dataset.boot = "done";
      enter();
    };
    const interrupt = () => finish();
    window.addEventListener("pointerdown", interrupt, true);
    window.addEventListener("keydown", interrupt, true);
    window.addEventListener("wheel", interrupt, { capture: true, passive: true });
    window.addEventListener("scroll", interrupt, true);
    void decideBootMode(false).then((m) => {
      if (finished) return;
      mode = m;
      start = performance.now();
      const total = m === "full" ? BOOT_FULL_MS : BOOT_QUICK_MS;
      setBoot({ mode: m, elapsed: 0, done: false });
      timer = window.setInterval(() => {
        const elapsed = performance.now() - start;
        if (elapsed >= total) finish();
        else setBoot({ mode: m, elapsed, done: false });
      }, 30);
    });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", interrupt, true);
      window.removeEventListener("keydown", interrupt, true);
      window.removeEventListener("wheel", interrupt, true);
      window.removeEventListener("scroll", interrupt, true);
    };
  }, []);
  return boot;
}

function BootLine({ boot }: { boot: Boot }) {
  const [linger, setLinger] = useState(true);
  useEffect(() => {
    if (!boot.done) return;
    const t = window.setTimeout(() => setLinger(false), 320);
    return () => window.clearTimeout(t);
  }, [boot.done]);
  if (boot.mode !== "full" || (boot.done && !linger)) return null;
  const elapsed = boot.done ? BOOT_FULL_MS : boot.elapsed;
  const blocks = Math.floor(Math.min(1, elapsed / BOOT_FULL_MS) * 16);
  return (
    <div className="boot" aria-hidden="true">
      <p className="boot-line">
        <b>BURROW</b>&nbsp;&nbsp;{bootLabel(elapsed)}
      </p>
      <div className="boot-bar">
        {Array.from({ length: 16 }, (_, i) => (
          <span key={i} className={i < blocks ? "on" : ""} />
        ))}
      </div>
    </div>
  );
}

/* ---------- pieces of the page ---------- */

function Scene({ bootRef, sceneRef, onHover }: { bootRef: React.MutableRefObject<Boot>; sceneRef: React.MutableRefObject<SceneHandle | null>; onHover: (c: HoverSign | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const handle = startScene(c, {
      hour: () => {
        const d = new Date();
        return forcedHour !== null ? forcedHour + 0.5 : d.getHours() + d.getMinutes() / 60;
      },
      reducedMotion,
      rain: rain && !reducedMotion,
      getPetRect: petBody,
      getBoot: (): BootView => {
        const b = bootRef.current;
        return { mode: b.mode ?? "full", elapsed: b.elapsed, done: b.done };
      },
      postXs: () => Array.from(document.querySelectorAll<HTMLElement>(".search .leg")).map((el) => el.getBoundingClientRect().left + 9),
      onPalette: (tod, ground) => {
        document.body.dataset.tod = tod;
        document.body.style.backgroundColor = ground;
        ambience.setMode(tod === "night" ? "night" : "day");
      },
      onHover,
      onInteract: startSound,
    });
    sceneRef.current = handle;
    return () => {
      handle.stop();
      sceneRef.current = null;
    };
  }, [bootRef, sceneRef, onHover]);
  return <canvas ref={ref} className="scene" data-boot={bootRef.current.done ? "done" : "running"} aria-hidden="true" />;
}

function Clock({ now, hour, boot }: { now: Date; hour: number; boot: Boot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [digits, setDigits] = useState<Digits | null>(null);
  const [scale, setScale] = useState(() => clockScale());
  useEffect(() => {
    void loadDigits().then(setDigits).catch(() => setDigits(null));
    const onResize = () => setScale(clockScale());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const text = clockText(now, hour);
  const full = boot.mode === "full" && !boot.done;
  const reveal: Reveal | undefined = full ? { count: Math.max(0, Math.floor((boot.elapsed - 1600) / 80)), lift: (boot.elapsed - 1600) % 80 < 40 } : undefined;
  const key = reveal ? `${reveal.count}:${reveal.lift}` : "all";
  useEffect(() => {
    if (ref.current && digits) drawClock(ref.current, text, scale, digits, reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, scale, digits, key]);
  const typed = full ? Math.max(0, Math.floor((boot.elapsed - 1700) / 28)) : Infinity;
  return (
    <div className="clockwrap">
      <canvas ref={ref} className="clock" role="img" aria-label={`Current time ${text}`} />
      <p className="greet">{greeting(hour).slice(0, typed)}</p>
    </div>
  );
}

function Search({ boot }: { boot: Boot }) {
  const [value, setValue] = useState("");
  const [pops, setPops] = useState(0);
  const [tail, setTail] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const mirror = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const m = mirror.current;
    const i = inner.current;
    if (m && i) setTail(i.offsetWidth > m.clientWidth - 18);
  }, [value]);

  // Typing anywhere on the page starts a search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.tagName !== "CANVAS") return;
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (v.length > value.length) {
      setPops((n) => n + 1);
      blip(v.length);
    }
    setValue(v);
  };
  const onFocus = () => {
    const b = board.current?.getBoundingClientRect();
    const body = petBody();
    if (b) {
      const bw = body?.width ?? 93;
      const bh = body?.height ?? 159;
      const y = body ? body.top + body.height / 2 : window.innerHeight - 30 - bh / 2;
      const right = b.right + 16 + bw / 2;
      const x = right + bw / 2 + 18 <= window.innerWidth ? right : b.left - 16 - bw / 2;
      const already = body && Math.hypot(x - (body.left + body.width / 2), y - (body.top + body.height / 2)) < 30;
      if (!already) send("burrow:goto", { x: Math.round(x), y: Math.round(y) });
    }
    send("burrow:play", { state: "listening" });
  };
  const onBlur = () => send("burrow:play", { state: "idle" });
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    send("burrow:leave", { url, line: "Let's go find out!", arriveLine: "Here's what I found." });
  };

  const head = value.slice(0, -1);
  const last = value.slice(-1);
  const drop = boot.mode === "full" && !boot.done ? dropClass(boot.elapsed, 1780) : "";
  return (
    <form className={`search ${drop}`} role="search" data-pops={pops} onSubmit={onSubmit}>
      <div className="board" ref={board}>
        <span className={`mirror${tail ? " tail" : ""}`} ref={mirror} aria-hidden="true">
          <span className="inner" ref={inner}>
            {value ? (
              <>
                {head}
                <b key={pops} className="pop">
                  {last}
                </b>
              </>
            ) : (
              <span className="ph">Ask the meadow</span>
            )}
            <i className="caret" />
          </span>
        </span>
        <input
          ref={input}
          name="q"
          value={value}
          onChange={onChange}
          onKeyDown={startSound}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Ask the meadow"
          aria-label="Search box"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="legs">
        <span className="leg" />
        <span className="leg" />
      </div>
    </form>
  );
}

function Shortcuts({ sites, boot }: { sites: Site[]; boot: Boot }) {
  const [fit, setFit] = useState(() => Math.max(2, Math.floor((window.innerWidth - 240) / 132)));
  useEffect(() => {
    const onResize = () => setFit(Math.max(2, Math.floor((window.innerWidth - 240) / 132)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const drop = boot.mode === "full" && !boot.done ? dropClass(boot.elapsed, 1600) : "";
  if (!sites.length) return <p className={`empty ${drop}`}>Your most visited sites will show up here.</p>;
  return (
    <nav className={`shortcuts ${drop}`} aria-label="Shortcuts">
      {sites.slice(0, fit).map((s) => (
        <a key={s.url} className="shortcut" href={s.url} title={s.title}>
          <span className="board">
            <img src={faviconFor(s.url)} alt="" />
            <span className="label">{s.title}</span>
          </span>
          <span className="post" />
        </a>
      ))}
    </nav>
  );
}

function ConceptSign({ hover }: { hover: HoverSign | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const [top, setTop] = useState(0);
  const [isBelow, setIsBelow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hover) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = Math.round(hover.left + hover.width / 2 - w / 2);
    // Things under the search plank get their sign below them; nothing sits on the plank or in the
    // rabbit's corner.
    const plank = document.querySelector(".search .board")?.getBoundingClientRect();
    const below = !!plank && hover.top + hover.height > plank.top - 30;
    const maxX = below ? window.innerWidth - 300 - w - 6 : window.innerWidth - w - 6;
    if (plank && !below && hover.left + hover.width / 2 < plank.left) x = Math.min(x, Math.round(plank.left) - w - 6);
    setLeft(Math.max(6, Math.min(maxX, x)));
    setTop(below ? Math.round(hover.top + hover.height) + 3 : Math.max(6, Math.round(hover.top) - h - 3));
    setIsBelow(below);
  }, [hover]);
  if (!hover) return null;
  return (
    <div ref={ref} className={`concept-sign${hover.pinned ? " pinned" : ""}${isBelow ? " below" : ""}`} style={{ left, top }} role="tooltip">
      <span className="board">{hover.label}</span>
      <span className="post" />
    </div>
  );
}

function Hud({ taught, sound, onSound, hidden, weather }: { taught: number; sound: boolean; onSound: () => void; hidden: boolean; weather: string }) {
  return (
    <nav className={`hud${hidden ? " hidden" : ""}`} aria-label="Meadow">
      <div className="hud-sign">
        <span className="board">{taught === 1 ? "1 thing taught" : `${taught} things taught`}</span>
        <span className="post" />
      </div>
      <div className="hud-sign">
        <span className="board">{weather}</span>
        <span className="post" />
      </div>
      <div className="hud-sign">
        <button type="button" className="board speaker" onClick={onSound} aria-pressed={sound} aria-label={sound ? "Sound on" : "Sound off"} title={sound ? "Sound on" : "Sound off"}>
          <img src={sound ? "scene/speaker_on.png" : "scene/speaker_off.png"} alt="" width={33} height={27} />
        </button>
        <span className="post" />
      </div>
    </nav>
  );
}

function NewTab() {
  const [now, setNow] = useState(() => new Date());
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState("White Rabbit");
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [hover, setHover] = useState<HoverSign | null>(null);
  const [sound, setSound] = useState(soundWanted);
  const [weather, setWeather] = useState<string>(rain && !reducedMotion ? "rain" : "clear");
  const boot = useBoot();
  const bootRef = useRef<Boot>(boot);
  bootRef.current = boot;
  const sceneRef = useRef<SceneHandle | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    void getSettings().then((s) => setName(s.characterName));
    try {
      chrome.topSites.get((list) => setSites((list ?? []).filter((s) => /^https?:/.test(s.url)).slice(0, 8).map((s) => ({ title: s.title || new URL(s.url).hostname, url: s.url }))));
    } catch {
      setSites([]);
    }
    return () => clearInterval(t);
  }, []);

  // What he was taught: the graph plants the front row, and keeps it fresh while the tab is open.
  useEffect(() => {
    const apply = (v: unknown) => setGraph(isGraph(v) ? v : null);
    try {
      chrome.storage.local.get(GRAPH_KEY, (raw) => apply(raw?.[GRAPH_KEY]));
      const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && GRAPH_KEY in changes) apply(changes[GRAPH_KEY].newValue);
      };
      chrome.storage.onChanged.addListener(onChange);
      return () => chrome.storage.onChanged.removeListener(onChange);
    } catch {
      return undefined;
    }
  }, []);
  useEffect(() => {
    sceneRef.current?.setGraph(graph);
  }, [graph]);
  useEffect(() => {
    const t = window.setTimeout(() => sceneRef.current?.setGraph(graph), 400);
    return () => window.clearTimeout(t);
  }, [graph, boot.done]);

  useEffect(() => {
    ambience.setEnabled(sound);
  }, [sound]);
  // The weather sign follows the scene: a shower ends, a rainbow comes.
  useEffect(() => {
    const t = window.setInterval(() => {
      const w = sceneRef.current?.api.weather();
      if (w) setWeather(w);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);
  const toggleSound = useCallback(() => {
    const next = !sound;
    setSound(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      /* fine */
    }
    startSound();
    blipFor(next ? "bloom" : "wiggle");
  }, [sound]);

  useEffect(() => {
    const c = document.querySelector<HTMLCanvasElement>("canvas.scene");
    if (c) c.dataset.boot = boot.done ? "done" : "running";
    if (boot.done) (window as unknown as { __meadow?: unknown }).__meadow = sceneRef.current?.api;
  }, [boot.done]);
  useEffect(() => {
    (window as unknown as { __meadow?: unknown }).__meadow = sceneRef.current?.api;
  });

  const hour = forcedHour ?? now.getHours();
  useEffect(() => {
    document.body.dataset.tod = todFor(hour);
  }, [hour]);

  const full = boot.mode === "full" && !boot.done;
  const hintTyped = full ? Math.max(0, Math.floor((boot.elapsed - 1750) / 22)) : Infinity;
  const hintText = ` is here. Ask him anything, or teach him something new.`;
  return (
    <>
      <Scene bootRef={bootRef} sceneRef={sceneRef} onHover={setHover} />
      <main className="ui">
        <Clock now={now} hour={hour} boot={boot} />
        <Shortcuts sites={sites} boot={boot} />
        <Search boot={boot} />
        <p className={`hint px-frame${full && boot.elapsed < 1750 ? " hidden" : ""}`}>
          <b>{name.slice(0, hintTyped)}</b>
          {hintTyped > name.length ? hintText.slice(0, hintTyped - name.length) : ""}
        </p>
        <ConceptSign hover={boot.done ? hover : null} />
        <Hud taught={graph?.nodes.length ?? 0} sound={sound} onSound={toggleSound} hidden={!boot.done} weather={weather} />
        <BootLine boot={boot} />
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
mountCompanion();
