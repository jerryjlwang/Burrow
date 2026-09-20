import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GraphSnapshot, Misconception } from "@shared/graph";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";
import { GRANTS_KEY, GRAPH_KEY, JUMP_KEY, SKILLS, ago, isGraph, isJump, sampleGraph, type Grants, type Jump, type SkillId } from "./data";
import { Graph } from "./Graph";

/** Below this the rabbit has forgotten the room (MASTERY.unseenThreshold in shared/src/graph.ts). */
const FORGOTTEN = 0.3;
/** The mastery bar is 150px of fill drawn in 3px steps, so it lands on the pixel grid. */
const BAR_STEPS = 50;

function kidNameFrom(settings: Record<string, unknown>): string {
  const v = settings.kidName ?? settings.learnerName;
  return typeof v === "string" && v.trim() ? v.trim() : "your kid";
}

function usableGraph(v: unknown): GraphSnapshot | null {
  return isGraph(v) && v.nodes.length > 0 ? v : null;
}

async function writeGrant(skill: SkillId, granted: boolean): Promise<void> {
  const raw = await chrome.storage.local.get(GRANTS_KEY);
  const current = (raw[GRANTS_KEY] ?? {}) as Grants;
  await chrome.storage.local.set({ [GRANTS_KEY]: { ...current, [skill]: { granted, at: Date.now() } } });
}

async function requestJump(to: Jump["to"]): Promise<void> {
  const at = Date.now();
  const jump: Jump = { id: `j-${at}`, to, stage: "requested", at };
  await chrome.storage.local.set({ [JUMP_KEY]: jump });
}

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

function whereIs(jump: Jump | null, kid: string): string {
  if (!jump) return `He is with ${kid}.`;
  if (jump.stage === "arrived") return jump.to === "parent" ? "He is here on your laptop." : `He is with ${kid}.`;
  return jump.to === "parent" ? "He is on his way here." : `He is on his way back to ${kid}.`;
}

function visitLine(jump: Jump | null, now: number): string {
  if (!jump) return "No visits yet";
  if (jump.to === "parent") return jump.stage === "arrived" ? `Here since ${ago(jump.at, now)}` : "On his way here";
  return `Last visit ended ${ago(jump.at, now)}`;
}

