import { KnowledgeGraph, type GraphSnapshot, type GraphStore } from "@shared/graph";
import { applyExtraction } from "@shared/concepts";
import type { GraphEvent } from "../shared/messages";
import { log } from "../shared/logger";

const logger = log("bg");

/** Canonical graph is bounded before every save so chrome.storage stays well under quota. */
const MAX_NODES = 2000;
const SAVE_DEBOUNCE_MS = 1500;

/**
 * Single writer for the persisted learner graph. Tabs forward {@link GraphEvent}s; this replays
 * them onto the canonical graph (hydrated lazily, so a restarted service worker picks up where it
 * left off) and persists debounced. Pure apart from the injected store, so it unit-tests in node.
 */
export class GraphHost {
  private graph: KnowledgeGraph | null = null;
  private loading: Promise<KnowledgeGraph> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(
    private store: GraphStore,
    private saveDebounceMs: number = SAVE_DEBOUNCE_MS,
  ) {}

  private async ensureLoaded(): Promise<KnowledgeGraph> {
    if (this.graph) return this.graph;
    if (!this.loading) {
      this.loading = this.store
        .load()
        .catch((e) => {
          logger.warn("graph load failed; starting empty", { error: String(e) });
          return null;
        })
        .then((snap) => {
          this.graph = KnowledgeGraph.fromJSON(snap);
          logger.info("graph hydrated", { nodes: this.graph.size });
          return this.graph;
        });
    }
    return this.loading;
  }

  async snapshot(): Promise<GraphSnapshot> {
    const g = await this.ensureLoaded();
    return g.toJSON();
  }

  async apply(event: GraphEvent): Promise<void> {
    const g = await this.ensureLoaded();
    if (event.kind === "extraction") {
      applyExtraction(g, event.extraction, event.ctx, event.at);
    } else {
      const resolved = g.resolveMisconception(event.concept, event.belief, event.at, event.resolution);
      if (!resolved) logger.warn("resolve event for unknown misconception; dropped", { concept: event.concept });
    }
    this.dirty = true;
    this.scheduleSave();
  }

  async clear(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.graph = new KnowledgeGraph();
    this.loading = Promise.resolve(this.graph);
    await this.store.save(this.graph.toJSON());
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), this.saveDebounceMs);
  }

  /** Persist now if there are unsaved changes. Safe to call anytime. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty || !this.graph) return;
    this.dirty = false;
    const pruned = this.graph.prune(MAX_NODES);
    if (pruned) logger.info("graph pruned", { dropped: pruned });
    try {
      await this.store.save(this.graph.toJSON());
    } catch (e) {
      this.dirty = true; // try again on the next event
      logger.warn("graph save failed", { error: String(e) });
    }
  }
}
