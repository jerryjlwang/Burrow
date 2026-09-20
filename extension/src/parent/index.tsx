import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeGraph, type GraphSnapshot, type Misconception } from "@shared/graph";
import { mountCompanion } from "../content/mount";
import { getSettings } from "../shared/settings";
import { GRANTS_KEY, GRAPH_KEY, JUMP_KEY, SKILLS, ago, isGraph, isJump, completionLine, learningNotes, provenanceLine, sampleGraph, type Grants, type Jump, type SkillId } from "./data";

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

  if (!graph) return null;

  const rooms = [...graph.nodes].sort((a, b) => b.state.mastery - a.state.mastery || b.state.lastSeenAt - a.state.lastSeenAt);
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const conceptLabel = (m: Misconception) => labelOf.get(m.concept) ?? m.concept.replace(/-/g, " ");
  const spots = graph.nodes.flatMap((n) => n.misconceptions).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const open = spots.filter((m) => m.status !== "resolved");
  const fixed = spots.filter((m) => m.status === "resolved" && m.resolution);
  const here = jump?.to === "parent" && jump.stage === "arrived";
  const notes = learningNotes(graph, kid, now);
  // Through the graph's tolerant parser, so a stale or half-written carried snapshot can't throw here.
  const plans = KnowledgeGraph.fromJSON(graph).profile.plans.sort((a, b) => b.updatedAt - a.updatedAt);
  const topicPlans = plans.filter((p) => p.kind !== "problem");
  const problemPlans = plans.filter((p) => p.kind === "problem");

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

      <section aria-labelledby="rooms-h">
        <h2 id="rooms-h">What {kid} taught the rabbit</h2>
        <p className="lede plain">Strongest first. He forgets on a schedule, so a faded room is one {kid} will teach him again.</p>
        <div className="rooms">
          {rooms.map((n) => {
            const faded = n.state.mastery < FORGOTTEN;
            const pct = Math.round(n.state.mastery * 100);
            return (
              <article key={n.id} className={`room px-frame${faded ? " faded" : ""}`}>
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
                  Ask them: why is {c.toLowerCase()} not "{m.belief}"?
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

      {topicPlans.length > 0 && (
        <section aria-labelledby="plans-h">
          <h2 id="plans-h">Learning plans</h2>
          <p className="lede plain">Things {kid} asked to learn about. The rabbit mapped each one out and takes {kid} to a lesson or video for every step. A step only counts as done when something showed it.</p>
          <div className="spots">
            {topicPlans.map((p) => {
              const next = p.steps.findIndex((s) => !s.done);
              return (
                <article key={p.key} className="spot px-frame">
                  <h3>
                    {p.goal}
                    <span className="tag">{next < 0 ? "finished" : `${p.steps.filter((s) => s.done).length} of ${p.steps.length}`}</span>
                  </h3>
                  <p className="meta plain">{provenanceLine(p, kid, now)}</p>
                  {p.steps.map((s, i) => (
                    <p key={s.title} className="plain">
                      <span className="k">{s.done ? "Done: " : i === next ? "Next: " : "Later: "}</span>
                      {s.title}
                      {s.completion && <span className="k"> ({completionLine(s.completion, now)})</span>}
                    </p>
                  ))}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {problemPlans.length > 0 && (
        <section aria-labelledby="problems-h">
          <h2 id="problems-h">Problems worked through</h2>
          <p className="lede plain">Problems {kid} actually worked on, and how far each one got. Coming back to one picks up where it stopped.</p>
          <div className="spots">
            {problemPlans.slice(0, 8).map((p) => {
              const stuck = [...p.history].reverse().find((e) => e.type === "wrong_step");
              return (
                <article key={p.key} className={`spot px-frame${p.solvedAt ? " resolved" : ""}`}>
                  <p className="plain">
                    <b>{p.goal}</b>
                    <span className="k"> · {p.solvedAt ? `solved ${ago(p.solvedAt, now)}` : `${p.steps.filter((s) => s.done).length} of ${p.steps.length} steps`}</span>
                  </p>
                  <p className="meta plain">
                    {provenanceLine(p, kid, now)}
                    {!p.solvedAt && stuck ? ` · got stuck at line ${stuck.step} of the working` : ""}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {notes.length > 0 && (
        <section aria-labelledby="learns-h">
          <h2 id="learns-h">How {kid} learns</h2>
          <p className="lede plain">Patterns across days, not just today. The rabbit uses these to decide what to suggest next.</p>
          <div className="spots">
            {notes.map((n) => (
              <article key={n.title} className="spot px-frame">
                <h3>{n.title}</h3>
                <p className="plain">{n.body}</p>
              </article>
            ))}
          </div>
        </section>
      )}

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
        <p className="lede plain">{whereIs(jump, kid)}</p>
        <div className="row">
          <button className="px-btn primary" disabled={here} onClick={() => void requestJump("parent")}>
            Call the rabbit here
          </button>
          <button className="px-btn" disabled={!here} onClick={() => void requestJump("kid")}>
            Send him back
          </button>
        </div>
        <div className="summary px-frame plain">
          <span className="k">What he brought back</span>
          {summary ?? `Nothing yet. Call him over and he will tell you what ${kid} taught him today.`}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Parent />);
mountCompanion();
