import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GraphSnapshot } from "@shared/graph";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";
import { createAmbience } from "./ambience";
import { armBlip, audioContext, blip, blipFor } from "./blip";
import { BOOT_FULL_MS, BOOT_QUICK_MS, ENTER_DEADLINE_MS, bootLabel, decideBootMode, dropClass, enter, type BootMode } from "./boot";
import { clockScale, clockText, drawClock, loadDigits, type Digits, type Reveal } from "./clock";
import { startScene, todFor, type BootView, type HoverSign, type Ridge, type SceneHandle } from "./scene";

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

function Scene({ bootRef, sceneRef, onHover, onLayout }: { bootRef: React.MutableRefObject<Boot>; sceneRef: React.MutableRefObject<SceneHandle | null>; onHover: (c: HoverSign | null) => void; onLayout: (r: Ridge) => void }) {
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
      onLayout,
      onInteract: startSound,
    });
    sceneRef.current = handle;
    return () => {
      handle.stop();
      sceneRef.current = null;
    };
  }, [bootRef, sceneRef, onHover, onLayout]);
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
  return (
    <div className="clockwrap">
      <canvas ref={ref} className="clock" role="img" aria-label={`Current time ${text}`} />
    </div>
  );
}

/** Prompts the empty plank types out, one at a time, so the kid sees what it is for. */
// The plank types a question, holds it, backspaces it and types the next, the way a kid tries things.
const PROMPTS = ["Ask the meadow", "Why is the sky blue?", "How do birds fly?", "What is a moat?", "Why do cats purr?", "How big is the moon?", "Where does rain come from?", "Teach him about volcanoes"];
const PROMPT_TYPE_MS = 60;
const PROMPT_DELETE_MS = 35;
const PROMPT_HOLD_MS = 4200;
const PROMPT_GAP_MS = 240;
type PromptPhase = "type" | "hold" | "delete" | "gap";

function Search({ boot }: { boot: Boot }) {
  const [value, setValue] = useState("");
  const [pops, setPops] = useState(0);
  const [tail, setTail] = useState(false);
  const [focused, setFocused] = useState(false);
  const [plucked, setPlucked] = useState(false);
  const [nudge, setNudge] = useState<"" | "shake" | "stamp">("");
  // The typed-out prompt: which one, how much of it is showing, and what the plank is doing with it.
  const [prompt, setPrompt] = useState<{ i: number; n: number; phase: PromptPhase }>({ i: 0, n: PROMPTS[0].length, phase: "hold" });
  useEffect(() => {
    if (reducedMotion || !boot.done || value || focused) return;
    let timer = 0;
    let i = prompt.i;
    let n = prompt.n;
    // A whole prompt is on hold and goes next; a partial one keeps typing, or keeps going if it was on its way out.
    let deleting = prompt.phase === "delete" || n >= PROMPTS[i].length;
    const step = () => {
      if (deleting && n > 0) {
        n -= 1;
        setPrompt({ i, n, phase: "delete" });
        timer = window.setTimeout(step, PROMPT_DELETE_MS);
      } else if (deleting) {
        deleting = false;
        i = (i + 1) % PROMPTS.length;
        setPrompt({ i, n, phase: "gap" });
        timer = window.setTimeout(step, PROMPT_GAP_MS);
      } else if (n < PROMPTS[i].length) {
        n += 1;
        const whole = n === PROMPTS[i].length;
        setPrompt({ i, n, phase: whole ? "hold" : "type" });
        timer = window.setTimeout(step, whole ? PROMPT_HOLD_MS : PROMPT_TYPE_MS);
      } else {
        deleting = true;
        step();
      }
    };
    timer = window.setTimeout(step, deleting ? PROMPT_HOLD_MS : PROMPT_TYPE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.done, value, focused]);
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
    setFocused(true);
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
  const onBlur = () => {
    setFocused(false);
    send("burrow:play", { state: "idle" });
  };
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) {
      // Nothing to ask yet: the plank shakes its head.
      setNudge("");
      window.requestAnimationFrame(() => setNudge("shake"));
      input.current?.focus();
      return;
    }
    if (plucked) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    // The carrot is plucked and the plank stamps, then he dives with the question.
    setPlucked(true);
    setNudge("stamp");
    blip(9);
    window.setTimeout(() => send("burrow:leave", { url, line: "Let's go find out!", arriveLine: "Here's what I found." }), reducedMotion ? 0 : 260);
  };

  const head = value.slice(0, -1);
  const last = value.slice(-1);
  const drop = boot.mode === "full" && !boot.done ? dropClass(boot.elapsed, 1780) : "";
  // While the plank shows a prompt of its own, the caret shows what it is doing: steady while it types or deletes, blinking on hold.
  const demo = !value && !focused && !reducedMotion && boot.done ? ` demo-${prompt.phase}` : "";
  return (
    <form className={`search ${drop}`} role="search" data-pops={pops} onSubmit={onSubmit}>
      <div className={`board${nudge ? ` ${nudge}` : ""}${demo}`} ref={board} onAnimationEnd={() => setNudge("")}>
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
              <span className="ph">{focused || reducedMotion ? "Ask the meadow" : PROMPTS[prompt.i].slice(0, prompt.n)}</span>
            )}
            <i className="caret" />
          </span>
        </span>
        <span className={`dirt${plucked ? " puff" : ""}`} aria-hidden="true" />
        <button type="submit" className={`carrot${value.trim() ? " ready" : ""}${plucked ? " plucked" : ""}`} aria-label="Ask" title="Ask" tabIndex={-1} />
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

