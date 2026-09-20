import { describe, it, expect } from "vitest";
import { GraphHost } from "./graph-host";
import { KnowledgeGraph, type GraphSnapshot, type GraphStore } from "@shared/graph";
import type { ConceptExtraction } from "@shared/concepts";

const T0 = 1_700_000_000_000;

class FakeStore implements GraphStore {
  saved: GraphSnapshot | null = null;
  saves = 0;
  failNextSave = false;
  constructor(public initial: GraphSnapshot | null = null) {}
  async load(): Promise<GraphSnapshot | null> {
    return this.initial;
  }
  async save(snapshot: GraphSnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("quota");
    }
    this.saved = snapshot;
    this.saves++;
  }
}

const BELIEF = "summer happens because Earth is closer to the sun";

const extraction: ConceptExtraction = {
  concepts: [{ label: "Seasons", salience: 0.9 }],
  edges: [{ from: "Axial tilt", to: "Seasons", type: "prerequisite", weight: 0.9 }],
  misconceptions: [{ concept: "Seasons", belief: BELIEF, evidence: "why is summer hot sun closer" }],
};

const extractionEvent = { kind: "extraction" as const, extraction, ctx: { url: "u", title: "t", kind: "page" as const }, at: T0 };

describe("GraphHost", () => {
  it("applies an extraction event and persists it on flush", async () => {
    const store = new FakeStore();
    const host = new GraphHost(store, 60_000);
    await host.apply(extractionEvent);
    await host.flush();
    const g = KnowledgeGraph.fromJSON(store.saved);
    expect(g.get("seasons")!.state.exposures).toBe(1);
    expect(g.unseenPrerequisites("seasons").map((n) => n.id)).toEqual(["axial-tilt"]);
    expect(g.activeMisconceptions()).toHaveLength(1);
  });

  it("hydrates from a prior snapshot so events accumulate across service-worker restarts", async () => {
    const store = new FakeStore();
    const first = new GraphHost(store, 60_000);
    await first.apply(extractionEvent);
    await first.flush();
    // New host = restarted service worker, same persisted state.
    const store2 = new FakeStore(store.saved);
    const second = new GraphHost(store2, 60_000);
    await second.apply({ ...extractionEvent, at: T0 + 1000 });
    await second.flush();
    const g = KnowledgeGraph.fromJSON(store2.saved);
    expect(g.get("seasons")!.state.exposures).toBe(2);
  });

  it("applies a resolve event; a later recurrence flips to recurring with the callback intact", async () => {
    const store = new FakeStore();
    const host = new GraphHost(store, 60_000);
    await host.apply(extractionEvent);
    await host.apply({ kind: "resolve", concept: "Seasons", belief: BELIEF, at: T0 + 5000, resolution: { method: "self", note: "Australia clue" } });
    await host.apply({ ...extractionEvent, at: T0 + 86_400_000 }); // next day, same belief
    await host.flush();
    const g = KnowledgeGraph.fromJSON(store.saved);
    const m = g.get("seasons")!.misconceptions[0]!;
    expect(m.status).toBe("recurring");
    expect(m.resolution?.note).toBe("Australia clue");
  });

  it("drops a resolve event for an unknown misconception without crashing", async () => {
    const store = new FakeStore();
    const host = new GraphHost(store, 60_000);
    await host.apply({ kind: "resolve", concept: "Nope", belief: "never seen", at: T0, resolution: { method: "self", note: "x" } });
    await host.flush();
    expect(KnowledgeGraph.fromJSON(store.saved).size).toBe(0);
  });

  it("keeps changes dirty when a save fails and retries on the next flush", async () => {
    const store = new FakeStore();
    const host = new GraphHost(store, 60_000);
    await host.apply(extractionEvent);
    store.failNextSave = true;
    await host.flush();
    expect(store.saved).toBeNull();
    await host.flush();
    expect(store.saved).not.toBeNull();
    expect(store.saves).toBe(1);
  });

  it("clear resets the canonical graph and persists the empty state", async () => {
    const store = new FakeStore();
    const host = new GraphHost(store, 60_000);
    await host.apply(extractionEvent);
    await host.clear();
    expect(KnowledgeGraph.fromJSON(store.saved).size).toBe(0);
    expect(await host.snapshot().then((s) => s.nodes.length)).toBe(0);
  });

  it("tolerates a corrupt stored blob by starting empty", async () => {
    const store = new FakeStore({ garbage: true } as unknown as GraphSnapshot);
    const host = new GraphHost(store, 60_000);
    const snap = await host.snapshot();
    expect(snap.nodes).toEqual([]);
  });
});
