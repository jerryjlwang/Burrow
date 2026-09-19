import type { Rect } from "@shared/types";
import { store, type HighlightBox } from "../content/store";
import { ElementRegistry } from "../page-understanding/registry";
import { log } from "../shared/logger";

const logger = log("action");

export interface HighlightOptions {
  durationMs?: number;
  spotlight?: boolean;
  kind?: HighlightBox["kind"];
  label?: string;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function isInViewport(r: Rect, margin = 8): boolean {
  return r.y >= margin && r.y + r.height <= window.innerHeight - margin && r.x >= -margin && r.x + r.width <= window.innerWidth + margin;
}

/**
 * Visual guidance subsystem: highlight rings, spotlight and the pointer beam from the
 * character to a target. Positions are recomputed each frame while active so scrolling,
 * resizing and layout shifts stay accurate. The overlay never captures pointer events.
 */
export class OverlayController {
  private registry: ElementRegistry;
  private active = new Map<number, { options: Required<Pick<HighlightOptions, "spotlight" | "kind">> & { label?: string }; expiresAt: number }>();
  private pointerId: number | null = null;
  private raf: number | null = null;
  /** Provided by the character component: where the character currently is (viewport coords). */
  characterAnchor: () => { x: number; y: number } = () => ({ x: window.innerWidth - 60, y: window.innerHeight - 60 });

  constructor(registry: ElementRegistry) {
    this.registry = registry;
  }

  async scrollIntoViewIfNeeded(el: Element): Promise<boolean> {
    const r = rectOf(el);
    if (isInViewport(r)) return false;
    try {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: store.getState().reducedMotion ? "auto" : "smooth" });
    } catch {
      el.scrollIntoView();
    }
    await new Promise((res) => setTimeout(res, store.getState().reducedMotion ? 60 : 420));
    return true;
  }

  highlight(id: number, options: HighlightOptions = {}): boolean {
    const el = this.registry.get(id);
    if (!el) {
      logger.warn("highlight: element missing", { id });
      return false;
    }
    const durationMs = options.durationMs ?? 8000;
    this.active.set(id, { options: { spotlight: !!options.spotlight, kind: options.kind ?? "highlight", label: options.label }, expiresAt: Date.now() + durationMs });
    this.ensureLoop();
    return true;
  }

  /** Points the character toward an element: scrolls it into view if needed, highlights it and draws the beam. */
  async pointAt(id: number, options: HighlightOptions = {}): Promise<boolean> {
    const el = this.registry.get(id);
    if (!el) return false;
    await this.scrollIntoViewIfNeeded(el);
    this.clear();
    this.highlight(id, { durationMs: options.durationMs ?? 12000, spotlight: options.spotlight, kind: "point", label: options.label });
    this.pointerId = id;
    const r = rectOf(el);
    store.setState({ lookAt: { x: r.x + r.width / 2, y: r.y + r.height / 2 } });
    this.ensureLoop();
    return true;
  }

  clear(): void {
    this.active.clear();
    this.pointerId = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    store.setState({ highlights: [], pointer: null, lookAt: null });
  }

  get hasPointer(): boolean {
    return this.pointerId !== null;
  }

  private ensureLoop(): void {
    if (this.raf !== null) return;
    const tick = () => {
      this.raf = null;
      const now = Date.now();
      const boxes: HighlightBox[] = [];
      for (const [id, entry] of this.active) {
        const el = this.registry.get(id);
        if (!el || now > entry.expiresAt) {
          this.active.delete(id);
          if (this.pointerId === id) this.pointerId = null;
          continue;
        }
        const r = rectOf(el);
        if (r.width === 0 && r.height === 0) {
          this.active.delete(id);
          if (this.pointerId === id) this.pointerId = null;
          continue;
        }
        boxes.push({ id, rect: r, kind: entry.options.kind, spotlight: entry.options.spotlight, label: entry.options.label, expiresAt: entry.expiresAt });
      }
      let pointer: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
      let lookAt: { x: number; y: number } | null = null;
      if (this.pointerId !== null) {
        const target = boxes.find((b) => b.id === this.pointerId);
        if (target) {
          const from = this.characterAnchor();
          const cx = target.rect.x + target.rect.width / 2;
          const cy = target.rect.y + target.rect.height / 2;
          // Beam ends at the edge of the target box closest to the character.
          const dx = from.x - cx;
          const dy = from.y - cy;
          const halfW = target.rect.width / 2 + 10;
          const halfH = target.rect.height / 2 + 10;
          const scale = Math.min(Math.abs(dx) > 0.01 ? halfW / Math.abs(dx) : Infinity, Math.abs(dy) > 0.01 ? halfH / Math.abs(dy) : Infinity, 1);
          pointer = { from, to: { x: cx + dx * scale, y: cy + dy * scale } };
          lookAt = { x: cx, y: cy };
        }
      }
      const prev = store.getState();
      const same =
        prev.highlights.length === boxes.length &&
        prev.highlights.every((b, i) => b.id === boxes[i].id && b.rect.x === boxes[i].rect.x && b.rect.y === boxes[i].rect.y && b.rect.width === boxes[i].rect.width && b.rect.height === boxes[i].rect.height) &&
        JSON.stringify(prev.pointer) === JSON.stringify(pointer);
      if (!same) store.setState({ highlights: boxes, pointer, lookAt: lookAt ?? (pointer ? prev.lookAt : null) });
      if (this.active.size > 0) this.raf = requestAnimationFrame(tick);
      else if (prev.highlights.length || prev.pointer) store.setState({ highlights: [], pointer: null, lookAt: null });
    };
    this.raf = requestAnimationFrame(tick);
  }
}