/** A site's name for a sign: the title up to its first separator, else the host. Never cut mid word. */
function shortName(s: Site): string {
  const head = s.title.split(/\s*[:|·•,\-–—]\s*/)[0]?.trim() ?? "";
  let host = s.url;
  try {
    host = new URL(s.url).hostname.replace(/^www\./, "");
  } catch {
    /* keep the url */
  }
  // A title that is itself a URL (or starts with the scheme) names the site by its host instead.
  const name = head.length >= 2 && !/^https?$/i.test(head) && !/^https?:\/\//i.test(s.title) ? head : host;
  return name.length > 28 ? `${name.slice(0, 27).trimEnd()}…` : name;
}

/** Signposts for the most visited sites, standing on the far ridge where nothing is painted behind them. */
function Shortcuts({ sites, boot, ridge, onHover }: { sites: Site[]; boot: Boot; ridge: Ridge | null; onHover: (h: HoverSign | null) => void }) {
  const drop = boot.mode === "full" && !boot.done ? dropClass(boot.elapsed, 1600) : "";
  if (!ridge) return null;
  const top = Math.round((ridge.y + 6 - 69) / 3) * 3;
  if (!sites.length) return <p className={`empty ${drop}`} style={{ top: top + 24 }}>Your most visited sites will show up here.</p>;
  // 54px boards, 9px apart, as many as fit between the windmill and the oak.
  const fit = Math.max(1, Math.min(8, Math.floor((ridge.right - ridge.left + 9) / 63)));
  const shown = sites.slice(0, fit);
  const width = shown.length * 54 + (shown.length - 1) * 9;
  const left = Math.round((ridge.left + ridge.right - width) / 2 / 3) * 3;
  const show = (site: Site) => (e: React.SyntheticEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onHover({ label: shortName(site), left: r.left, top: r.top, width: r.width, height: r.height });
  };
  const hide = () => onHover(null);
  return (
    <nav className={`shortcuts ${drop}`} aria-label="Shortcuts" style={{ left, top }}>
      {shown.map((site) => (
        <a key={site.url} className="shortcut" href={site.url} aria-label={shortName(site)} title={site.title} onMouseEnter={show(site)} onMouseLeave={hide} onFocus={show(site)} onBlur={hide}>
          <span className="board">
            <img src={faviconFor(site.url)} alt="" />
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
  const [where, setWhere] = useState<"above" | "below" | "beside">("above");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hover) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 6;
    // Other signs, the plank, the hint, the clock and the rabbit's corner: a sign may not land on any of them.
    const avoid = Array.from(document.querySelectorAll<HTMLElement>(".shortcut, .search .board, .hud-sign, .hint, .clockwrap"))
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && !(Math.abs(r.left - hover.left) < 1 && Math.abs(r.top - hover.top) < 1));
    avoid.push(petBody() ?? new DOMRect(vw - 330, vh - 330, 330, 330));
    const cx = hover.left + hover.width / 2;
    const clampY = (y: number): number => Math.max(m, Math.min(vh - m - h, y));
    // Beside the thing: centred on it, then flush with its top, then with its bottom edge.
    const besideYs = [clampY(hover.top + hover.height / 2 - h / 2), clampY(hover.top), clampY(hover.top + hover.height - h)];
    const spots: { x: number; y: number; where: "above" | "below" | "beside" }[] = [
      { x: cx - w / 2, y: hover.top - h - 3, where: "above" },
      { x: cx - w / 2, y: hover.top + hover.height + 3, where: "below" },
      ...besideYs.map((y) => ({ x: hover.left + hover.width + 6, y, where: "beside" as const })),
      ...besideYs.map((y) => ({ x: hover.left - w - 6, y, where: "beside" as const })),
    ];
    const clear = (x: number, y: number): boolean =>
      x >= m && y >= m && x + w <= vw - m && y + h <= vh - m && !avoid.some((r) => x < r.right && r.left < x + w && y < r.bottom && r.top < y + h);
    const pick = spots.find((sp) => clear(sp.x, sp.y)) ?? { ...spots[0], x: Math.max(m, Math.min(vw - w - m, spots[0].x)), y: Math.max(m, Math.min(vh - h - m, spots[0].y)) };
    setLeft(Math.round(pick.x));
    setTop(Math.round(pick.y));
    setWhere(pick.where);
  }, [hover]);
  if (!hover) return null;
  return (
    <div ref={ref} className={`concept-sign${hover.pinned ? " pinned" : ""} ${where}`} style={{ left, top }} role="tooltip">
      <span className="board">{hover.label}</span>
      <span className="post" />
    </div>
  );
}

