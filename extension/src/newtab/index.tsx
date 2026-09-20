import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";

interface Site {
  title: string;
  url: string;
}

function faviconFor(url: string): string {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", "32");
  return u.toString();
}

function greeting(d: Date): string {
  const h = d.getHours();
  return h < 5 ? "Burning the midnight oil?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 22 ? "Good evening" : "Late night session";
}

function NewTab() {
  const [now, setNow] = useState(new Date());
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

  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <main>
      <div>
        <h1 className="clock" aria-label={`Current time ${time}`}>{time}</h1>
        <p className="greet">{greeting(now)}</p>
      </div>
      <form className="search" action="https://www.google.com/search" method="get" role="search">
        <label className="search-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input name="q" placeholder="Search Google or type a URL" autoComplete="off" autoFocus aria-label="Search Google" />
        </label>
      </form>
      {sites.length > 0 ? (
        <nav className="shortcuts" aria-label="Shortcuts">
          {sites.map((s) => (
            <a key={s.url} className="shortcut" href={s.url}>
              <span className="icon">
                <img src={faviconFor(s.url)} alt="" />
              </span>
              <span>{s.title}</span>
            </a>
          ))}
        </nav>
      ) : (
        <p className="empty">Your most visited sites will show up here.</p>
      )}
      <p className="hint">
        <b>{name}</b> is here. Ask him anything, or teach him something new.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<NewTab />);
mountCompanion();
