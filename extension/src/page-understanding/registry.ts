/**
 * Maps the agent's temporary element ids to real DOM nodes.
 * Ids are stable for the lifetime of a node (WeakMap), so "click it" keeps working
 * across rescans as long as the node is still attached.
 */
export class ElementRegistry {
  private byId = new Map<number, WeakRef<Element>>();
  private ids = new WeakMap<Element, number>();
  private next = 1;

  idFor(el: Element): number {
    const existing = this.ids.get(el);
    if (existing !== undefined) {
      if (!this.byId.has(existing)) this.byId.set(existing, new WeakRef(el));
      return existing;
    }
    const id = this.next++;
    this.ids.set(el, id);
    this.byId.set(id, new WeakRef(el));
    return id;
  }

  get(id: number): Element | null {
    const ref = this.byId.get(id);
    const el = ref?.deref();
    if (!el || !el.isConnected) {
      if (ref) this.byId.delete(id);
      return null;
    }
    return el;
  }

  has(el: Element): boolean {
    return this.ids.has(el);
  }

  /** Drops references to nodes that left the document. */
  prune(): void {
    for (const [id, ref] of this.byId) {
      const el = ref.deref();
      if (!el || !el.isConnected) this.byId.delete(id);
    }
  }

  get size(): number {
    return this.byId.size;
  }
}