/** Two quiet controls in the corner: the site signposts and the sound. */
function Hud({ sound, onSound, hidden, sitesOpen, onSites }: { sound: boolean; onSound: () => void; hidden: boolean; sitesOpen: boolean; onSites: () => void }) {
  return (
    <nav className={`hud${hidden ? " hidden" : ""}`} aria-label="Meadow">
      <div className="hud-sign">
        <button type="button" className="board sites" onClick={onSites} aria-pressed={sitesOpen} aria-label={sitesOpen ? "Hide your sites" : "Show your sites"}>
          Sites
        </button>
      </div>
      <div className="hud-sign">
        <button type="button" className="board speaker" onClick={onSound} aria-pressed={sound} aria-label={sound ? "Sound on" : "Sound off"} title={sound ? "Sound on" : "Sound off"}>
          <img src={sound ? "scene/speaker_on.png" : "scene/speaker_off.png"} alt="" width={33} height={27} />
        </button>
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
  const [signHover, setSignHover] = useState<HoverSign | null>(null);
  const [ridge, setRidge] = useState<Ridge | null>(null);
  // The meadow is the page; the site signposts come out only when asked for, and go away on a
  // click anywhere else or Escape.
  const [sitesOpen, setSitesOpen] = useState(false);
  useEffect(() => {
    if (!sitesOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".shortcuts, .hud-sign .sites")) return;
      setSitesOpen(false);
      setSignHover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSitesOpen(false);
        setSignHover(null);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [sitesOpen]);
  // The welcome hint has done its job ten seconds after the boot, or at the first click or key.
  const [hintGone, setHintGone] = useState(false);
  const [sound, setSound] = useState(soundWanted);
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
  useEffect(() => {
    if (!boot.done || hintGone) return;
    const gone = () => setHintGone(true);
    const timer = window.setTimeout(gone, 10_000);
    document.addEventListener("pointerdown", gone, { once: true, capture: true });
    document.addEventListener("keydown", gone, { once: true, capture: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", gone, true);
      document.removeEventListener("keydown", gone, true);
    };
  }, [boot.done, hintGone]);
  const hintTyped = full ? Math.max(0, Math.floor((boot.elapsed - 1750) / 22)) : Infinity;
  // An empty meadow asks to be taught; a growing one just says he is here.
  const hintText = graph?.nodes.length ? ` is here. Ask him anything, or teach him something new.` : ` is here. Teach him something and the meadow grows.`;
  return (
    <>
      <Scene bootRef={bootRef} sceneRef={sceneRef} onHover={setHover} onLayout={setRidge} />
      <main className="ui">
        <Clock now={now} hour={hour} boot={boot} />
        {sitesOpen && <Shortcuts sites={sites} boot={boot} ridge={ridge} onHover={setSignHover} />}
        <Search boot={boot} />
        <p className={`hint px-frame${full && boot.elapsed < 1750 ? " hidden" : ""}${hintGone ? " gone" : ""}`}>
          <b>{name.slice(0, hintTyped)}</b>
          {hintTyped > name.length ? hintText.slice(0, hintTyped - name.length) : ""}
        </p>
        <ConceptSign hover={boot.done ? signHover ?? hover : null} />
        <Hud sound={sound} onSound={toggleSound} hidden={!boot.done} sitesOpen={sitesOpen} onSites={() => setSitesOpen((v) => !v)} />
        <BootLine boot={boot} />
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
mountCompanion();