function Parent() {
  const [kid, setKid] = useState("your kid");
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [sample, setSample] = useState(false);
  const [grants, setGrants] = useState<Grants>({});
  const [jump, setJump] = useState<Jump | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  /** The room card a click on the map just pointed at; it flashes gold for a moment. */
  const [flash, setFlash] = useState<{ id: string; at: number } | null>(null);
  /** Counts the notes he has brought; a new one remounts the scroll so it flashes gold. */
  const [notes, setNotes] = useState(0);
  const lastSummary = useRef<string | null>(null);
  useEffect(() => {
    if (summary && summary !== lastSummary.current) {
      lastSummary.current = summary;
      setNotes((n) => n + 1);
    }
  }, [summary]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    void getSettings().then((s) => setKid(kidNameFrom(s as unknown as Record<string, unknown>)));
    void chrome.storage.local.get([GRANTS_KEY, JUMP_KEY, GRAPH_KEY]).then((raw) => {
      setGrants((raw[GRANTS_KEY] ?? {}) as Grants);
      const j: Jump | null = isJump(raw[JUMP_KEY]) ? raw[JUMP_KEY] : null;
      setJump(j);
      if (j?.summary) setSummary(j.summary);
      const stored = usableGraph(raw[GRAPH_KEY]);
      const carried = usableGraph(j?.graph);
      if (stored) setGraph(stored);
      else if (carried) {
        setGraph(carried);
        void chrome.storage.local.set({ [GRAPH_KEY]: carried });
      } else {
        setGraph(sampleGraph());
        setSample(true);
      }
    });

    // Another parent window, or the kid's page, may write any of the three keys.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (changes[GRANTS_KEY]) setGrants((changes[GRANTS_KEY].newValue ?? {}) as Grants);
      if (changes[GRAPH_KEY]) {
        const g = usableGraph(changes[GRAPH_KEY].newValue);
        if (g) {
          setGraph(g);
          setSample(false);
        }
      }
      if (changes[JUMP_KEY]) {
        const v: unknown = changes[JUMP_KEY].newValue;
        const j: Jump | null = isJump(v) ? v : null;
        setJump(j);
        if (j?.summary) setSummary(j.summary);
        const carried = usableGraph(j?.graph);
        if (carried) {
          setGraph(carried);
          setSample(false);
          void chrome.storage.local.set({ [GRAPH_KEY]: carried });
        }
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(tick);
    };
  }, []);

  const toggle = (skill: SkillId, granted: boolean) => {
    setGrants((g) => ({ ...g, [skill]: { granted, at: Date.now() } }));
    void writeGrant(skill, granted);
  };

  const jumpToRoom = (id: string) => {
    const el = document.getElementById(`room-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setFlash({ id, at: Date.now() });
  };

  if (!graph) return null;

  const rooms = [...graph.nodes].sort((a, b) => b.state.mastery - a.state.mastery || b.state.lastSeenAt - a.state.lastSeenAt);
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const conceptLabel = (m: Misconception) => labelOf.get(m.concept) ?? m.concept.replace(/-/g, " ");
  const spots = graph.nodes.flatMap((n) => n.misconceptions).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const open = spots.filter((m) => m.status !== "resolved");
  const fixed = spots.filter((m) => m.status === "resolved" && m.resolution);
  const here = jump?.to === "parent" && jump.stage === "arrived";
  const travelling = !!jump && jump.stage !== "arrived";
  const where = whereIs(jump, kid);

  return (
    <main>
      <header className="hero px-frame">
        <div className="px-band">
          <h1>Burrow, parent view</h1>
          <p className="status">
            {visitLine(jump, now)} · {rooms.length} {rooms.length === 1 ? "thing" : "things"} taught
          </p>
        </div>
        <p className="intro plain">
          The rabbit only knows what {kid} teaches him. This page shows what stuck, where he is shaky, and what he is allowed to do.
          {sample && " These rooms are a sample until he brings his own."}
        </p>
      </header>

      <section aria-labelledby="map-h">
        <h2 id="map-h">Map of the burrow</h2>
        <p className="lede plain">
          One room for each thing he learned, bigger the more it came up. Brown tunnels run from what he needed first to what came next. Teal ones join rooms that go together. Drag a room to move it, rest on one for the details, click one to find its card.
        </p>
        <Graph graph={graph} onPick={jumpToRoom} />
      </section>

      <section aria-labelledby="rooms-h">
        <h2 id="rooms-h">What {kid} taught the rabbit</h2>
        <p className="lede plain">Strongest first. He forgets on a schedule, so a faded room is one {kid} will teach him again.</p>
        <div className="rooms">
          {rooms.map((n) => {
            const faded = n.state.mastery < FORGOTTEN;
            const pct = Math.round(n.state.mastery * 100);
            return (
              <article key={n.id} id={`room-${n.id}`} className={`room px-frame${faded ? " faded" : ""}${flash?.id === n.id ? " flash" : ""}`}>
                <div className="room-top">
                  <span className="door" aria-hidden="true" />
                  <h3>{n.label}</h3>
                  {faded && <span className="tag">forgotten</span>}
                </div>
                <div className="bar" role="img" aria-label={`${pct} percent held`}>
                  <span style={{ width: Math.round(n.state.mastery * BAR_STEPS) * 3 }} />
                </div>
                <p className="meta plain">
                  Came up {times(Math.max(1, n.state.exposures + n.state.asks))}
                  <br />
                  Last seen {ago(n.state.lastSeenAt, now)}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="shaky-h">
        <h2 id="shaky-h">Shaky spots</h2>
        <p className="lede plain">Ideas that did not come out quite right. Each one has a question you can ask at dinner.</p>
        {open.length === 0 && fixed.length === 0 && <p className="plain k">Nothing shaky right now.</p>}
        <div className="spots">
          {open.map((m) => {
            const c = conceptLabel(m);
            return (
              <article key={m.id} className="spot px-frame">
                <h3>
                  {c}
                  {m.status === "recurring" && <span className="tag">came back</span>}
                </h3>
                <p className="plain">
                  <span className="k">Thinks: </span>
                  {m.belief}
                </p>
                {m.evidence && (
                  <p className="plain">
                    <span className="k">How we know: </span>
                    {m.evidence}
                  </p>
                )}
                <p className="plain ask">
                  Ask them at dinner: is it true that "{m.belief}"? What makes you sure?
                </p>
                <p className="meta plain">
                  Came up {times(m.occurrences)}, last {ago(m.lastSeenAt, now)}
                </p>
              </article>
            );
          })}
          {fixed.map((m) => (
            <article key={m.id} className="spot resolved px-frame">
              <p className="plain">
                <b>{conceptLabel(m)}</b>: used to think "{m.belief}". Fixed {ago(m.resolution!.at, now)}: {m.resolution!.note}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="skills-h">
        <h2 id="skills-h">What the rabbit may do</h2>
        <p className="lede plain">Each one stays off until you say yes. Turning one on, the rabbit celebrates on {kid}'s page. Turning one off is quiet.</p>
        <div className="skills">
          {SKILLS.map((s) => (
            <label key={s.id} className="skill px-frame px-toggle">
              <input type="checkbox" name={s.id} checked={grants[s.id]?.granted ?? false} onChange={(e) => toggle(s.id, e.target.checked)} />
              <span>
                <strong>{s.title}</strong>
                <span className="blurb plain">{s.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="rabbit-h">
        <h2 id="rabbit-h">The rabbit</h2>
        <p className="lede plain">
          {travelling ? where.replace(/\.$/, "") : where}
          {travelling && (
            <span className="dots" aria-hidden="true">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          )}
        </p>
        <div className="row">
          <button className="px-btn primary" disabled={here} onClick={() => void requestJump("parent")}>
            Call the rabbit here
          </button>
          <button className="px-btn" disabled={!here} onClick={() => void requestJump("kid")}>
            Send him back
          </button>
        </div>
        <div key={notes} className={`summary notes px-frame plain${notes > 0 ? " flash" : ""}`}>
          <span className="k">What he brought back</span>
          {summary ?? `Nothing yet. Call him over and he will tell you what ${kid} taught him today.`}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Parent />);
mountCompanion();
