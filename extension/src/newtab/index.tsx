import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";
import { armBlip, blip } from "./blip";
import { clockScale, clockText, drawClock, loadDigits, type Digits } from "./clock";
import { startScene, todFor } from "./scene";

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

function Scene() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    return startScene(c, {
      hour: () => forcedHour ?? new Date().getHours(),
      reducedMotion,
      rain: rain && !reducedMotion,
      onPalette: (tod, ground) => {
        document.body.dataset.tod = tod;
        document.body.style.backgroundColor = ground;
      },
    });
  }, []);
  return <canvas ref={ref} className="scene" aria-hidden="true" />;
}

function Clock({ now, hour }: { now: Date; hour: number }) {
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
  useEffect(() => {
    if (ref.current && digits) drawClock(ref.current, text, scale, digits);
  }, [text, scale, digits]);
  return (
    <div className="clockwrap">
      <canvas ref={ref} className="clock" role="img" aria-label={`Current time ${text}`} />
      <p className="greet">{greeting(hour)}</p>
    </div>
  );
}

function Search() {
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
  return (
    <form className="search" role="search" data-pops={pops} onSubmit={onSubmit}>
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
        <input ref={input} name="q" value={value} onChange={onChange} onKeyDown={armBlip} onFocus={onFocus} onBlur={onBlur} placeholder="Ask the meadow" aria-label="Ask the meadow" autoComplete="off" spellCheck={false} />
      </div>
      <div className="legs">
        <span className="leg" />
        <span className="leg" />
      </div>
    </form>
  );
}

function Shortcuts({ sites }: { sites: Site[] }) {
  const [fit, setFit] = useState(() => Math.max(2, Math.floor((window.innerWidth - 240) / 132)));
  useEffect(() => {
    const onResize = () => setFit(Math.max(2, Math.floor((window.innerWidth - 240) / 132)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  if (!sites.length) return <p className="empty">Your most visited sites will show up here.</p>;
  return (
    <nav className="shortcuts" aria-label="Shortcuts">
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

function NewTab() {
  const [now, setNow] = useState(() => new Date());
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState("White Rabbit");

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

  const hour = forcedHour ?? now.getHours();
  useEffect(() => {
    document.body.dataset.tod = todFor(hour);
  }, [hour]);

  return (
    <>
      <Scene />
      <main className="ui">
        <Clock now={now} hour={hour} />
        <Shortcuts sites={sites} />
        <Search />
        <p className="hint px-frame">
          <b>{name}</b> is here. Ask him anything, or teach him something new.
        </p>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
mountCompanion();
